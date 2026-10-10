import { isSessionRecoverySourceTaskGuardValid } from '../../services/session-recovery-authority';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

/**
 * A checkpoint continuation tells a restored task-mode agent to continue its task
 * (`services/restored-session-prompt.ts`). It stays valid only while that task is live and still
 * owns the chat: the source-task guard a re-wake of the chat uses (`sourceTaskGuardForClaim`).
 * Checking it before any side effect drops a stopped or finished task's continuation as a
 * terminal target, instead of letting the wake path refuse it as a misleading wake failure.
 */
export async function invalidCheckpointContinuationTarget(
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
