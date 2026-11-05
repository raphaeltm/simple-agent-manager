import type { Env } from '../env';

export interface SessionRecoveryOptions {
  excludedNodeId?: string | null;
  evictionFence?: {
    workspaceId: string;
    nodeId: string;
    generation: string | null;
  };
  /**
   * Why the session wakes. A durable delivery wakes it to answer a queued message
   * (the default). `runtime_lost` means the runtime died mid-work and nothing is
   * queued, so interrupted work continues regardless of session mode.
   */
  wakeCause?: 'queued_message' | 'runtime_lost';
  /** Pre-stop evidence. Missing on older agents: reconcile rather than silently strand work. */
  interruptedWork?: boolean;
}

export async function evictionRecoveryFenceMatches(
  env: Env,
  fence: NonNullable<SessionRecoveryOptions['evictionFence']>
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS valid
       FROM workspaces
      WHERE id = ? AND node_id = ? AND eviction_generation IS ? AND status = 'evicted'`
  )
    .bind(fence.workspaceId, fence.nodeId, fence.generation)
    .first<{ valid: number }>();
  return row?.valid === 1;
}

/**
 * The fence guards replacement allocation. Once this exact wake restored the snapshot into
 * its own workspace (`completeSessionSnapshotRecovery`), the replacement exists and the
 * source may already be released for deletion (`releaseRestoredSourceWorkspaces`), so a
 * source that is no longer `evicted` must not revoke the wake that replaced it.
 */
export async function evictionRecoveryRestoredByRunner(
  env: Env,
  runner: { taskId: string; workspaceId: string; recoveryAttemptId: string | null }
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS restored
       FROM session_snapshots
      WHERE recovery_task_id = ? AND recovery_workspace_id = ? AND recovery_status = 'restored'
        AND recovery_attempt_id IS ?
      LIMIT 1`
  )
    .bind(runner.taskId, runner.workspaceId, runner.recoveryAttemptId)
    .first<{ restored: number }>();
  return row?.restored === 1;
}
