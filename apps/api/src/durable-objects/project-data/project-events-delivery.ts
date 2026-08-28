import type {
  ListProjectEventDeliveryAttemptsInput,
  ListProjectEventDeliveryBatchesInput,
  ProjectEventDeliveryAttemptListResult,
  ProjectEventDeliveryAttemptMutationResult,
  ProjectEventDeliveryBatchListResult,
  ProjectEventDeliveryBatchMutationResult,
  ProjectEventDeliveryBatchState,
  ProjectEventSubscriptionState,
} from '@simple-agent-manager/shared';

import {
  type CreateProjectEventDeliveryBatchInput,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
  type RecordProjectEventDeliveryAttemptInput,
} from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import {
  mapProjectEventDeliveryAttempt,
  mapProjectEventDeliveryBatch,
} from './project-events-mappers';
import {
  assertProjectBinding,
  normalizeDeliveryBatchInput,
  normalizeListLimit,
  normalizeProjectId,
} from './project-events-normalization';
import {
  countAttemptsForBatch,
  expireDueSubscriptions,
  getRequiredBatch,
  getRequiredSubscription,
  mapRows,
  normalizeAttemptState,
  readAttemptById,
  readAttemptByIdempotencyKey,
  readAttemptFingerprint,
  readBatchById,
  readBatchByIdempotencyKey,
  readBatchFingerprint,
  readMatchesByIds,
  updateBatchForAttempt,
  updateMatchesForBatch,
} from './project-events-storage-helpers';
import {
  normalizeNullableText,
  normalizeText,
  normalizeTimestamp,
  stableStringify,
} from './project-events-values';
import type { Env } from './types';
import { generateId } from './types';

const TERMINAL_BATCH_STATES = new Set([
  'recorded_not_injected',
  'acked',
  'failed',
  'ambiguous',
  'expired',
  'cancelled',
]);

function initialDeliveryBatchStateFor(
  subscriptionState: ProjectEventSubscriptionState
): ProjectEventDeliveryBatchState {
  switch (subscriptionState) {
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'active':
      return 'recorded_not_injected';
  }
}

function terminalReasonForSubscriptionState(
  subscriptionState: ProjectEventSubscriptionState,
  fallback: string | null
): string | null {
  return subscriptionState === 'active'
    ? fallback
    : `subscription ${subscriptionState} before delivery`;
}

export function createProjectEventDeliveryBatch(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: CreateProjectEventDeliveryBatchInput
): ProjectEventDeliveryBatchMutationResult {
  const limits = resolveProjectEventLimits(env);
  const normalized = normalizeDeliveryBatchInput(input, limits);
  assertProjectBinding(storedProjectId, normalized.projectId);
  const existing = readBatchByIdempotencyKey(
    sql,
    normalized.projectId,
    normalized.subscriptionId,
    normalized.idempotencyKey
  );
  if (existing) {
    if (readBatchFingerprint(sql, existing.id) !== normalized.idempotencyFingerprint) {
      throw new ProjectEventIdempotencyConflictError(
        'delivery batch idempotency key belongs to a different batch mutation'
      );
    }
    return { batch: existing, idempotent: true, changed: false };
  }

  const now = Date.now();
  expireDueSubscriptions(sql, normalized.projectId, now, limits.retentionBatchRows);
  const subscription = getRequiredSubscription(
    sql,
    normalized.projectId,
    normalized.subscriptionId
  );
  const matchRows = readMatchesByIds(
    sql,
    normalized.projectId,
    normalized.subscriptionId,
    normalized.matchIds
  );
  if (matchRows.length !== normalized.matchIds.length) {
    throw new ProjectEventNotFoundError('Event match');
  }

  const terminalState = initialDeliveryBatchStateFor(subscription.state);
  const terminalReason = terminalReasonForSubscriptionState(
    subscription.state,
    normalized.terminalReason
  );
  const eventCount = new Set(matchRows.map((match) => match.eventId)).size;
  const batchId = generateId();
  sql.exec(
    `INSERT INTO project_event_delivery_batches
     (id, project_id, subscription_id, idempotency_key, idempotency_fingerprint, state,
      requested_delivery, resolved_delivery, target_session_id, target_task_id, target_runtime_id,
      target_agent_id, match_ids_json, event_count, created_at, updated_at, terminal_at, terminal_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batchId,
    normalized.projectId,
    normalized.subscriptionId,
    normalized.idempotencyKey,
    normalized.idempotencyFingerprint,
    terminalState,
    normalized.requestedDelivery,
    'recorded_not_injected',
    normalized.target.sessionId ?? null,
    normalized.target.taskId ?? null,
    normalized.target.runtimeId ?? null,
    normalized.target.agentId ?? null,
    stableStringify(normalized.matchIds),
    eventCount,
    now,
    now,
    now,
    terminalReason
  );
  updateMatchesForBatch(
    sql,
    normalized.projectId,
    normalized.matchIds,
    batchId,
    terminalState,
    now
  );
  return {
    batch: readBatchById(sql, normalized.projectId, batchId),
    idempotent: false,
    changed: true,
  };
}

export function listProjectEventDeliveryBatches(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ListProjectEventDeliveryBatchesInput
): ProjectEventDeliveryBatchListResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const limit = normalizeListLimit(input.limit, limits);
  const params: unknown[] = [projectId];
  let where = 'WHERE project_id = ?';
  if (input.subscriptionId) {
    where += ' AND subscription_id = ?';
    params.push(normalizeText(input.subscriptionId, 'subscriptionId', limits.maxFilterStringBytes));
  }
  if (input.state && input.state !== 'any') {
    where += ' AND state = ?';
    params.push(input.state);
  }
  params.push(limit + 1);
  const rows = sql
    .exec(
      `SELECT * FROM project_event_delivery_batches
       ${where}
       ORDER BY updated_at DESC, id
       LIMIT ?`,
      ...params
    )
    .toArray();
  return {
    batches: mapRows(rows, mapProjectEventDeliveryBatch, limit, 'batch'),
    hasMore: rows.length > limit,
  };
}

export function recordProjectEventDeliveryAttempt(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: RecordProjectEventDeliveryAttemptInput
): ProjectEventDeliveryAttemptMutationResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const batchId = normalizeText(input.batchId, 'batchId', limits.maxFilterStringBytes);
  const idempotencyKey = normalizeText(
    input.idempotencyKey,
    'idempotencyKey',
    limits.maxFilterStringBytes
  );
  const state = normalizeAttemptState(input.state);
  const now = Date.now();
  const startedAt = normalizeTimestamp(input.startedAt ?? now, 'startedAt');
  const completedAt =
    input.completedAt === null ? null : normalizeTimestamp(input.completedAt ?? now, 'completedAt');
  const adapter = normalizeNullableText(
    input.adapter ?? null,
    'adapter',
    limits.maxFilterStringBytes
  );
  const protocolVersion = normalizeNullableText(
    input.protocolVersion ?? null,
    'protocolVersion',
    limits.maxFilterStringBytes
  );
  const runtimeId = normalizeNullableText(
    input.runtimeId ?? null,
    'runtimeId',
    limits.maxFilterStringBytes
  );
  const receiptId = normalizeNullableText(
    input.receiptId ?? null,
    'receiptId',
    limits.maxFilterStringBytes
  );
  const errorCode = normalizeNullableText(
    input.errorCode ?? null,
    'errorCode',
    limits.maxFilterStringBytes
  );
  const errorMessage = normalizeNullableText(
    input.errorMessage ?? null,
    'errorMessage',
    limits.maxReasonBytes
  );
  const fingerprint = stableStringify([
    projectId,
    batchId,
    state,
    adapter,
    protocolVersion,
    runtimeId,
    receiptId,
    errorCode,
    errorMessage,
    startedAt,
    completedAt,
  ]);

  const existing = readAttemptByIdempotencyKey(sql, projectId, batchId, idempotencyKey);
  if (existing) {
    if (readAttemptFingerprint(sql, existing.id) !== fingerprint) {
      throw new ProjectEventIdempotencyConflictError(
        'delivery attempt idempotency key belongs to a different attempt mutation'
      );
    }
    return {
      attempt: existing,
      batch: readBatchById(sql, projectId, batchId),
      idempotent: true,
      changed: false,
    };
  }

  const batch = getRequiredBatch(sql, projectId, batchId);
  const existingAttemptCount = countAttemptsForBatch(sql, projectId, batchId);
  if (existingAttemptCount >= limits.maxAttemptsPerBatch) {
    throw new ProjectEventLimitExceededError(
      `delivery batch already has ${limits.maxAttemptsPerBatch} attempts`
    );
  }
  if (TERMINAL_BATCH_STATES.has(batch.state)) {
    if (
      existingAttemptCount > 0 ||
      (batch.state !== state && !(batch.state === 'delivered' && state === 'accepted'))
    ) {
      throw new ProjectEventValidationError('terminal delivery batch does not accept new attempts');
    }
  }

  const attemptNumber = existingAttemptCount + 1;
  const attemptId = generateId();
  sql.exec(
    `INSERT INTO project_event_delivery_attempts
     (id, project_id, batch_id, idempotency_key, idempotency_fingerprint, attempt_number, state,
      adapter, protocol_version, runtime_id, receipt_id, error_code, error_message,
      started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attemptId,
    projectId,
    batchId,
    idempotencyKey,
    fingerprint,
    attemptNumber,
    state,
    adapter,
    protocolVersion,
    runtimeId,
    receiptId,
    errorCode,
    errorMessage,
    startedAt,
    completedAt,
    now
  );
  updateBatchForAttempt(sql, projectId, batchId, state, now, errorMessage);
  return {
    attempt: readAttemptById(sql, projectId, attemptId),
    batch: readBatchById(sql, projectId, batchId),
    idempotent: false,
    changed: true,
  };
}

export function listProjectEventDeliveryAttempts(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ListProjectEventDeliveryAttemptsInput
): ProjectEventDeliveryAttemptListResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const limit = normalizeListLimit(input.limit, limits);
  const params: unknown[] = [projectId];
  let where = 'WHERE project_id = ?';
  if (input.batchId) {
    where += ' AND batch_id = ?';
    params.push(normalizeText(input.batchId, 'batchId', limits.maxFilterStringBytes));
  }
  if (input.state && input.state !== 'any') {
    where += ' AND state = ?';
    params.push(input.state);
  }
  params.push(limit + 1);
  const rows = sql
    .exec(
      `SELECT * FROM project_event_delivery_attempts
       ${where}
       ORDER BY created_at DESC, attempt_number DESC, id
       LIMIT ?`,
      ...params
    )
    .toArray();
  return {
    attempts: mapRows(rows, mapProjectEventDeliveryAttempt, limit, 'attempt'),
    hasMore: rows.length > limit,
  };
}
