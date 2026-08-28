import type {
  GetProjectEventRecentStatusInput,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventStorageAccountingRecord,
} from '@simple-agent-manager/shared';

import type { RunProjectEventRetentionInput } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import {
  mapProjectEvent,
  mapProjectEventDeliveryAttempt,
  mapProjectEventDeliveryBatch,
  mapProjectEventMatch,
} from './project-events-mappers';
import {
  assertProjectBinding,
  normalizeListLimit,
  normalizeProjectId,
} from './project-events-normalization';
import {
  accountingFor,
  deleteOldEventsWithoutMatches,
  deleteOldRows,
  expireDueSubscriptions,
  readAccounting,
  readRecentRows,
} from './project-events-storage-helpers';
import { normalizeTimestamp } from './project-events-values';
import type { Env } from './types';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function getProjectEventRecentStatus(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: GetProjectEventRecentStatusInput
): ProjectEventRecentStatus {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  expireDueSubscriptions(sql, projectId, Date.now(), limits.retentionBatchRows);
  const limit = Math.min(
    normalizeListLimit(input.limit ?? limits.recentStatusLimit, limits),
    limits.recentStatusLimit
  );
  const events = readRecentRows(
    sql,
    'project_events',
    projectId,
    'updated_at',
    limit,
    mapProjectEvent
  );
  const matches = readRecentRows(
    sql,
    'project_event_matches',
    projectId,
    'matched_at',
    limit,
    mapProjectEventMatch
  );
  const batches = readRecentRows(
    sql,
    'project_event_delivery_batches',
    projectId,
    'updated_at',
    limit,
    mapProjectEventDeliveryBatch
  );
  const attempts = readRecentRows(
    sql,
    'project_event_delivery_attempts',
    projectId,
    'created_at',
    limit,
    mapProjectEventDeliveryAttempt
  );
  const accounting = readAccounting(sql, projectId);
  return {
    projectId,
    events: events.items,
    matches: matches.items,
    batches: batches.items,
    attempts: attempts.items,
    accounting,
    hasMore: events.hasMore || matches.hasMore || batches.hasMore || attempts.hasMore,
  };
}

export function runProjectEventRetention(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: RunProjectEventRetentionInput
): ProjectEventRetentionResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const now = normalizeTimestamp(input.now ?? Date.now(), 'now');
  const requestedLimit =
    input.limit === null || input.limit === undefined
      ? limits.retentionBatchRows
      : normalizeListLimit(input.limit, limits);
  const batchLimit = Math.min(requestedLimit, limits.retentionBatchRows);
  const cutoff = now - limits.retentionDays * MILLISECONDS_PER_DAY;
  const expiredSubscriptions = expireDueSubscriptions(sql, projectId, now, batchLimit);
  const deletedAttempts = deleteOldRows({
    sql,
    table: 'project_event_delivery_attempts',
    projectId,
    timestampColumn: 'created_at',
    cutoff,
    limit: batchLimit,
    extraWhere: "AND state IN ('recorded_not_injected', 'accepted', 'failed', 'ambiguous')",
  });
  const deletedBatches = deleteOldRows({
    sql,
    table: 'project_event_delivery_batches',
    projectId,
    timestampColumn: 'updated_at',
    cutoff,
    limit: batchLimit,
    extraWhere:
      "AND state IN ('recorded_not_injected', 'acked', 'failed', 'ambiguous', 'expired', 'cancelled')",
  });
  const deletedMatches = deleteOldRows({
    sql,
    table: 'project_event_matches',
    projectId,
    timestampColumn: 'matched_at',
    cutoff,
    limit: batchLimit,
    extraWhere: "AND state IN ('recorded_not_injected', 'expired', 'cancelled')",
  });
  const deletedEvents = deleteOldEventsWithoutMatches(sql, projectId, cutoff, batchLimit);
  const accounting = refreshProjectEventStorageAccounting(sql, projectId, now);
  return {
    deletedEvents,
    deletedMatches,
    deletedBatches,
    deletedAttempts,
    expiredSubscriptions,
    accounting,
  };
}

export function refreshProjectEventStorageAccounting(
  sql: SqlStorage,
  projectId: string,
  measuredAt: number
): ProjectEventStorageAccountingRecord[] {
  const categories = [
    accountingFor(
      sql,
      projectId,
      'project_events',
      'received_at',
      'metadata_bytes + display_bytes + raw_payload_ref_bytes',
      measuredAt
    ),
    accountingFor(
      sql,
      projectId,
      'project_event_subscriptions',
      'created_at',
      'LENGTH(filter_json) + COALESCE(LENGTH(reason), 0)',
      measuredAt
    ),
    accountingFor(
      sql,
      projectId,
      'project_event_subscription_match_keys',
      'created_at',
      'LENGTH(match_key) + LENGTH(field_value)',
      measuredAt
    ),
    accountingFor(
      sql,
      projectId,
      'project_event_matches',
      'matched_at',
      'COALESCE(LENGTH(reason), 0)',
      measuredAt
    ),
    accountingFor(
      sql,
      projectId,
      'project_event_delivery_batches',
      'created_at',
      'LENGTH(match_ids_json) + COALESCE(LENGTH(terminal_reason), 0)',
      measuredAt
    ),
    accountingFor(
      sql,
      projectId,
      'project_event_delivery_attempts',
      'created_at',
      'COALESCE(LENGTH(error_message), 0) + COALESCE(LENGTH(receipt_id), 0)',
      measuredAt
    ),
  ];
  for (const record of categories) {
    sql.exec(
      `INSERT INTO project_event_storage_accounting
       (project_id, category, record_count, estimated_bytes, oldest_created_at, newest_created_at, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, category) DO UPDATE SET
         record_count = excluded.record_count,
         estimated_bytes = excluded.estimated_bytes,
         oldest_created_at = excluded.oldest_created_at,
         newest_created_at = excluded.newest_created_at,
         measured_at = excluded.measured_at`,
      projectId,
      record.category,
      record.recordCount,
      record.estimatedBytes,
      record.oldestCreatedAt,
      record.newestCreatedAt,
      measuredAt
    );
  }
  return readAccounting(sql, projectId);
}
