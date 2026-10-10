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
   * queued, so a task-mode agent is told to continue its task instead of waiting.
   */
  wakeCause?: 'queued_message' | 'runtime_lost';
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
