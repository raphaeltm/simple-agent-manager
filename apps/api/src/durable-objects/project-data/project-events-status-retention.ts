import type {
  GetProjectEventRecentStatusInput,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventStorageAccountingRecord,
} from '@simple-agent-manager/shared';

import type { RunProjectEventRetentionInput } from './project-events-contracts';
import { ProjectEventValidationError } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import {
  mapProjectEvent,
  mapProjectEventDeliveryAttempt,
  mapProjectEventDeliveryBatch,
  mapProjectEventMatch,
} from './project-events-mappers';
import { markSchedulerSuccess } from './project-events-materialization';
import {
  assertProjectBinding,
  normalizeListLimit,
  normalizeProjectId,
} from './project-events-normalization';
import {
  accountingFor,
  chunkIdsForBindBudget,
  deleteRowsByIds,
  readAccounting,
  readRecentRows,
} from './project-events-storage-helpers';
import { normalizeTimestamp } from './project-events-values';
import type { Env } from './types';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const TERMINAL_BATCH_STATES_SQL =
  "'recorded_not_injected', 'delivered', 'acked', 'failed', 'ambiguous', 'expired', 'cancelled'";
const TERMINAL_MATCH_STATES_SQL = "'recorded_not_injected', 'expired', 'cancelled'";
const RETENTION_SAFE_BATCH_PREDICATE = `(
  COALESCE(ack_required, 0) = 0
  OR acked_at IS NOT NULL
  OR state IN ('acked', 'failed', 'ambiguous', 'expired', 'cancelled')
)`;
const RETENTION_SAFE_MATCH_BATCH_PREDICATE = `(
  COALESCE(b.ack_required, 0) = 0
  OR b.acked_at IS NOT NULL
  OR b.state IN ('acked', 'failed', 'ambiguous', 'expired', 'cancelled')
)`;
const ORPHAN_REPAIR_REASON = 'retention_orphan_batch_repaired';

export function getProjectEventRecentStatus(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: GetProjectEventRecentStatusInput
): ProjectEventRecentStatus {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  expireDueSubscriptionsWithinBudget(sql, projectId, Date.now(), limits.retentionBatchRows);
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
      : normalizeRetentionLimit(input.limit);
  const batchLimit = Math.min(requestedLimit, limits.retentionBatchRows);
  const cutoff = now - limits.retentionDays * MILLISECONDS_PER_DAY;
  let remaining = batchLimit;
  let hasMore = false;

  const expired = expireDueSubscriptionsWithinBudget(sql, projectId, now, remaining);
  remaining -= expired.mutated;
  hasMore ||= expired.hasMore;

  const repaired = repairOrphanMatches(sql, projectId, now, remaining);
  remaining -= repaired.mutated;
  hasMore ||= repaired.hasMore;

  const deletedAttempts = deleteEligibleAttempts(sql, projectId, cutoff, remaining);
  remaining -= deletedAttempts.mutated;
  hasMore ||= deletedAttempts.hasMore;

  const deletedMatches = deleteEligibleMatches(sql, projectId, cutoff, remaining);
  remaining -= deletedMatches.mutated;
  hasMore ||= deletedMatches.hasMore;

  const deletedBatches = deleteEligibleBatches(sql, projectId, cutoff, remaining);
  remaining -= deletedBatches.mutated;
  hasMore ||= deletedBatches.hasMore;

  const deletedEvents = deleteEligibleEvents(sql, projectId, cutoff, remaining);
  remaining -= deletedEvents.mutated;
  hasMore ||= deletedEvents.hasMore;

  const accounting =
    input.refreshAccounting === false
      ? readAccounting(sql, projectId)
      : refreshProjectEventStorageAccounting(sql, projectId, now);
  const nextRetentionAt = hasMore
    ? now + limits.retentionMinAlarmDelayMs
    : now + limits.retentionIntervalMs;
  markSchedulerSuccess(sql, projectId, now, 'retention', nextRetentionAt);
  return {
    deletedEvents: deletedEvents.mutated,
    deletedMatches: deletedMatches.mutated,
    deletedBatches: deletedBatches.mutated,
    deletedAttempts: deletedAttempts.mutated,
    expiredSubscriptions: expired.mutated,
    repairedOrphanMatches: repaired.mutated,
    hasMore,
    accounting,
  };
}

type BudgetedMutation = { mutated: number; hasMore: boolean };

function takeBudgetedIds(
  sql: SqlStorage,
  query: string,
  params: unknown[],
  budget: number
): { ids: string[]; hasMore: boolean } {
  if (budget <= 0) {
    const rows = sql.exec(query, ...params, 1).toArray();
    return { ids: [], hasMore: rows.some((row) => typeof row.id === 'string') };
  }
  const rows = sql.exec(query, ...params, budget + 1).toArray();
  const ids = rows
    .filter((row): row is { id: string } => typeof row.id === 'string')
    .map((row) => row.id);
  return { ids: ids.slice(0, budget), hasMore: ids.length > budget };
}

function normalizeRetentionLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ProjectEventValidationError('limit must be an integer >= 1');
  }
  return limit;
}

function expireDueSubscriptionsWithinBudget(
  sql: SqlStorage,
  projectId: string,
  now: number,
  budget: number
): BudgetedMutation {
  const selected = takeBudgetedIds(
    sql,
    `SELECT id FROM project_event_subscriptions
     WHERE project_id = ?
       AND lifecycle_state = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= ?
     ORDER BY expires_at ASC, id
     LIMIT ?`,
    [projectId, now],
    budget
  );
  if (selected.ids.length === 0) return { mutated: 0, hasMore: selected.hasMore };
  for (const chunk of chunkIdsForBindBudget(selected.ids, 2)) {
    const placeholders = chunk.map(() => '?').join(', ');
    sql.exec(
      `UPDATE project_event_subscriptions
       SET lifecycle_state = 'expired', updated_at = ?
       WHERE project_id = ? AND id IN (${placeholders})`,
      now,
      projectId,
      ...chunk
    );
  }
  for (const chunk of chunkIdsForBindBudget(selected.ids, 3)) {
    const placeholders = chunk.map(() => '?').join(', ');
    sql.exec(
      `UPDATE project_event_matches
       SET state = 'expired', lifecycle_checked_at = ?, reason = ?
       WHERE project_id = ?
         AND subscription_id IN (${placeholders})
         AND batch_id IS NULL
         AND state = 'matched'`,
      now,
      'subscription expired',
      projectId,
      ...chunk
    );
  }
  return { mutated: selected.ids.length, hasMore: selected.hasMore };
}

function repairOrphanMatches(
  sql: SqlStorage,
  projectId: string,
  now: number,
  budget: number
): BudgetedMutation {
  const selected = takeBudgetedIds(
    sql,
    `SELECT m.id AS id
     FROM project_event_matches m
     WHERE m.project_id = ?
       AND m.state = 'batch_created'
       AND m.batch_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM project_event_delivery_batches b
         WHERE b.project_id = m.project_id AND b.id = m.batch_id
       )
     ORDER BY m.lifecycle_checked_at ASC, m.id
     LIMIT ?`,
    [projectId],
    budget
  );
  if (selected.ids.length === 0) return { mutated: 0, hasMore: selected.hasMore };
  let mutated = 0;
  for (const chunk of chunkIdsForBindBudget(selected.ids, 5)) {
    const placeholders = chunk.map(() => '?').join(', ');
    mutated += sql.exec(
      `UPDATE project_event_matches
       SET state = 'expired',
           matched_at = CASE WHEN matched_at > ? THEN ? ELSE matched_at END,
           lifecycle_checked_at = ?,
           reason = ?
       WHERE project_id = ?
         AND id IN (${placeholders})
         AND state = 'batch_created'
         AND batch_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM project_event_delivery_batches b
           WHERE b.project_id = project_event_matches.project_id
             AND b.id = project_event_matches.batch_id
         )`,
      now,
      now,
      now,
      ORPHAN_REPAIR_REASON,
      projectId,
      ...chunk
    ).rowsWritten;
  }
  return { mutated, hasMore: selected.hasMore || mutated < selected.ids.length };
}

function deleteEligibleAttempts(
  sql: SqlStorage,
  projectId: string,
  cutoff: number,
  budget: number
): BudgetedMutation {
  const selected = takeBudgetedIds(
    sql,
    `SELECT id FROM project_event_delivery_attempts
     WHERE project_id = ?
       AND created_at < ?
       AND state IN ('recorded_not_injected', 'accepted', 'failed', 'ambiguous')
     ORDER BY created_at ASC, id
     LIMIT ?`,
    [projectId, cutoff],
    budget
  );
  return {
    mutated: deleteRowsByIds(sql, 'project_event_delivery_attempts', projectId, selected.ids),
    hasMore: selected.hasMore,
  };
}

function deleteEligibleMatches(
  sql: SqlStorage,
  projectId: string,
  cutoff: number,
  budget: number
): BudgetedMutation {
  const selected = takeBudgetedIds(
    sql,
    `SELECT m.id AS id
     FROM project_event_matches m
     LEFT JOIN project_event_delivery_batches b ON b.project_id = m.project_id AND b.id = m.batch_id
     WHERE m.project_id = ?
       AND (
         (m.batch_id IS NULL AND m.matched_at < ? AND m.state IN (${TERMINAL_MATCH_STATES_SQL}))
         OR (
           m.batch_id IS NOT NULL
           AND b.id IS NOT NULL
           AND b.updated_at < ?
           AND b.state IN (${TERMINAL_BATCH_STATES_SQL})
           AND ${RETENTION_SAFE_MATCH_BATCH_PREDICATE}
         )
       )
     ORDER BY COALESCE(b.updated_at, m.matched_at) ASC, m.id
     LIMIT ?`,
    [projectId, cutoff, cutoff],
    budget
  );
  return {
    mutated: deleteRowsByIds(sql, 'project_event_matches', projectId, selected.ids),
    hasMore: selected.hasMore,
  };
}

function deleteEligibleBatches(
  sql: SqlStorage,
  projectId: string,
  cutoff: number,
  budget: number
): BudgetedMutation {
  const selected = takeBudgetedIds(
    sql,
    `SELECT b.id AS id
     FROM project_event_delivery_batches b
     WHERE b.project_id = ?
       AND b.updated_at < ?
       AND b.state IN (${TERMINAL_BATCH_STATES_SQL})
       AND ${RETENTION_SAFE_BATCH_PREDICATE}
       AND NOT EXISTS (
         SELECT 1 FROM project_event_matches m
         WHERE m.project_id = b.project_id AND m.batch_id = b.id
       )
     ORDER BY b.updated_at ASC, b.id
     LIMIT ?`,
    [projectId, cutoff],
    budget
  );
  return {
    mutated: deleteRowsByIds(sql, 'project_event_delivery_batches', projectId, selected.ids),
    hasMore: selected.hasMore,
  };
}

function deleteEligibleEvents(
  sql: SqlStorage,
  projectId: string,
  cutoff: number,
  budget: number
): BudgetedMutation {
  const selected = takeBudgetedIds(
    sql,
    `SELECT e.id AS id FROM project_events e
     WHERE e.project_id = ?
       AND e.received_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM project_event_matches m
         WHERE m.project_id = ? AND m.event_id = e.id
       )
     ORDER BY e.received_at ASC, e.id
     LIMIT ?`,
    [projectId, cutoff, projectId],
    budget
  );
  return {
    mutated: deleteRowsByIds(sql, 'project_events', projectId, selected.ids),
    hasMore: selected.hasMore,
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
      'LENGTH(match_ids_json) + COALESCE(LENGTH(terminal_reason), 0) + COALESCE(LENGTH(acked_by_id), 0)',
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
