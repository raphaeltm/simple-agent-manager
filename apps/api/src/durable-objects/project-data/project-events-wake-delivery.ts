import {
  type ProjectEventDeliveryAttemptState,
  type ProjectEventDeliveryBatchState,
} from '@simple-agent-manager/shared';

import { isProjectEventWakeEnabled } from './project-events-scheduler';
import {
  nextPhysicalAttemptNumber,
} from './project-events-storage-helpers';
import { stableStringify } from './project-events-values';
import {
  type PromptDeliveryClaim,
  type PromptDeliveryResult,
} from './prompt-delivery';
import type { Env } from './types';
import { generateId } from './types';

export const EVENT_WAKE_ADAPTER_ID = 'projectdata-prompt-queue';

export function readProjectEventWakeLeaseUntil(
  sql: SqlStorage,
  sessionId: string,
  now = Date.now()
): number | null {
  const pendingRow = sql
    .exec(
      `SELECT MIN(
                CASE
                  WHEN s.expires_at IS NULL THEN s.delivery_lifetime_expires_at
                  WHEN s.delivery_lifetime_expires_at IS NULL THEN s.expires_at
                  WHEN s.expires_at < s.delivery_lifetime_expires_at THEN s.expires_at
                  ELSE s.delivery_lifetime_expires_at
                END
              ) AS lease_until
       FROM project_event_subscriptions s
       WHERE s.target_session_id = ?
         AND s.contract_version >= 2
         AND s.owner_version >= 2
         AND s.owner_type = 'agent'
         AND s.owner_project_id = s.project_id
         AND s.owner_chat_session_id = s.target_session_id
         AND s.owner_task_id IS NOT NULL
         AND s.lifecycle_state = 'active'
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND s.delivery_lifetime_expires_at IS NOT NULL
         AND s.delivery_lifetime_expires_at > ?`,
      sessionId,
      now,
      now
    )
    .toArray()[0];
  const pendingLease =
    typeof pendingRow?.lease_until === 'number' && pendingRow.lease_until > now
      ? pendingRow.lease_until
      : null;

  const batchRow = sql
    .exec(
      `SELECT MIN(
                CASE
                  WHEN state = 'delivered' THEN readable_until
                  WHEN delivery_expires_at IS NOT NULL THEN delivery_expires_at
                  ELSE readable_until
                END
              ) AS lease_until
       FROM project_event_delivery_batches
       WHERE target_session_id = ?
         AND delivery_channel = 'prompt_queue'
         AND state IN ('pending', 'delivered')
         AND (
           (state = 'pending' AND delivery_expires_at IS NOT NULL AND delivery_expires_at > ?)
           OR (state = 'delivered' AND readable_until IS NOT NULL AND readable_until > ?)
         )`,
      sessionId,
      now,
      now
    )
    .toArray()[0];
  const batchLease =
    typeof batchRow?.lease_until === 'number' && batchRow.lease_until > now
      ? batchRow.lease_until
      : null;

  if (pendingLease === null) return batchLease;
  if (batchLease === null) return pendingLease;
  return Math.min(pendingLease, batchLease);
}

export function hasProjectEventWakeLease(
  sql: SqlStorage,
  sessionId: string,
  now = Date.now()
): boolean {
  return readProjectEventWakeLeaseUntil(sql, sessionId, now) !== null;
}


export interface ValidateProjectEventWakeRecoveryAuthorityInput {
  projectId: string;
  chatSessionId: string;
  sourceTaskId: string;
  batchId: string;
  subscriptionId: string;
}

export function validateProjectEventWakeRecoveryAuthority(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ValidateProjectEventWakeRecoveryAuthorityInput,
  now = Date.now()
): boolean {
  if (!storedProjectId || storedProjectId !== input.projectId || !isProjectEventWakeEnabled(env)) {
    return false;
  }
  const row = sql
    .exec(
      `SELECT b.id
       FROM project_event_delivery_batches b
       JOIN project_event_subscriptions s
         ON s.project_id = b.project_id AND s.id = b.subscription_id
       LEFT JOIN chat_sessions c ON c.id = b.target_session_id
       WHERE b.project_id = ?
         AND b.id = ?
         AND b.subscription_id = ?
         AND b.delivery_channel = 'prompt_queue'
         AND b.state = 'pending'
         AND b.target_session_id = ?
         AND (b.delivery_expires_at IS NULL OR b.delivery_expires_at > ?)
         AND s.lifecycle_state = 'active'
         AND s.owner_task_id = ?
         AND s.target_session_id = ?
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (s.delivery_lifetime_expires_at IS NULL OR s.delivery_lifetime_expires_at > ?)
         AND (c.status = 'active' OR c.status = 'sleeping')
       LIMIT 1`,
      input.projectId,
      input.batchId,
      input.subscriptionId,
      input.chatSessionId,
      now,
      input.sourceTaskId,
      input.chatSessionId,
      now,
      now
    )
    .toArray()[0];
  return Boolean(row);
}

export function invalidProjectEventWakeDeliveryTargetResult(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim,
  now = Date.now()
): PromptDeliveryResult | null {
  if (claim.message.sourceKind !== 'project_event_wake') return null;
  if (!projectId || !isProjectEventWakeEnabled(env)) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: !projectId
        ? 'Project event wake has no project identity'
        : 'Project event wake delivery is disabled',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const row = sql
    .exec(
      `SELECT b.id,
              b.target_session_id,
              b.delivery_expires_at,
              s.lifecycle_state,
              s.owner_task_id,
              s.expires_at,
              s.delivery_lifetime_expires_at,
              c.status AS chat_status
       FROM project_event_delivery_batches b
       JOIN project_event_subscriptions s
         ON s.project_id = b.project_id AND s.id = b.subscription_id
       LEFT JOIN chat_sessions c ON c.id = b.target_session_id
       WHERE b.project_id = ?
         AND b.id = ?
         AND b.delivery_channel = 'prompt_queue'
         AND b.state = 'pending'
       LIMIT 1`,
      projectId,
      claim.message.id
    )
    .toArray()[0];
  if (!row) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Project event wake batch is no longer pending',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const targetSessionId = typeof row.target_session_id === 'string' ? row.target_session_id : null;
  const expiresAt = typeof row.delivery_expires_at === 'number' ? row.delivery_expires_at : null;
  const subscriptionExpiresAt = typeof row.expires_at === 'number' ? row.expires_at : null;
  const lifetimeExpiresAt =
    typeof row.delivery_lifetime_expires_at === 'number' ? row.delivery_lifetime_expires_at : null;
  const chatStatus = typeof row.chat_status === 'string' ? row.chat_status : null;
  const ownerTaskId = typeof row.owner_task_id === 'string' ? row.owner_task_id : null;
  if (
    targetSessionId !== claim.message.targetSessionId ||
    ownerTaskId !== claim.message.sourceTaskId ||
    row.lifecycle_state !== 'active' ||
    (expiresAt !== null && expiresAt <= now) ||
    (subscriptionExpiresAt !== null && subscriptionExpiresAt <= now) ||
    (lifetimeExpiresAt !== null && lifetimeExpiresAt <= now) ||
    (chatStatus !== 'active' && chatStatus !== 'sleeping')
  ) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error:
        targetSessionId !== claim.message.targetSessionId
          ? 'Project event wake target session binding changed'
          : ownerTaskId !== claim.message.sourceTaskId
            ? 'Project event wake source task binding changed'
          : row.lifecycle_state !== 'active'
            ? 'Project event wake subscription is no longer active'
            : chatStatus !== 'active' && chatStatus !== 'sleeping'
              ? 'Project event wake target session is no longer active'
              : 'Project event wake delivery lease expired',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  return null;
}

export function advanceProjectEventPromptAttemptCheckpoint(
  sql: SqlStorage,
  projectId: string | null,
  claim: PromptDeliveryClaim,
  result: PromptDeliveryResult,
  now = Date.now()
): void {
  if (!projectId || claim.message.sourceKind !== 'project_event_wake') return;
  const batchId = claim.message.id;
  const batch = sql
    .exec(
      `SELECT id, delivery_channel
       FROM project_event_delivery_batches
       WHERE project_id = ? AND id = ?
       LIMIT 1`,
      projectId,
      batchId
    )
    .toArray()[0];
  if (!batch || batch.delivery_channel !== 'prompt_queue') return;

  const attemptState = attemptStateForPromptResult(result);
  const idempotencyKey = `mailbox:${claim.attemptId}`;
  const attemptNumber = nextPhysicalAttemptNumber(sql, projectId, batchId);
  sql.exec(
    `INSERT OR IGNORE INTO project_event_delivery_attempts
     (id, project_id, batch_id, idempotency_key, idempotency_fingerprint, attempt_number,
      state, transport_state, adapter, protocol_version, runtime_id, receipt_id,
      error_code, error_message, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    generateId(),
    projectId,
    batchId,
    idempotencyKey,
    stableStringify([projectId, batchId, idempotencyKey, result.kind, claim.mode]),
    attemptNumber,
    attemptState,
    result.kind === 'retry' ? 'queued' : null,
    EVENT_WAKE_ADAPTER_ID,
    result.capabilities ? String(result.capabilities.protocolVersion) : null,
    result.runtimeIdentity,
    result.kind === 'accepted' || result.kind === 'ambiguous'
      ? (result.receipt?.deliveryId ?? null)
      : null,
    'reason' in result ? result.reason : null,
    'error' in result ? result.error : null,
    claim.message.lastDeliveryAt ?? now,
    now,
    now
  );
  updatePromptQueueBatchForAttempt(sql, projectId, batchId, attemptState, result, now);
}

function attemptStateForPromptResult(
  result: PromptDeliveryResult
): ProjectEventDeliveryAttemptState {
  switch (result.kind) {
    case 'accepted':
      return 'accepted';
    case 'retry':
      return 'retry';
    case 'failed':
      return 'failed';
    case 'ambiguous':
      return 'ambiguous';
  }
}

function batchStateForPromptAttempt(
  attemptState: ProjectEventDeliveryAttemptState
): ProjectEventDeliveryBatchState {
  switch (attemptState) {
    case 'accepted':
      return 'delivered';
    case 'retry':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'ambiguous':
      return 'ambiguous';
    case 'recorded_not_injected':
      return 'recorded_not_injected';
  }
}

function updatePromptQueueBatchForAttempt(
  sql: SqlStorage,
  projectId: string,
  batchId: string,
  attemptState: ProjectEventDeliveryAttemptState,
  result: PromptDeliveryResult,
  now: number
): void {
  const batchState = batchStateForPromptAttempt(attemptState);
  if (attemptState === 'retry') {
    sql.exec(
      `UPDATE project_event_delivery_batches
       SET state = 'pending', updated_at = ?, terminal_reason = ?
       WHERE project_id = ?
         AND id = ?
         AND delivery_channel = 'prompt_queue'
         AND state = 'pending'`,
      now,
      'error' in result ? result.error : null,
      projectId,
      batchId
    );
    return;
  }
  sql.exec(
    `UPDATE project_event_delivery_batches
     SET state = ?,
         delivered_via = CASE WHEN ? THEN 'prompt_queue' ELSE delivered_via END,
         delivered_at = CASE WHEN ? THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
         updated_at = ?,
         terminal_at = COALESCE(terminal_at, ?),
         terminal_reason = ?
     WHERE project_id = ?
       AND id = ?
       AND delivery_channel = 'prompt_queue'
       AND state NOT IN ('acked', 'cancelled', 'expired')`,
    batchState,
    attemptState === 'accepted' ? 1 : 0,
    attemptState === 'accepted' ? 1 : 0,
    now,
    now,
    now,
    attemptState === 'accepted'
      ? 'prompt accepted by runtime'
      : 'error' in result
        ? result.error
        : result.kind,
    projectId,
    batchId
  );
}
