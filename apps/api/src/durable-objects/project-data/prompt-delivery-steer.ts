/**
 * Applying live-steer outcomes to the durable inbox (idea 01M2EPH9WGDYFDQBZCP9QY1FDE).
 *
 * A steer is claimed on its own lane (`prompt-delivery.ts`). Its outcomes differ from a
 * prompt's: acceptance attaches to the running turn and starts no prompt epoch, and a
 * steer the runtime never consumed becomes an ordinary next-turn message instead of
 * being retried as a steer. An unconfirmed steer is terminal and surfaced, never
 * replayed (`applyPromptDeliveryResult` handles `ambiguous` for both lanes).
 */
import type { VmPromptDeliveryCapabilities, VmSteerReceipt } from '@simple-agent-manager/shared';

import type { PromptDeliveryClaim } from './prompt-delivery';

const MAX_STEER_REASON_LENGTH = 256;

export type SteerDeliveryResult =
  | {
      kind: 'steered';
      /** Start of the prompt turn the steer attached to, when the runtime reported it. */
      promptEpoch: number | null;
      runtimeIdentity: string;
      capabilities: VmPromptDeliveryCapabilities;
      receipt: VmSteerReceipt | null;
    }
  | {
      kind: 'steer_fallback';
      /** Machine-readable cause, shown to the sender (e.g. `no_running_turn`). */
      reason: string;
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
    }
  | {
      kind: 'steer_pending';
      /** The VM is still deciding; the claim stays leased and reconciles by receipt lookup. */
      reason: string;
      error: string;
      runtimeIdentity: string | null;
      capabilities: VmPromptDeliveryCapabilities | null;
    };

export function isSteerDeliveryResult(result: { kind: string }): result is SteerDeliveryResult {
  return (
    result.kind === 'steered' || result.kind === 'steer_fallback' || result.kind === 'steer_pending'
  );
}

/**
 * What the transcript row shows about a steer, durably across reloads. `unconfirmed`
 * is a steer the runtime may or may not have taken (the inbox row is `ambiguous`).
 */
export type TranscriptSteerOutcome = 'steered' | 'queued_fallback' | 'unconfirmed';

export function labelSteerOutcomeOnTranscript(
  sql: SqlStorage,
  claim: PromptDeliveryClaim,
  outcome: TranscriptSteerOutcome,
  reason: string | null
): void {
  sql.exec(
    `UPDATE chat_messages
        SET tool_metadata = json_set(COALESCE(tool_metadata, '{}'),
          '$.steerOutcome', ?, '$.steerReason', ?)
      WHERE id = ? AND session_id = ? AND json_valid(COALESCE(tool_metadata, '{}'))`,
    outcome,
    reason === null ? null : boundedReason(reason),
    claim.message.promptMessageId,
    claim.message.targetSessionId
  );
}

function boundedReason(reason: string): string {
  return reason.trim().slice(0, MAX_STEER_REASON_LENGTH) || 'unknown';
}

/** Fenced on the claim's attempt, like every other delivery result. */
export function applySteerDeliveryResult(
  sql: SqlStorage,
  claim: PromptDeliveryClaim,
  result: SteerDeliveryResult,
  now = Date.now()
): boolean {
  if (result.kind === 'steer_pending') {
    // Leave the row `delivering`: the stale-claim sweep reclaims it in reconcile mode.
    return (
      sql
        .exec(
          `SELECT 1 FROM session_inbox WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?`,
          claim.message.id,
          claim.attemptId
        )
        .toArray().length > 0
    );
  }
  if (result.kind === 'steered') {
    // No prompt epoch, no target backoff change: the running turn still owns both.
    const applied =
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
             adapter_protocol_version = ?,
             steer_outcome = 'steered',
             steer_reason = NULL
         WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?
           AND delivery_intent = 'steer'`,
        now,
        now,
        result.promptEpoch ?? now,
        result.runtimeIdentity,
        result.capabilities.steering?.version ?? null,
        claim.message.id,
        claim.attemptId
      ).rowsWritten > 0;
    if (applied) labelSteerOutcomeOnTranscript(sql, claim, 'steered', null);
    return applied;
  }
  // Not consumed: hand the message to the queue lane as a normal next-turn prompt. It
  // keeps its delivery ID and transcript row; the VM tracks steer and prompt receipts
  // separately, so the later prompt delivery is not a conflict.
  const applied =
    sql.exec(
      `UPDATE session_inbox
       SET delivery_intent = 'queue',
           delivery_state = 'queued',
           prompt_delivery_phase = NULL,
           wake_ready_attempt_id = NULL,
           delivery_attempts = 0,
           attempt_id = NULL,
           attempt_started_at = NULL,
           next_attempt_at = ?,
           last_error = NULL,
           runtime_identity = COALESCE(?, runtime_identity),
           steer_outcome = 'queued_fallback',
           steer_reason = ?
       WHERE id = ? AND delivery_state = 'delivering' AND attempt_id = ?
         AND delivery_intent = 'steer'`,
      now,
      result.runtimeIdentity,
      boundedReason(result.reason),
      claim.message.id,
      claim.attemptId
    ).rowsWritten > 0;
  if (applied) labelSteerOutcomeOnTranscript(sql, claim, 'queued_fallback', result.reason);
  return applied;
}
