import { isSessionRecoverySourceTaskGuardValid } from '../../services/session-recovery-authority';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

/**
 * Whether a later wake queued its own continuation for this chat. Each runtime loss queues one,
 * so an older one still waiting would make the agent hear "continue your task" twice. Same-class
 * deliveries to one target are claimed oldest first (`noEarlierDeliverySql`), so the older one is
 * always the one checked while the newer one is still active.
 */
function hasNewerContinuation(sql: SqlStorage, claim: PromptDeliveryClaim): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM session_inbox INDEXED BY idx_inbox_active_target_head
          WHERE target_session_id = ?
            AND delivery_state IN ('queued', 'retry_wait', 'delivering')
            AND source_kind = 'checkpoint_continuation'
            AND id != ?
            AND created_at > ?
          LIMIT 1`,
        claim.message.targetSessionId,
        claim.message.id,
        claim.message.createdAt
      )
      .toArray().length > 0
  );
}

/**
 * A checkpoint continuation tells a restored task-mode agent to continue its task
 * (`services/restored-session-prompt.ts`). It stays valid only while it is the chat's latest
 * continuation and its task is live and still owns the chat: the source-task guard a re-wake of
 * the chat uses (`sourceTaskGuardForClaim`). Checking it before any side effect drops a stale,
 * stopped or finished task's continuation as a terminal target, instead of letting the wake path
 * refuse it as a misleading wake failure.
 */
export async function invalidCheckpointContinuationTarget(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim
): Promise<PromptDeliveryResult | null> {
  if (claim.message.sourceKind !== 'checkpoint_continuation') return null;
  const invalid = (error: string): PromptDeliveryResult => ({
    kind: 'failed',
    reason: 'terminal_target',
    error,
    runtimeIdentity: claim.message.runtimeIdentity,
    capabilities: null,
  });
  if (!projectId || !claim.message.sourceTaskId) {
    return invalid('Checkpoint continuation has no task identity');
  }
  if (hasNewerContinuation(sql, claim)) {
    return invalid('Checkpoint continuation was superseded by a later wake');
  }
  try {
    const live = await isSessionRecoverySourceTaskGuardValid(env.DATABASE, {
      taskId: claim.message.sourceTaskId,
      projectId,
      chatSessionId: claim.message.targetSessionId,
    });
    return live ? null : invalid('Checkpoint continuation task is no longer live for this chat');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claim.mode === 'reconcile') {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: `Checkpoint continuation task check failed during receipt reconciliation: ${message}`,
        runtimeIdentity: claim.message.runtimeIdentity,
        capabilities: null,
        receipt: null,
      };
    }
    return {
      kind: 'retry',
      reason: 'not_ready',
      error: `Checkpoint continuation task check temporarily failed: ${message}`,
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
}
