import type { Env } from '../env';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

export interface WorkspaceEvictionIdentity {
  nodeId: string;
  workspaceId: string;
  generation: string | null;
}

/** Called only inside NodeLifecycle's concurrency gate, including duplicate retries. */
export async function finalizeWorkspaceEvictionInNode(
  env: Env,
  identity: WorkspaceEvictionIdentity
): Promise<boolean> {
  const workspace = await env.DATABASE.prepare(
    `SELECT user_id, updated_at, eviction_finalized_at FROM workspaces
     WHERE id = ? AND node_id = ? AND eviction_generation IS ? AND status = 'evicted'`
  )
    .bind(identity.workspaceId, identity.nodeId, identity.generation)
    .first<{ user_id: string; updated_at: string; eviction_finalized_at: string | null }>();
  if (!workspace) return false;
  if (workspace.eviction_finalized_at) return true;

  const result = await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: [identity.workspaceId],
    userId: workspace.user_id,
    agentSessionStatus: 'stopped',
    nowIso: workspace.updated_at,
    reason: 'workspace_evicted',
  });
  if (result.projectSessionErrors > 0 || result.workspaceActivityErrors > 0) {
    throw new Error('Workspace eviction session cleanup must be retried');
  }
  // No side effects follow this marker. Restart's CAS requires it, so cleanup
  // cannot close a successor's sessions or metering after releasing the gate.
  const finalized = await env.DATABASE.prepare(
    `UPDATE workspaces SET eviction_finalized_at = ?
     WHERE id = ? AND node_id = ? AND eviction_generation IS ? AND status = 'evicted'`
  )
    .bind(new Date().toISOString(), identity.workspaceId, identity.nodeId, identity.generation)
    .run();
  return (finalized.meta.changes ?? 0) === 1;
}

export async function finalizeWorkspaceEvictionOnNode(
  env: Env,
  identity: WorkspaceEvictionIdentity
): Promise<boolean> {
  const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(identity.nodeId));
  return (
    stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle
  ).finalizeWorkspaceEviction(identity);
}
