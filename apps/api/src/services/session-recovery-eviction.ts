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
 * its own workspace (`completeSessionSnapshotRecovery`), the source of that exact generation
 * may already be in teardown (its receipt is stamped at restore, `releaseRestoredSourceWorkspaces`,
 * and the stale-stopped sweep selects a restored source), and that release must not revoke the
 * wake that replaced it. The generation is what discriminates: an explicit Restart always mints a
 * new one (`routes/workspaces/lifecycle.ts`), and the wake must still lose to it. Deletion keeps
 * the generation through `stopping` and `deleted`, so no status is required here.
 */
export async function evictionRecoveryRestoredByRunner(
  env: Env,
  runner: { taskId: string; workspaceId: string; recoveryAttemptId: string | null },
  fence: NonNullable<SessionRecoveryOptions['evictionFence']>
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS restored
       FROM session_snapshots s
       JOIN workspaces source ON source.id = ? AND source.node_id = ?
        AND source.eviction_generation IS ?
      WHERE s.recovery_task_id = ? AND s.recovery_workspace_id = ? AND s.recovery_status = 'restored'
        AND s.recovery_attempt_id IS ?
      LIMIT 1`
  )
    .bind(
      fence.workspaceId,
      fence.nodeId,
      fence.generation,
      runner.taskId,
      runner.workspaceId,
      runner.recoveryAttemptId
    )
    .first<{ restored: number }>();
  return row?.restored === 1;
}
