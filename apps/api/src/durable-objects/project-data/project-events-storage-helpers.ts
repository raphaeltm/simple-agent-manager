import {
  isJsonRecord,
  PROJECT_EVENT_DELIVERY_ATTEMPT_STATES,
  PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES,
  type ProjectEventDeliveryAttemptRecord,
  type ProjectEventDeliveryAttemptState,
  type ProjectEventDeliveryBatchRecord,
  type ProjectEventDeliveryBatchState,
  type ProjectEventLimits,
  type ProjectEventMatchRecord,
  type ProjectEventMatchState,
  type ProjectEventRecord,
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
  mapProjectEventSubscription,
} from './project-events-mappers';
import { filterMatchesProjectEvent, projectEventKeys } from './project-events-normalization';
import { normalizeNullableText, normalizeText } from './project-events-values';
import { generateId } from './types';

const log = createModuleLogger('project_data.project_events.storage');
const OWNER_TYPE_SET = new Set<string>(PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES);
const ATTEMPT_STATE_SET = new Set<string>(PROJECT_EVENT_DELIVERY_ATTEMPT_STATES);
export const SQLITE_MAX_BIND_PARAMETERS = 100;

type FingerprintRow = { idempotency_fingerprint: string };
type CountRow = { cnt: number };
type IdRow = { id: string };
function isFingerprintRow(input: unknown): input is FingerprintRow {
  return isJsonRecord(input) && typeof input.idempotency_fingerprint === 'string';
}

function isCountRow(input: unknown): input is CountRow {
  return isJsonRecord(input) && typeof input.cnt === 'number';
}

function isIdRow(input: unknown): input is IdRow {
  return isJsonRecord(input) && typeof input.id === 'string';
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
  for (const chunk of chunkIdsForBindBudget(ids, 2)) {
    const placeholders = chunk.map(() => '?').join(', ');
    sql.exec(
      `UPDATE project_event_subscriptions
       SET lifecycle_state = 'expired', wake_due_at = NULL, updated_at = ?
       WHERE project_id = ? AND id IN (${placeholders})`,
      now,
      projectId,
      ...chunk
    );
  }
  for (const chunk of chunkIdsForBindBudget(ids, 3)) {
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
  const rows: unknown[] = [];
  for (const chunk of chunkIdsForBindBudget(matchIds, 2)) {
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(
      ...sql
        .exec(
          `SELECT * FROM project_event_matches
           WHERE project_id = ? AND subscription_id = ? AND id IN (${placeholders})
           ORDER BY matched_at ASC, id ASC`,
          projectId,
          subscriptionId,
          ...chunk
        )
        .toArray()
    );
  }
  return mapRows(rows, mapProjectEventMatch, matchIds.length, 'event_match').sort(
    (left, right) => left.matchedAt - right.matchedAt || left.id.localeCompare(right.id)
  );
}

export function readEventsForMatches(
  sql: SqlStorage,
  projectId: string,
  matchIds: string[],
  limit: number
): ProjectEventRecord[] {
  const rows: unknown[] = [];
  for (const chunk of chunkIdsForBindBudget(matchIds, 2)) {
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(
      ...sql
        .exec(
          `SELECT e.*
           FROM project_event_matches m
           JOIN project_events e ON e.project_id = m.project_id AND e.id = m.event_id
           WHERE m.project_id = ? AND m.id IN (${placeholders})
           ORDER BY m.matched_at ASC, m.id ASC
           LIMIT ?`,
          projectId,
          ...chunk,
          Math.max(0, limit - rows.length)
        )
        .toArray()
    );
    if (rows.length >= limit) break;
  }
  return mapRows(rows, mapProjectEvent, limit, 'project_event');
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
  batchState: ProjectEventDeliveryBatchRecord['state'],
  now: number
): void {
  const matchState = matchStateForBatchState(batchState);
  for (const chunk of chunkIdsForBindBudget(matchIds, 4)) {
    const placeholders = chunk.map(() => '?').join(', ');
    sql.exec(
      `UPDATE project_event_matches
       SET batch_id = ?, state = ?, lifecycle_checked_at = ?
       WHERE project_id = ? AND id IN (${placeholders})`,
      batchId,
      matchState,
      now,
      projectId,
      ...chunk
    );
  }
}

function matchStateForBatchState(
  batchState: ProjectEventDeliveryBatchRecord['state']
): ProjectEventMatchState {
  switch (batchState) {
    case 'recorded_not_injected':
      return 'recorded_not_injected';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'delivered':
    case 'acked':
    case 'failed':
    case 'ambiguous':
      return 'batch_created';
  }
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
      `SELECT COUNT(*) AS cnt
       FROM project_event_delivery_attempts
       WHERE project_id = ? AND batch_id = ? AND attempt_number > 0`,
      projectId,
      batchId
    )
    .toArray()[0];
  return isCountRow(row) ? row.cnt : 0;
}

export function nextPhysicalAttemptNumber(
  sql: SqlStorage,
  projectId: string,
  batchId: string
): number {
  const row = sql
    .exec(
      `SELECT COALESCE(MAX(attempt_number), 0) AS cnt
       FROM project_event_delivery_attempts
       WHERE project_id = ? AND batch_id = ? AND attempt_number > 0`,
      projectId,
      batchId
    )
    .toArray()[0];
  return (isCountRow(row) ? row.cnt : 0) + 1;
}

export function updateBatchForAttempt(
  sql: SqlStorage,
  projectId: string,
  batchId: string,
  attemptState: ProjectEventDeliveryAttemptState,
  now: number,
  reason: string | null
): void {
  const batchState = batchStateForAttempt(attemptState);
  const terminalAt = attemptState === 'retry' ? null : now;
  if (attemptState === 'accepted') {
    sql.exec(
      `UPDATE project_event_delivery_batches
       SET state = ?, updated_at = ?, delivered_at = COALESCE(delivered_at, ?), terminal_at = ?, terminal_reason = COALESCE(?, terminal_reason)
       WHERE project_id = ? AND id = ?`,
      batchState,
      now,
      now,
      terminalAt,
      reason,
      projectId,
      batchId
    );
    return;
  }
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

export function batchStateForAttempt(
  attemptState: ProjectEventDeliveryAttemptState
): ProjectEventDeliveryBatchState {
  switch (attemptState) {
    case 'accepted':
      return 'delivered';
    case 'retry':
      return 'pending';
    case 'recorded_not_injected':
    case 'failed':
    case 'ambiguous':
      return attemptState;
  }
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

export function claimProjectEventMatchesForBatch(
  sql: SqlStorage,
  projectId: string,
  matchIds: readonly string[],
  batchId: string,
  now: number,
  reason: string
): number {
  if (matchIds.length === 0) return 0;
  let claimed = 0;
  for (const chunk of chunkIdsForBindBudget(matchIds, 4)) {
    const placeholders = chunk.map(() => '?').join(', ');
    sql.exec(
      `UPDATE project_event_matches
       SET batch_id = ?, state = 'batch_created', lifecycle_checked_at = ?, reason = ?
       WHERE project_id = ?
         AND id IN (${placeholders})
         AND state = 'matched'
         AND batch_id IS NULL`,
      batchId,
      now,
      reason,
      projectId,
      ...chunk
    );
    const row = sql
      .exec(
        `SELECT COUNT(*) AS cnt
         FROM project_event_matches
         WHERE project_id = ?
           AND id IN (${placeholders})
           AND state = 'batch_created'
           AND batch_id = ?`,
        projectId,
        ...chunk,
        batchId
      )
      .toArray()[0];
    claimed += typeof row?.cnt === 'number' ? row.cnt : 0;
  }
  return claimed;
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
     SET last_matched_at = ?,
         wake_due_at = CASE
           WHEN requested_delivery = 'existing_session_prompt'
            AND resolved_delivery = 'queued_for_prompt_delivery'
            AND contract_version >= 2
            AND owner_version >= 2
            AND (wake_due_at IS NULL OR wake_due_at > ?)
           THEN ?
           ELSE wake_due_at
         END,
         updated_at = ?
     WHERE project_id = ? AND id = ? AND lifecycle_state = 'active'`,
    now,
    now,
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
