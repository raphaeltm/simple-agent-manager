import { type ProjectEventAdmissionResult } from '@simple-agent-manager/shared';

import { createMatchesForEvent, matchingSubscriptionsForEvent } from './project-event-matching';
import { type AdmitProjectEventInput } from './project-events-contracts';
import { findNewerCredentialLimitEvent } from './project-events-credential-supersession';
import { resolveProjectEventLimits } from './project-events-limits';
import { assertProjectBinding, normalizeProjectEventInput } from './project-events-normalization';
import { ensureProjectEventRetentionScheduled } from './project-events-scheduler';
import {
  insertMatchIfAbsent,
  listMatchesForEvent,
  readEventByDeliveryKey,
  readEventById,
} from './project-events-storage-helpers';
import { recordProjectEventAdmission } from './row-usage';
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
  type AcceptedProjectEventWake,
  cancelProjectEventWakeForRevokedSourceTask,
  type ProjectEventWakeMaterializationCandidate,
  type ProjectEventWakeMaterializationResult,
  type ProjectEventWakeSourceTaskGuard,
  runProjectEventWakeMaterializationBatch,
  selectProjectEventWakeMaterializationCandidate,
  selectProjectEventWakeMaterializationCandidates,
} from './project-events-materialization';
export { compileProjectEventFilter } from './project-events-normalization';
export {
  ackProjectEventDelivery,
  getProjectEvent,
  listProjectEventSubscriptionEvents,
} from './project-events-pull';
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
  getProjectEventRecentStatus,
  refreshProjectEventStorageAccounting,
  runProjectEventRetention,
} from './project-events-status-retention';
export {
  cancelProjectEventSubscription,
  createProjectEventSubscription,
  expireProjectEventSubscriptions,
  getProjectEventSubscription,
  listProjectEventSubscriptions,
} from './project-events-subscriptions';
export {
  advanceProjectEventPromptAttemptCheckpoint,
  EVENT_WAKE_ADAPTER_ID,
  hasProjectEventWakeLease,
  invalidProjectEventWakeDeliveryTargetResult,
  readProjectEventWakeLeaseUntil,
  validateProjectEventWakeRecoveryAuthority,
  type ValidateProjectEventWakeRecoveryAuthorityInput,
} from './project-events-wake-delivery';

/** Protocol scope, shared by the runtime-settings gate and SQLite admission. */
export function isGitHubCiProjectEvent(
  input: Pick<AdmitProjectEventInput, 'source' | 'eventType'>
): boolean {
  return (
    input.source.trim() === 'github' &&
    /^(check_run|check_suite|workflow_run)(\.|$)/.test(input.eventType.trim())
  );
}

// Direct internal producers retain history unless the RPC supplies the runtime policy.
export function admitProjectEvent(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: AdmitProjectEventInput,
  requireCompleteFanout?: boolean
): Exclude<ProjectEventAdmissionResult, { outcome: 'skipped_no_subscriber' }>;
export function admitProjectEvent(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: AdmitProjectEventInput,
  requireCompleteFanout: boolean,
  skipUnsubscribedGitHubCi: boolean
): ProjectEventAdmissionResult;
export function admitProjectEvent(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: AdmitProjectEventInput,
  requireCompleteFanout = false,
  skipUnsubscribedGitHubCi = false
): ProjectEventAdmissionResult {
  const limits = resolveProjectEventLimits(env);
  const eventInput = normalizeProjectEventInput(input, limits);
  assertProjectBinding(storedProjectId, eventInput.projectId);
  const finish = (result: ProjectEventAdmissionResult): ProjectEventAdmissionResult => {
    recordProjectEventAdmission(eventInput.source, eventInput.eventType, result.outcome);
    return result;
  };

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
      return finish({
        outcome: 'duplicate_replay',
        event: readEventById(sql, eventInput.projectId, existing.id),
        matches: listMatchesForEvent(sql, eventInput.projectId, existing.id, limits.listLimitMax),
      });
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
    return finish({
      outcome: 'conflict',
      event: conflicted,
      matches: listMatchesForEvent(sql, eventInput.projectId, existing.id, limits.listLimitMax),
      conflict: {
        deliveryKey: eventInput.deliveryKey,
        existingFingerprint: existing.payloadFingerprint,
        incomingFingerprint: eventInput.payloadFingerprint,
      },
    });
  }

  const newerCredentialEvent = findNewerCredentialLimitEvent(sql, eventInput);
  if (newerCredentialEvent) {
    ensureProjectEventRetentionScheduled(sql, env, eventInput.projectId, Date.now());
    return finish({
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
    });
  }

  const eventId = generateId();
  const candidate = {
    ...eventInput,
    id: eventId,
    state: 'recorded' as const,
    duplicateCount: 0,
    conflictCount: 0,
    conflictFingerprint: null,
    conflictDetectedAt: null,
  };
  // Channel history, credential supersession and other sources retain their full history.
  // Existing stored receipts were checked above, even when the last subscriber has expired.
  const subscriptions =
    skipUnsubscribedGitHubCi && isGitHubCiProjectEvent(eventInput)
      ? matchingSubscriptionsForEvent(sql, candidate, Date.now(), limits, requireCompleteFanout)
      : null;
  if (subscriptions?.length === 0) {
    return finish({ outcome: 'skipped_no_subscriber', event: null, matches: [] });
  }
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
  const matches = subscriptions
    ? subscriptions.map((subscription) => insertMatchIfAbsent(sql, event, subscription, Date.now()))
    : createMatchesForEvent(sql, event, Date.now(), limits, requireCompleteFanout);
  ensureProjectEventRetentionScheduled(sql, env, eventInput.projectId, Date.now());
  return finish({ outcome: 'created', event, matches });
}
