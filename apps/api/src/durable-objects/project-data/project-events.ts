import {
  type GetProjectEventSubscriptionInput,
  type ListProjectEventSubscriptionsInput,
  type ProjectEventAdmissionResult,
  type ProjectEventExpireSubscriptionsResult,
  type ProjectEventSubscriptionListResult,
  type ProjectEventSubscriptionMutationResult,
  type ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

import {
  type AdmitProjectEventInput,
  type CancelProjectEventSubscriptionInput,
  type CreateProjectEventSubscriptionInput,
  type ExpireProjectEventSubscriptionsInput,
  ProjectEventIdempotencyConflictError,
  ProjectEventValidationError,
} from './project-events-contracts';
import { findNewerCredentialLimitEvent } from './project-events-credential-supersession';
import { resolveProjectEventLimits } from './project-events-limits';
import { mapProjectEventSubscription } from './project-events-mappers';
import { ensureProjectEventRetentionScheduled } from './project-events-scheduler';
import {
  assertProjectBinding,
  normalizeListLimit,
  normalizeProjectEventInput,
  normalizeProjectId,
  normalizeSubscriptionInput,
} from './project-events-normalization';
import {
  createMatchesForEvent,
  enforceActiveSubscriptionLimit,
  expireDueSubscriptions,
  getRequiredSubscription,
  listMatchesForEvent,
  mapRows,
  normalizeOwnerForRead,
  readEventByDeliveryKey,
  readEventById,
  readSubscriptionById,
  readSubscriptionByIdempotencyKey,
  readSubscriptionFingerprint,
} from './project-events-storage-helpers';
import {
  normalizeNullableText,
  normalizeText,
  normalizeTimestamp,
  stableStringify,
} from './project-events-values';
import type { Env } from './types';
import { generateId } from './types';

export type {
  AckProjectEventDeliveryInput,
  AdmitProjectEventInput,
  CancelProjectEventSubscriptionInput,
  CreateProjectEventDeliveryBatchInput,
  CreateProjectEventSubscriptionInput,
  ExpireProjectEventSubscriptionsInput,
  GetProjectEventInput,
  GetProjectEventRecentStatusInput,
  GetProjectEventSubscriptionInput,
  ListProjectEventDeliveryAttemptsInput,
  ListProjectEventDeliveryBatchesInput,
  ListProjectEventSubscriptionEventsInput,
  ListProjectEventSubscriptionsInput,
  ProjectEventAdmissionResult,
  ProjectEventDeliveryAckResult,
  ProjectEventDeliveryAttemptListResult,
  ProjectEventDeliveryAttemptMutationResult,
  ProjectEventDeliveryBatchListResult,
  ProjectEventDeliveryBatchMutationResult,
  ProjectEventExpireSubscriptionsResult,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventSubscriptionEvent,
  ProjectEventSubscriptionEventListResult,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  RecordProjectEventDeliveryAttemptInput,
  RunProjectEventRetentionInput,
} from './project-events-contracts';
export {
  ProjectEventAckPolicyError,
  ProjectEventAckStateError,
  ProjectEventCursorError,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from './project-events-contracts';
export {
  createProjectEventDeliveryBatch,
  listProjectEventDeliveryAttempts,
  listProjectEventDeliveryBatches,
  recordProjectEventDeliveryAttempt,
} from './project-events-delivery';
export {
  buildProjectEventDeliveryModelSummary,
  resolveProjectEventDelivery,
  type ResolveProjectEventDeliveryInput,
} from './project-events-delivery-resolver';
export { resolveProjectEventLimits } from './project-events-limits';
export {
  cancelProjectEventWakeForRevokedSourceTask,
  type AcceptedProjectEventWake,
  type ProjectEventWakeMaterializationCandidate,
  type ProjectEventWakeMaterializationResult,
  type ProjectEventWakeSourceTaskGuard,
  runProjectEventWakeMaterializationBatch,
  selectProjectEventWakeMaterializationCandidate,
  selectProjectEventWakeMaterializationCandidates,
} from './project-events-materialization';
export {
  computeProjectEventMaterializationAlarmTime,
  computeProjectEventRetentionAlarmTime,
  ensureProjectEventRetentionScheduled,
  isProjectEventRetentionDue,
  isProjectEventWakeEnabled,
  markSchedulerSuccess,
  readSchedulerState,
  recordSchedulerFailure,
} from './project-events-scheduler';
export {
  EVENT_WAKE_ADAPTER_ID,
  advanceProjectEventPromptAttemptCheckpoint,
  hasProjectEventWakeLease,
  invalidProjectEventWakeDeliveryTargetResult,
  readProjectEventWakeLeaseUntil,
  validateProjectEventWakeRecoveryAuthority,
  type ValidateProjectEventWakeRecoveryAuthorityInput,
} from './project-events-wake-delivery';
export { compileProjectEventFilter } from './project-events-normalization';
export {
  ackProjectEventDelivery,
  getProjectEvent,
  listProjectEventSubscriptionEvents,
} from './project-events-pull';
export {
  getProjectEventRecentStatus,
  refreshProjectEventStorageAccounting,
  runProjectEventRetention,
} from './project-events-status-retention';

export function admitProjectEvent(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: AdmitProjectEventInput,
  requireCompleteFanout = false
): ProjectEventAdmissionResult {
  const limits = resolveProjectEventLimits(env);
  const eventInput = normalizeProjectEventInput(input, limits);
  assertProjectBinding(storedProjectId, eventInput.projectId);

  const existing = readEventByDeliveryKey(
    sql,
    eventInput.projectId,
    eventInput.source,
    eventInput.deliveryKey
  );
  if (existing) {
    ensureProjectEventRetentionScheduled(sql, env, eventInput.projectId, Date.now());
    if (existing.payloadFingerprint === eventInput.payloadFingerprint) {
      sql.exec(
        `UPDATE project_events
         SET duplicate_count = duplicate_count + 1, updated_at = ?
         WHERE project_id = ? AND id = ?`,
        eventInput.receivedAt,
        eventInput.projectId,
        existing.id
      );
      return {
        outcome: 'duplicate_replay',
        event: readEventById(sql, eventInput.projectId, existing.id),
        matches: listMatchesForEvent(sql, eventInput.projectId, existing.id, limits.listLimitMax),
      };
    }

    sql.exec(
      `UPDATE project_events
       SET state = 'conflicted',
           conflict_count = conflict_count + 1,
           conflict_fingerprint = ?,
           conflict_detected_at = ?,
           updated_at = ?
       WHERE project_id = ? AND id = ?`,
      eventInput.payloadFingerprint,
      eventInput.receivedAt,
      eventInput.receivedAt,
      eventInput.projectId,
      existing.id
    );
    const conflicted = readEventById(sql, eventInput.projectId, existing.id);
    return {
      outcome: 'conflict',
      event: conflicted,
      matches: listMatchesForEvent(sql, eventInput.projectId, existing.id, limits.listLimitMax),
      conflict: {
        deliveryKey: eventInput.deliveryKey,
        existingFingerprint: existing.payloadFingerprint,
        incomingFingerprint: eventInput.payloadFingerprint,
      },
    };
  }

  const newerCredentialEvent = findNewerCredentialLimitEvent(sql, eventInput);
  if (newerCredentialEvent) {
    ensureProjectEventRetentionScheduled(sql, env, eventInput.projectId, Date.now());
    return {
      outcome: 'conflict',
      event: newerCredentialEvent,
      matches: listMatchesForEvent(
        sql,
        eventInput.projectId,
        newerCredentialEvent.id,
        limits.listLimitMax
      ),
      conflict: {
        deliveryKey: eventInput.deliveryKey,
        existingFingerprint: newerCredentialEvent.payloadFingerprint,
        incomingFingerprint: eventInput.payloadFingerprint,
      },
    };
  }

  const eventId = generateId();
  sql.exec(
    `INSERT INTO project_events
     (id, project_id, contract_version, source, event_type, subject_type, subject_id, severity,
      delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
      audience_scope, audience_project_id, audience_user_id, display_json, display_bytes,
      raw_payload_ref_json, raw_payload_ref_bytes, occurred_at, received_at, updated_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    eventInput.projectId,
    eventInput.contractVersion,
    eventInput.source,
    eventInput.eventType,
    eventInput.subject.type,
    eventInput.subject.id,
    eventInput.severity,
    eventInput.deliveryKey,
    eventInput.payloadFingerprint,
    eventInput.metadataJson,
    eventInput.metadataBytes,
    eventInput.audience.scope,
    eventInput.audience.projectId,
    eventInput.audience.userId,
    eventInput.displayJson,
    eventInput.displayBytes,
    eventInput.rawPayloadRefJson,
    eventInput.rawPayloadRefBytes,
    eventInput.occurredAt,
    eventInput.receivedAt,
    eventInput.updatedAt,
    'recorded'
  );

  const event = readEventById(sql, eventInput.projectId, eventId);
  const matches = createMatchesForEvent(
    sql,
    event,
    eventInput.receivedAt,
    limits,
    requireCompleteFanout
  );
  ensureProjectEventRetentionScheduled(sql, env, eventInput.projectId, Date.now());
  return { outcome: 'created', event, matches };
}

export function createProjectEventSubscription(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: CreateProjectEventSubscriptionInput
): ProjectEventSubscriptionMutationResult {
  const limits = resolveProjectEventLimits(env);
  const normalized = normalizeSubscriptionInput(input, limits);
  assertProjectBinding(storedProjectId, normalized.projectId);
  const now = Date.now();
  expireDueSubscriptions(sql, normalized.projectId, now, limits.retentionBatchRows);

  const existing = readSubscriptionByIdempotencyKey(
    sql,
    normalized.projectId,
    normalized.owner.type,
    normalized.owner.id,
    normalized.idempotencyKey
  );
  if (existing) {
    if (readSubscriptionFingerprint(sql, existing.id) !== normalized.idempotencyFingerprint) {
      throw new ProjectEventIdempotencyConflictError();
    }
    return { subscription: existing, idempotent: true, changed: false };
  }

  if (normalized.expiresAt !== null && normalized.expiresAt <= now) {
    throw new ProjectEventValidationError('expiresAt must be in the future');
  }
  enforceActiveSubscriptionLimit(
    sql,
    normalized.projectId,
    limits.maxActiveSubscriptionsPerProject
  );

  const subscriptionId = generateId();
  const deliveryLifetimeExpiresAt =
    normalized.deliveryPreference.resolved === 'queued_for_prompt_delivery'
      ? Math.min(
          normalized.expiresAt ?? now + limits.wakeSubscriptionLifetimeMs,
          now + limits.wakeSubscriptionLifetimeMs
        )
      : normalized.expiresAt;
  sql.exec(
    `INSERT INTO project_event_subscriptions
     (id, project_id, contract_version, owner_type, owner_id, owner_name, idempotency_key,
      idempotency_fingerprint, filter_version, filter_json, filter_fingerprint, match_key_count,
      requested_delivery, resolved_delivery, target_session_id, target_task_id, target_runtime_id,
      target_agent_id, lifecycle_state, reason, created_at, updated_at, expires_at,
      owner_version, owner_project_id, owner_chat_session_id, owner_task_id, owner_runtime_id,
      prompt_delivery_count, prompt_delivery_last_at, delivery_cooldown_until,
      delivery_lifetime_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    subscriptionId,
    normalized.projectId,
    normalized.deliveryPreference.resolved === 'queued_for_prompt_delivery' ? 2 : 1,
    normalized.owner.type,
    normalized.owner.id,
    normalized.owner.name,
    normalized.idempotencyKey,
    normalized.idempotencyFingerprint,
    1,
    stableStringify(normalized.compiledFilter.filter),
    normalized.compiledFilter.fingerprint,
    normalized.compiledFilter.matchKeys.length,
    normalized.deliveryPreference.requested,
    normalized.deliveryPreference.resolved,
    normalized.deliveryPreference.target?.sessionId ?? null,
    normalized.deliveryPreference.target?.taskId ?? null,
    normalized.deliveryPreference.target?.runtimeId ?? null,
    normalized.deliveryPreference.target?.agentId ?? null,
    'active',
    normalized.reason,
    now,
    now,
    normalized.expiresAt,
    normalized.deliveryPreference.resolved === 'queued_for_prompt_delivery' ? 2 : 1,
    normalized.projectId,
    normalized.deliveryPreference.target?.sessionId ?? null,
    normalized.ownerTaskId ?? normalized.deliveryPreference.target?.taskId ?? null,
    normalized.deliveryPreference.target?.runtimeId ??
      normalized.deliveryPreference.target?.agentId ??
      null,
    0,
    null,
    null,
    deliveryLifetimeExpiresAt
  );
  for (const key of normalized.compiledFilter.matchKeys) {
    sql.exec(
      `INSERT INTO project_event_subscription_match_keys
       (project_id, subscription_id, field_name, field_value, match_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      normalized.projectId,
      subscriptionId,
      key.field,
      key.value,
      key.matchKey,
      now
    );
  }

  return {
    subscription: readSubscriptionById(sql, normalized.projectId, subscriptionId),
    idempotent: false,
    changed: true,
  };
}

export function listProjectEventSubscriptions(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ListProjectEventSubscriptionsInput
): ProjectEventSubscriptionListResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  expireDueSubscriptions(sql, projectId, Date.now(), limits.retentionBatchRows);
  const limit = normalizeListLimit(input.limit, limits);
  const state = input.state ?? 'active';
  const owner = input.owner ? normalizeOwnerForRead(input.owner, limits) : null;
  const legacyOwners = (input.legacyOwners ?? []).map((legacyOwner) =>
    normalizeOwnerForRead(legacyOwner, limits)
  );
  const params: unknown[] = [projectId];
  let where = 'WHERE project_id = ?';
  if (input.targetSessionId !== undefined && input.targetSessionId !== null) {
    where += ' AND target_session_id = ?';
    params.push(
      normalizeText(input.targetSessionId, 'targetSessionId', limits.maxFilterStringBytes)
    );
  }
  if (state !== 'any') {
    where += ' AND lifecycle_state = ?';
    params.push(state);
  }
  if (owner && legacyOwners.length > 0) {
    const ownerPredicates = ['(owner_type = ? AND owner_id = ?)'];
    params.push(owner.type, owner.id);
    for (const legacyOwner of legacyOwners) {
      ownerPredicates.push('(owner_version = 1 AND owner_type = ? AND owner_id = ?)');
      params.push(legacyOwner.type, legacyOwner.id);
    }
    where += ` AND (${ownerPredicates.join(' OR ')})`;
  } else if (owner) {
    where += ' AND owner_type = ? AND owner_id = ?';
    params.push(owner.type, owner.id);
  }
  params.push(limit + 1);
  const rows = sql
    .exec(
      `SELECT * FROM project_event_subscriptions
       ${where}
       ORDER BY updated_at DESC, id
       LIMIT ?`,
      ...params
    )
    .toArray();
  const subscriptions = mapRows(rows, mapProjectEventSubscription, limit, 'subscription');
  return { subscriptions, hasMore: rows.length > limit };
}

export function getProjectEventSubscription(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: GetProjectEventSubscriptionInput
): ProjectEventSubscriptionRecord | null {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  expireDueSubscriptions(sql, projectId, Date.now(), limits.retentionBatchRows);
  const row = sql
    .exec(
      'SELECT * FROM project_event_subscriptions WHERE project_id = ? AND id = ? LIMIT 1',
      projectId,
      normalizeText(input.subscriptionId, 'subscriptionId', limits.maxFilterStringBytes)
    )
    .toArray()[0];
  return row ? mapProjectEventSubscription(row) : null;
}

export function cancelProjectEventSubscription(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: CancelProjectEventSubscriptionInput
): ProjectEventSubscriptionMutationResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const subscriptionId = normalizeText(
    input.subscriptionId,
    'subscriptionId',
    limits.maxFilterStringBytes
  );
  const cancelledBy = normalizeOwnerForRead(input.cancelledBy, limits);
  const reason = normalizeNullableText(input.reason ?? null, 'reason', limits.maxReasonBytes);
  const now = Date.now();
  expireDueSubscriptions(sql, projectId, now, limits.retentionBatchRows);
  const subscription = getRequiredSubscription(sql, projectId, subscriptionId);
  if (subscription.state === 'cancelled') {
    return { subscription, idempotent: true, changed: false };
  }
  sql.exec(
    `UPDATE project_event_subscriptions
     SET lifecycle_state = 'cancelled',
         cancelled_at = ?,
         cancelled_by_type = ?,
         cancelled_by_id = ?,
         cancelled_by_name = ?,
         cancel_reason = ?,
         wake_due_at = NULL,
         updated_at = ?
     WHERE project_id = ? AND id = ? AND lifecycle_state != 'cancelled'`,
    now,
    cancelledBy.type,
    cancelledBy.id,
    cancelledBy.name,
    reason,
    now,
    projectId,
    subscriptionId
  );
  sql.exec(
    `UPDATE project_event_matches
     SET state = 'cancelled', lifecycle_checked_at = ?, reason = ?
     WHERE project_id = ?
       AND subscription_id = ?
       AND batch_id IS NULL
       AND state = 'matched'`,
    now,
    'subscription cancelled',
    projectId,
    subscriptionId
  );
  sql.exec(
    `UPDATE project_event_delivery_batches
     SET state = 'cancelled',
         readable_until = NULL,
         updated_at = ?,
         terminal_at = COALESCE(terminal_at, ?),
         terminal_reason = COALESCE(terminal_reason, ?)
     WHERE project_id = ?
       AND subscription_id = ?
       AND delivery_channel = 'prompt_queue'
       AND state IN ('pending', 'delivered')`,
    now,
    now,
    'subscription cancelled',
    projectId,
    subscriptionId
  );
  sql.exec(
    `UPDATE session_inbox
     SET delivery_state = 'failed',
         terminal_reason = 'subscription_cancelled',
         last_error = 'Project event wake subscription was cancelled',
         next_attempt_at = NULL,
         attempt_started_at = NULL
     WHERE source_kind = 'project_event_wake'
       AND id IN (
         SELECT id FROM project_event_delivery_batches
         WHERE project_id = ?
           AND subscription_id = ?
           AND delivery_channel = 'prompt_queue'
       )
       AND delivery_state IN ('queued', 'retry_wait', 'delivering', 'delivered')`,
    projectId,
    subscriptionId
  );
  return {
    subscription: readSubscriptionById(sql, projectId, subscriptionId),
    idempotent: false,
    changed: true,
  };
}

export function expireProjectEventSubscriptions(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ExpireProjectEventSubscriptionsInput
): ProjectEventExpireSubscriptionsResult {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const limit = normalizeListLimit(input.limit, limits);
  const now = normalizeTimestamp(input.now ?? Date.now(), 'now');
  return {
    expired: expireDueSubscriptions(
      sql,
      projectId,
      now,
      Math.min(limit, limits.retentionBatchRows)
    ),
  };
}
