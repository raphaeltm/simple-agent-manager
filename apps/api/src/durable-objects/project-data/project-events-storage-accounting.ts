import {
  isJsonRecord,
  type ProjectEventStorageAccountingRecord,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { ProjectEventValidationError } from './project-events-contracts';
import { mapProjectEventStorageAccounting } from './project-events-mappers';

const log = createModuleLogger('project_data.project_events.storage_accounting');

export const SQLITE_MAX_BIND_PARAMETERS = 100;

export type ProjectEventTable =
  | 'project_events'
  | 'project_event_subscriptions'
  | 'project_event_subscription_match_keys'
  | 'project_event_matches'
  | 'project_event_delivery_batches'
  | 'project_event_delivery_attempts';

export type ProjectEventTimestampColumn =
  | 'created_at'
  | 'matched_at'
  | 'received_at'
  | 'updated_at';

type IdRow = { id: string };

type AccountingAggregateRow = {
  record_count: number;
  estimated_bytes: number;
  oldest_created_at: number | null;
  newest_created_at: number | null;
};

export type DeleteOldRowsInput = {
  sql: SqlStorage;
  table: ProjectEventTable;
  projectId: string;
  timestampColumn: ProjectEventTimestampColumn;
  cutoff: number;
  limit: number;
  extraWhere?: string;
  extraParams?: unknown[];
};

function isIdRow(input: unknown): input is IdRow {
  return isJsonRecord(input) && typeof input.id === 'string';
}

function isAccountingAggregateRow(input: unknown): input is AccountingAggregateRow {
  return (
    isJsonRecord(input) &&
    typeof input.record_count === 'number' &&
    typeof input.estimated_bytes === 'number' &&
    (typeof input.oldest_created_at === 'number' || input.oldest_created_at === null) &&
    (typeof input.newest_created_at === 'number' || input.newest_created_at === null)
  );
}

function mapStorageRows<T>(
  rows: unknown[],
  mapper: (row: unknown) => T,
  limit: number,
  label: string
): T[] {
  const mapped: T[] = [];
  for (const row of rows.slice(0, limit)) {
    try {
      mapped.push(mapper(row));
    } catch (error) {
      log.warn('row_skipped', { label, error: String(error) });
    }
  }
  return mapped;
}

export function readRecentRows<T>(
  sql: SqlStorage,
  table: ProjectEventTable,
  projectId: string,
  orderColumn: ProjectEventTimestampColumn,
  limit: number,
  mapper: (row: unknown) => T
): { items: T[]; hasMore: boolean } {
  const selectSql = recentRowsSelectSql(table, orderColumn);
  const rows = sql.exec(selectSql, projectId, limit + 1).toArray();
  return { items: mapStorageRows(rows, mapper, limit, table), hasMore: rows.length > limit };
}

export function readAccounting(
  sql: SqlStorage,
  projectId: string
): ProjectEventStorageAccountingRecord[] {
  const rows = sql
    .exec(
      `SELECT * FROM project_event_storage_accounting
       WHERE project_id = ?
       ORDER BY category ASC`,
      projectId
    )
    .toArray();
  return mapStorageRows(rows, mapProjectEventStorageAccounting, rows.length, 'storage_accounting');
}

export function deleteOldRows(input: DeleteOldRowsInput): number {
  const {
    sql,
    table,
    projectId,
    timestampColumn,
    cutoff,
    limit,
    extraWhere = '',
    extraParams = [],
  } = input;
  const selectSql = deleteOldRowsSelectSql(table, timestampColumn, extraWhere);
  const rows = sql.exec(selectSql, projectId, cutoff, ...extraParams, limit).toArray();
  const ids = rows.filter(isIdRow).map((row) => row.id);
  return deleteRowsByIds(sql, table, projectId, ids);
}

export function deleteOldEventsWithoutMatches(
  sql: SqlStorage,
  projectId: string,
  cutoff: number,
  limit: number
): number {
  const rows = sql
    .exec(
      `SELECT e.id FROM project_events e
       WHERE e.project_id = ?
         AND e.received_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM project_event_matches m
           WHERE m.project_id = ? AND m.event_id = e.id
         )
       ORDER BY e.received_at ASC, e.id
       LIMIT ?`,
      projectId,
      cutoff,
      projectId,
      limit
    )
    .toArray();
  const ids = rows.filter(isIdRow).map((row) => row.id);
  return deleteRowsByIds(sql, 'project_events', projectId, ids);
}

export function deleteRowsByIds(
  sql: SqlStorage,
  table: ProjectEventTable,
  projectId: string,
  ids: string[]
): number {
  if (ids.length === 0) return 0;
  for (const chunk of chunkIdsForBindBudget(ids, 1)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const deleteSql = deleteRowsByIdsSql(table, placeholders);
    sql.exec(deleteSql, projectId, ...chunk);
  }
  return ids.length;
}

export function chunkIdsForBindBudget(ids: readonly string[], reservedBinds: number): string[][] {
  const size = SQLITE_MAX_BIND_PARAMETERS - reservedBinds;
  if (size <= 0) throw new ProjectEventValidationError('SQL bind budget is exhausted');
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export function accountingFor(
  sql: SqlStorage,
  projectId: string,
  category: ProjectEventTable,
  timestampColumn: ProjectEventTimestampColumn,
  byteExpression: string,
  measuredAt: number
): ProjectEventStorageAccountingRecord {
  const selectSql = accountingSelectSql(category, timestampColumn, byteExpression);
  const row = sql.exec(selectSql, projectId).toArray()[0];
  const parsed = isAccountingAggregateRow(row)
    ? row
    : {
        record_count: 0,
        estimated_bytes: 0,
        oldest_created_at: null,
        newest_created_at: null,
      };
  return {
    projectId,
    category,
    recordCount: parsed.record_count,
    estimatedBytes: parsed.estimated_bytes,
    oldestCreatedAt: parsed.oldest_created_at,
    newestCreatedAt: parsed.newest_created_at,
    measuredAt,
  };
}

function recentRowsSelectSql(
  table: ProjectEventTable,
  orderColumn: ProjectEventTimestampColumn
): string {
  return `SELECT * FROM ${table}
       WHERE project_id = ?
       ORDER BY ${orderColumn} DESC, id
       LIMIT ?`;
}

function deleteOldRowsSelectSql(
  table: ProjectEventTable,
  timestampColumn: ProjectEventTimestampColumn,
  extraWhere: string
): string {
  return `SELECT id FROM ${table}
       WHERE project_id = ? AND ${timestampColumn} < ? ${extraWhere}
       ORDER BY ${timestampColumn} ASC, id
       LIMIT ?`;
}

function deleteRowsByIdsSql(table: ProjectEventTable, placeholders: string): string {
  return `DELETE FROM ${table}
     WHERE project_id = ? AND id IN (${placeholders})`;
}

function accountingSelectSql(
  category: ProjectEventTable,
  timestampColumn: ProjectEventTimestampColumn,
  byteExpression: string
): string {
  return `SELECT COUNT(*) AS record_count,
              COALESCE(SUM(${byteExpression}), 0) AS estimated_bytes,
              MIN(${timestampColumn}) AS oldest_created_at,
              MAX(${timestampColumn}) AS newest_created_at
       FROM ${category}
       WHERE project_id = ?`;
}
