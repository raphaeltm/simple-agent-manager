import {
  isJsonRecord,
  PROJECT_EVENT_DELIVERY_ATTEMPT_STATES,
  PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES,
  type ProjectEventDeliveryAttemptRecord,
  type ProjectEventDeliveryAttemptState,
  type ProjectEventDeliveryBatchRecord,
  type ProjectEventLimits,
  type ProjectEventMatchRecord,
  type ProjectEventRecord,
  type ProjectEventStorageAccountingRecord,
  type ProjectEventSubscriptionOwner,
  type ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import {
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from './project-events-contracts';
import {
  mapProjectEvent,
  mapProjectEventDeliveryAttempt,
  mapProjectEventDeliveryBatch,
  mapProjectEventMatch,
  mapProjectEventStorageAccounting,
  mapProjectEventSubscription,
} from './project-events-mappers';
import { filterMatchesProjectEvent, projectEventKeys } from './project-events-normalization';
import { normalizeNullableText, normalizeText } from './project-events-values';
import { generateId } from './types';

const log = createModuleLogger('project_data.project_events.storage');
const OWNER_TYPE_SET = new Set<string>(PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES);
const ATTEMPT_STATE_SET = new Set<string>(PROJECT_EVENT_DELIVERY_ATTEMPT_STATES);

type ProjectEventTable =
  | 'project_events'
  | 'project_event_subscriptions'
  | 'project_event_subscription_match_keys'
  | 'project_event_matches'
  | 'project_event_delivery_batches'
  | 'project_event_delivery_attempts';

type FingerprintRow = { idempotency_fingerprint: string };
type CountRow = { cnt: number };
type IdRow = { id: string };
type AccountingAggregateRow = {
  record_count: number;
  estimated_bytes: number;
  oldest_created_at: number | null;
  newest_created_at: number | null;
};

function isFingerprintRow(input: unknown): input is FingerprintRow {
  return isJsonRecord(input) && typeof input.idempotency_fingerprint === 'string';
}

function isCountRow(input: unknown): input is CountRow {
  return isJsonRecord(input) && typeof input.cnt === 'number';
}

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

export function readEventById(
  sql: SqlStorage,
  projectId: string,
  eventId: string
): ProjectEventRecord {
  const row = sql
    .exec(
      'SELECT * FROM project_events WHERE project_id = ? AND id = ? LIMIT 1',
      projectId,
      eventId
    )
    .toArray()[0];
  if (!row) throw new ProjectEventNotFoundError('Project event');
  return mapProjectEvent(row);
}

export function readEventByDeliveryKey(
  sql: SqlStorage,
  projectId: string,
  source: string,
  deliveryKey: string
): ProjectEventRecord | null {
  const row = sql
    .exec(
      `SELECT * FROM project_events
       WHERE project_id = ? AND source = ? AND delivery_key = ?
       LIMIT 1`,
      projectId,
      source,
      deliveryKey
    )
    .toArray()[0];
  return row ? mapProjectEvent(row) : null;
}

export function createMatchesForEvent(
  sql: SqlStorage,
  event: ProjectEventRecord,
  now: number,
  limits: ProjectEventLimits
): ProjectEventMatchRecord[] {
  const eventKeys = projectEventKeys(event);
  const placeholders = eventKeys.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT DISTINCT s.*
       FROM project_event_subscriptions s
       JOIN project_event_subscription_match_keys k ON k.subscription_id = s.id
       WHERE s.project_id = ?
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND k.match_key IN (${placeholders})
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT ?`,
      event.projectId,
      now,
      ...eventKeys,
      limits.maxActiveSubscriptionsPerProject
    )
    .toArray();

  const matches: ProjectEventMatchRecord[] = [];
  for (const row of rows) {
    let subscription: ProjectEventSubscriptionRecord;
    try {
      subscription = mapProjectEventSubscription(row);
    } catch (error) {
      log.warn('subscription_candidate_skipped', { error: String(error) });
      continue;
    }
    if (!filterMatchesProjectEvent(subscription.filter, event)) continue;
    const match = insertMatchIfAbsent(sql, event, subscription, now);
    matches.push(match);
    if (matches.length >= limits.maxMatchesPerEvent) break;
  }
  return matches;
}

export function listMatchesForEvent(
  sql: SqlStorage,
  projectId: string,
  eventId: string,
  limit: number
): ProjectEventMatchRecord[] {
  const rows = sql
    .exec(
      `SELECT * FROM project_event_matches
       WHERE project_id = ? AND event_id = ?
       ORDER BY matched_at DESC, id
       LIMIT ?`,
      projectId,
      eventId,
      limit
    )
    .toArray();
  return mapRows(rows, mapProjectEventMatch, limit, 'event_match');
}

export function readSubscriptionById(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string
): ProjectEventSubscriptionRecord {
  const row = sql
    .exec(
      'SELECT * FROM project_event_subscriptions WHERE project_id = ? AND id = ? LIMIT 1',
      projectId,
      subscriptionId
    )
    .toArray()[0];
  if (!row) throw new ProjectEventNotFoundError('Event subscription');
  return mapProjectEventSubscription(row);
}

export function getRequiredSubscription(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string
): ProjectEventSubscriptionRecord {
  return readSubscriptionById(sql, projectId, subscriptionId);
}

export function readSubscriptionByIdempotencyKey(
  sql: SqlStorage,
  projectId: string,
  ownerType: string,
  ownerId: string,
  idempotencyKey: string
): ProjectEventSubscriptionRecord | null {
  const row = sql
    .exec(
      `SELECT * FROM project_event_subscriptions
       WHERE project_id = ? AND owner_type = ? AND owner_id = ? AND idempotency_key = ?
       LIMIT 1`,
      projectId,
      ownerType,
      ownerId,
      idempotencyKey
    )
    .toArray()[0];
  return row ? mapProjectEventSubscription(row) : null;
}

export function readSubscriptionFingerprint(
  sql: SqlStorage,
  subscriptionId: string
): string | null {
  const row = sql
    .exec(
      'SELECT idempotency_fingerprint FROM project_event_subscriptions WHERE id = ? LIMIT 1',
      subscriptionId
    )
    .toArray()[0];
  return isFingerprintRow(row) ? row.idempotency_fingerprint : null;
}

export function enforceActiveSubscriptionLimit(
  sql: SqlStorage,
  projectId: string,
  maxActive: number
): void {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS cnt
       FROM project_event_subscriptions
       WHERE project_id = ? AND lifecycle_state = 'active'`,
      projectId
    )
    .toArray()[0];
  const count = isCountRow(row) ? row.cnt : 0;
  if (count >= maxActive) {
    throw new ProjectEventLimitExceededError(
      `project already has ${maxActive} active event subscriptions`
    );
  }
}

export function expireDueSubscriptions(
  sql: SqlStorage,
  projectId: string,
  now: number,
  limit: number
): number {
  const rows = sql
    .exec(
      `SELECT id FROM project_event_subscriptions
       WHERE project_id = ? AND lifecycle_state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at ASC, id
       LIMIT ?`,
      projectId,
      now,
      limit
    )
    .toArray();
  const ids = rows.filter(isIdRow).map((row) => row.id);
  if (ids.length === 0) return 0;
  sql.exec(
    `UPDATE project_event_subscriptions
     SET lifecycle_state = 'expired', updated_at = ?
     WHERE project_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    now,
    projectId,
    ...ids
  );
  sql.exec(
    `UPDATE project_event_matches
     SET state = 'expired', lifecycle_checked_at = ?, reason = ?
     WHERE project_id = ?
       AND subscription_id IN (${ids.map(() => '?').join(', ')})
       AND batch_id IS NULL
       AND state = 'matched'`,
    now,
    'subscription expired',
    projectId,
    ...ids
  );
  return ids.length;
}

export function normalizeOwnerForRead(
  input: ProjectEventSubscriptionOwner,
  limits: ProjectEventLimits
): ProjectEventSubscriptionOwner {
  if (!OWNER_TYPE_SET.has(input.type)) {
    throw new ProjectEventValidationError('owner type is not allowed');
  }
  return {
    type: input.type,
    id: normalizeText(input.id, 'owner.id', limits.maxFilterStringBytes),
    name: normalizeNullableText(input.name ?? null, 'owner.name', limits.maxFilterStringBytes),
  };
}

export function readMatchesByIds(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  matchIds: string[]
): ProjectEventMatchRecord[] {
  const placeholders = matchIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT * FROM project_event_matches
       WHERE project_id = ? AND subscription_id = ? AND id IN (${placeholders})
       ORDER BY matched_at ASC, id ASC`,
      projectId,
      subscriptionId,
      ...matchIds
    )
    .toArray();
  return mapRows(rows, mapProjectEventMatch, matchIds.length, 'event_match');
}

export function readBatchById(
  sql: SqlStorage,
  projectId: string,
  batchId: string
): ProjectEventDeliveryBatchRecord {
  const row = sql
    .exec(
      'SELECT * FROM project_event_delivery_batches WHERE project_id = ? AND id = ? LIMIT 1',
      projectId,
      batchId
    )
    .toArray()[0];
  if (!row) throw new ProjectEventNotFoundError('Delivery batch');
  return mapProjectEventDeliveryBatch(row);
}

export function getRequiredBatch(
  sql: SqlStorage,
  projectId: string,
  batchId: string
): ProjectEventDeliveryBatchRecord {
  return readBatchById(sql, projectId, batchId);
}

export function readBatchByIdempotencyKey(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  idempotencyKey: string
): ProjectEventDeliveryBatchRecord | null {
  const row = sql
    .exec(
      `SELECT * FROM project_event_delivery_batches
       WHERE project_id = ? AND subscription_id = ? AND idempotency_key = ?
       LIMIT 1`,
      projectId,
      subscriptionId,
      idempotencyKey
    )
    .toArray()[0];
  return row ? mapProjectEventDeliveryBatch(row) : null;
}

export function readBatchFingerprint(sql: SqlStorage, batchId: string): string | null {
  const row = sql
    .exec(
      'SELECT idempotency_fingerprint FROM project_event_delivery_batches WHERE id = ? LIMIT 1',
      batchId
    )
    .toArray()[0];
  return isFingerprintRow(row) ? row.idempotency_fingerprint : null;
}

export function updateMatchesForBatch(
  sql: SqlStorage,
  projectId: string,
  matchIds: string[],
  batchId: string,
  terminalState: ProjectEventDeliveryBatchRecord['state'],
  now: number
): void {
  const matchState =
    terminalState === 'recorded_not_injected' ? 'recorded_not_injected' : terminalState;
  sql.exec(
    `UPDATE project_event_matches
     SET batch_id = ?, state = ?, lifecycle_checked_at = ?
     WHERE project_id = ? AND id IN (${matchIds.map(() => '?').join(', ')})`,
    batchId,
    matchState,
    now,
    projectId,
    ...matchIds
  );
}

export function normalizeAttemptState(
  input: ProjectEventDeliveryAttemptState
): ProjectEventDeliveryAttemptState {
  if (typeof input !== 'string' || !ATTEMPT_STATE_SET.has(input)) {
    throw new ProjectEventValidationError('delivery attempt state is not allowed');
  }
  return input;
}

export function readAttemptById(
  sql: SqlStorage,
  projectId: string,
  attemptId: string
): ProjectEventDeliveryAttemptRecord {
  const row = sql
    .exec(
      'SELECT * FROM project_event_delivery_attempts WHERE project_id = ? AND id = ? LIMIT 1',
      projectId,
      attemptId
    )
    .toArray()[0];
  if (!row) throw new ProjectEventNotFoundError('Delivery attempt');
  return mapProjectEventDeliveryAttempt(row);
}

export function readAttemptByIdempotencyKey(
  sql: SqlStorage,
  projectId: string,
  batchId: string,
  idempotencyKey: string
): ProjectEventDeliveryAttemptRecord | null {
  const row = sql
    .exec(
      `SELECT * FROM project_event_delivery_attempts
       WHERE project_id = ? AND batch_id = ? AND idempotency_key = ?
       LIMIT 1`,
      projectId,
      batchId,
      idempotencyKey
    )
    .toArray()[0];
  return row ? mapProjectEventDeliveryAttempt(row) : null;
}

export function readAttemptFingerprint(sql: SqlStorage, attemptId: string): string | null {
  const row = sql
    .exec(
      'SELECT idempotency_fingerprint FROM project_event_delivery_attempts WHERE id = ? LIMIT 1',
      attemptId
    )
    .toArray()[0];
  return isFingerprintRow(row) ? row.idempotency_fingerprint : null;
}

export function countAttemptsForBatch(sql: SqlStorage, projectId: string, batchId: string): number {
  const row = sql
    .exec(
      'SELECT COUNT(*) AS cnt FROM project_event_delivery_attempts WHERE project_id = ? AND batch_id = ?',
      projectId,
      batchId
    )
    .toArray()[0];
  return isCountRow(row) ? row.cnt : 0;
}

export function updateBatchForAttempt(
  sql: SqlStorage,
  projectId: string,
  batchId: string,
  attemptState: ProjectEventDeliveryAttemptState,
  now: number,
  reason: string | null
): void {
  const batchState =
    attemptState === 'accepted' ? 'delivered' : attemptState === 'retry' ? 'pending' : attemptState;
  const terminalAt = attemptState === 'retry' ? null : now;
  sql.exec(
    `UPDATE project_event_delivery_batches
     SET state = ?, updated_at = ?, terminal_at = ?, terminal_reason = COALESCE(?, terminal_reason)
     WHERE project_id = ? AND id = ?`,
    batchState,
    now,
    terminalAt,
    reason,
    projectId,
    batchId
  );
}

export function mapRows<T>(
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
  orderColumn: string,
  limit: number,
  mapper: (row: unknown) => T
): { items: T[]; hasMore: boolean } {
  const rows = sql
    .exec(
      `SELECT * FROM ${table}
       WHERE project_id = ?
       ORDER BY ${orderColumn} DESC, id
       LIMIT ?`,
      projectId,
      limit + 1
    )
    .toArray();
  return { items: mapRows(rows, mapper, limit, table), hasMore: rows.length > limit };
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
  return mapRows(rows, mapProjectEventStorageAccounting, rows.length, 'storage_accounting');
}

export function deleteOldRows(
  sql: SqlStorage,
  table: ProjectEventTable,
  projectId: string,
  timestampColumn: string,
  cutoff: number,
  limit: number,
  extraWhere = '',
  extraParams: unknown[] = []
): number {
  const rows = sql
    .exec(
      `SELECT id FROM ${table}
       WHERE project_id = ? AND ${timestampColumn} < ? ${extraWhere}
       ORDER BY ${timestampColumn} ASC, id
       LIMIT ?`,
      projectId,
      cutoff,
      ...extraParams,
      limit
    )
    .toArray();
  const ids = rows.filter(isIdRow).map((row) => row.id);
  if (ids.length === 0) return 0;
  sql.exec(
    `DELETE FROM ${table}
     WHERE project_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    projectId,
    ...ids
  );
  return ids.length;
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
  if (ids.length === 0) return 0;
  sql.exec(
    `DELETE FROM project_events
     WHERE project_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    projectId,
    ...ids
  );
  return ids.length;
}

export function accountingFor(
  sql: SqlStorage,
  projectId: string,
  category: ProjectEventTable,
  timestampColumn: string,
  byteExpression: string,
  measuredAt: number
): ProjectEventStorageAccountingRecord {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS record_count,
              COALESCE(SUM(${byteExpression}), 0) AS estimated_bytes,
              MIN(${timestampColumn}) AS oldest_created_at,
              MAX(${timestampColumn}) AS newest_created_at
       FROM ${category}
       WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
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

function insertMatchIfAbsent(
  sql: SqlStorage,
  event: ProjectEventRecord,
  subscription: ProjectEventSubscriptionRecord,
  now: number
): ProjectEventMatchRecord {
  const existing = sql
    .exec(
      `SELECT * FROM project_event_matches
       WHERE project_id = ? AND event_id = ? AND subscription_id = ?
       LIMIT 1`,
      event.projectId,
      event.id,
      subscription.id
    )
    .toArray()[0];
  if (existing) return mapProjectEventMatch(existing);
  const matchId = generateId();
  sql.exec(
    `INSERT INTO project_event_matches
     (id, project_id, event_id, subscription_id, state, matched_at, lifecycle_checked_at, reason)
     VALUES (?, ?, ?, ?, 'matched', ?, ?, ?)`,
    matchId,
    event.projectId,
    event.id,
    subscription.id,
    now,
    now,
    null
  );
  sql.exec(
    `UPDATE project_event_subscriptions
     SET last_matched_at = ?, updated_at = ?
     WHERE project_id = ? AND id = ? AND lifecycle_state = 'active'`,
    now,
    now,
    event.projectId,
    subscription.id
  );
  return mapProjectEventMatch(
    sql
      .exec(
        'SELECT * FROM project_event_matches WHERE project_id = ? AND id = ?',
        event.projectId,
        matchId
      )
      .toArray()[0]
  );
}
