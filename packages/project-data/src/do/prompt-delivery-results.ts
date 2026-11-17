import type {
  VmPromptDeliveryCapabilities,
  VmPromptDeliveryReceipt,
} from '@simple-agent-manager/shared';

import { type DurableExecutionConfig, promptDeliveryBackoffMs } from './durable-execution-config';
import type { PromptDeliveryClaim } from './prompt-delivery';
import {
  applySteerDeliveryResult,
  isSteerDeliveryResult,
  type SteerDeliveryResult,
} from './prompt-delivery-steer';

const MAX_DELIVERY_ERROR_LENGTH = 2048;

function boundedError(value: string): string {
  return value.trim().slice(0, MAX_DELIVERY_ERROR_LENGTH) || 'Unknown prompt delivery error';
}

export interface AcceptedDeliveryResult {
  kind: 'accepted';
  acpSessionId: string;
  promptEpoch: number;
  runtimeIdentity: string;
  capabilities: VmPromptDeliveryCapabilities;
  receipt: VmPromptDeliveryReceipt | null;
}

export type PromptDeliveryResult =
  | AcceptedDeliveryResult
  | SteerDeliveryResult
  | {
      kind: 'retry';
      reason: 'busy' | 'not_ready' | 'receipt_not_found';
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
    }
  | {
      kind: 'failed';
      reason:
        | 'terminal_target'
        | 'dead_target'
        | 'wake_refused'
        | 'unsupported_capability'
        | 'delivery_conflict'
        // The human sender is no longer the session owner or an active grantee.
        | 'sender_unauthorized';
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
    }
  | {
      kind: 'ambiguous';
      reason: 'lost_response' | 'runtime_changed' | 'receipt_unavailable';
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
      receipt: VmPromptDeliveryReceipt | null;
    };

function capabilitiesColumns(capabilities: VmPromptDeliveryCapabilities | null): {
  protocolVersion: number | null;
  receiptSupported: number | null;
} {
  return {
    protocolVersion: capabilities?.protocolVersion ?? null,
    receiptSupported: capabilities ? (capabilities.promptReceipts.supported ? 1 : 0) : null,
  };
}

export function applyPromptDeliveryResult(
  sql: SqlStorage,
  claim: PromptDeliveryClaim,
  result: PromptDeliveryResult,
  config: DurableExecutionConfig,
  now = Date.now()
): boolean {
  // Results may race a reclaimed/expired attempt. Fence before touching the
  // shared target backoff, not only before updating the individual message.
  const current = sql
    .exec(
      `SELECT wake_ready_attempt_id, prompt_delivery_phase FROM session_inbox
      WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
      claim.message.id,
      claim.attemptId
    )
    .toArray()[0];
  if (!current) return false;
  if (isSteerDeliveryResult(result)) return applySteerDeliveryResult(sql, claim, result, now);
  const nudgedWhilePreparing =
    current.wake_ready_attempt_id === claim.attemptId &&
    current.prompt_delivery_phase === 'preparing';
  const capability = capabilitiesColumns(result.capabilities);
  if (result.kind === 'accepted') {
    sql.exec(
      'DELETE FROM prompt_delivery_target_backoff WHERE target_session_id = ?',
      claim.message.targetSessionId
    );
    return (
      sql.exec(
        `UPDATE session_inbox
       SET delivery_state = CASE WHEN ack_required = 1 THEN 'delivered' ELSE 'acked' END,
           delivered_at = COALESCE(delivered_at, ?),
           acked_at = CASE WHEN ack_required = 0 THEN COALESCE(acked_at, ?) ELSE acked_at END,
           accepted_at = COALESCE(accepted_at, ?),
           next_attempt_at = NULL,
           last_error = NULL,
           terminal_reason = NULL,
           runtime_identity = ?,
           receipt_state = ?,
           receipt_runtime_identity = ?,
           receipt_checked_at = ?,
           adapter_protocol_version = ?,
           receipt_supported = ?
       WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
        now,
        now,
        result.promptEpoch,
        result.runtimeIdentity,
        result.receipt?.state ?? 'accepted',
        result.receipt?.runtimeIdentity ?? result.runtimeIdentity,
        now,
        capability.protocolVersion,
        capability.receiptSupported,
        claim.message.id,
        claim.attemptId
      ).rowsWritten > 0
    );
  }

  if (result.kind === 'retry') {
    let nextAttemptAt =
      now + promptDeliveryBackoffMs(Math.max(1, claim.message.deliveryAttempts), config);
    if (result.reason === 'busy' && !nudgedWhilePreparing) {
      const previous = sql
        .exec(
          'SELECT busy_attempts FROM prompt_delivery_target_backoff WHERE target_session_id = ?',
          claim.message.targetSessionId
        )
        .toArray()[0];
      const busyAttempts = Number(previous?.busy_attempts ?? 0) + 1;
      nextAttemptAt = now + promptDeliveryBackoffMs(busyAttempts, config);
      sql.exec(
        `INSERT INTO prompt_delivery_target_backoff
          (target_session_id, busy_attempts, next_attempt_at, message_priority)
          SELECT target_session_id, ?, ?, CASE message_class
            WHEN 'shutdown_with_final_prompt' THEN 5 WHEN 'preempt_and_replan' THEN 4
            WHEN 'interrupt' THEN 3 WHEN 'deliver' THEN 2 WHEN 'notify' THEN 1 ELSE 0 END
          FROM session_inbox WHERE id = ?
          ON CONFLICT(target_session_id) DO UPDATE SET
            busy_attempts = excluded.busy_attempts,
            next_attempt_at = excluded.next_attempt_at,
            message_priority = excluded.message_priority`,
        busyAttempts,
        nextAttemptAt,
        claim.message.id
      );
    }
    // A retry result means the target is alive but temporarily unavailable
    // (for example, a replacement VM is still installing/loading its agent).
    // Do not let that readiness wait become a permanent max-attempts failure:
    // retain the capped attempt ordinal for backoff, while the delivery TTL
    // remains the hard bound. Rows stranded at the cap without an applied
    // result are still failed by expireDuePromptDeliveries above.
    const retryAttemptOrdinal = Math.max(0, config.maxAttempts - 1);
    return (
      sql.exec(
        `UPDATE session_inbox
       SET delivery_state = 'retry_wait',
           delivery_attempts = MIN(delivery_attempts, ?),
           next_attempt_at = CASE WHEN wake_ready_attempt_id = attempt_id
             AND prompt_delivery_phase = 'preparing' AND ? IN ('not_ready', 'busy') THEN ? ELSE ? END,
           wake_ready_attempt_id = NULL,
           last_error = ?,
           runtime_identity = COALESCE(?, runtime_identity),
           adapter_protocol_version = ?,
           receipt_supported = ?
       WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
        retryAttemptOrdinal,
        result.reason,
        now,
        nextAttemptAt,
        boundedError(result.error),
        result.runtimeIdentity,
        capability.protocolVersion,
        capability.receiptSupported,
        claim.message.id,
        claim.attemptId
      ).rowsWritten > 0
    );
  }

  const state = result.kind === 'failed' ? 'failed' : 'ambiguous';
  return (
    sql.exec(
      `UPDATE session_inbox
     SET delivery_state = ?,
         terminal_reason = ?,
         last_error = ?,
         next_attempt_at = NULL,
         runtime_identity = COALESCE(?, runtime_identity),
         receipt_state = ?,
         receipt_runtime_identity = ?,
         receipt_checked_at = ?,
         adapter_protocol_version = ?,
         receipt_supported = ?
     WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
      state,
      result.reason,
      boundedError(result.error),
      result.runtimeIdentity,
      result.kind === 'ambiguous' ? (result.receipt?.state ?? 'ambiguous') : null,
      result.kind === 'ambiguous' ? (result.receipt?.runtimeIdentity ?? null) : null,
      result.kind === 'ambiguous' ? now : null,
      capability.protocolVersion,
      capability.receiptSupported,
      claim.message.id,
      claim.attemptId
    ).rowsWritten > 0
  );
}
