import type { Env } from '../env';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

export interface WorkspaceEvictionIdentity {
  nodeId: string;
  workspaceId: string;
  generation: string | null;
}

export interface WorkspaceStopIdentity extends WorkspaceEvictionIdentity {
  userId: string;
  projectId: string | null;
  chatSessionId: string | null;
  claimedAt: string;
}

/** Shares eviction's DO gate so a late Stop cannot close a restarted runtime. */
export async function finalizeWorkspaceStopInNode(
  env: Env,
  identity: WorkspaceStopIdentity
): Promise<boolean> {
  const predicate = `id = ? AND node_id = ? AND eviction_generation IS ? AND user_id = ?
    AND project_id IS ? AND chat_session_id IS ? AND updated_at = ?
    AND status = 'stopping' AND stop_runtime_confirmed_at IS NOT NULL
    AND runtime_deletion_confirmed_at IS NULL`;
  const bindings = [
    identity.workspaceId,
    identity.nodeId,
    identity.generation,
    identity.userId,
    identity.projectId,
    identity.chatSessionId,
    identity.claimedAt,
  ];
  if (
    !(await env.DATABASE.prepare(`SELECT id FROM workspaces WHERE ${predicate}`)
      .bind(...bindings)
      .first())
  )
    return false;
  // Cancel an obsolete sleep claim without deleting its recoverable artifacts.
  // Otherwise the canonical finalizer treats scheduled sleep as still active
  // and leaves ProjectData sessions running after an explicit Stop.
  await env.DATABASE.prepare(
    `UPDATE session_snapshots SET sleep_status = NULL, sleep_after = NULL,
    sleep_claim_id = NULL, sleep_claimed_at = NULL, sleep_stopping_since = NULL,
    sleep_error = NULL, updated_at = ?
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE ${predicate})
      AND sleeping_at IS NULL AND sleep_status IN ('scheduled', 'preparing', 'failed')`
  )
    .bind(identity.claimedAt, ...bindings)
    .run();
  const result = await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: [identity.workspaceId],
    userId: identity.userId,
    agentSessionStatus: 'stopped',
    nowIso: identity.claimedAt,
    reason: 'workspace_stop',
  });
  if (result.projectSessionErrors > 0 || result.workspaceActivityErrors > 0) {
    throw new Error('Workspace stop session cleanup must be retried');
  }
  // The stopped container and any snapshot remain recoverable. Eviction may
  // claim D1 while this gate is held, but its finalizer cannot release restart
  // until this closure completes. Never overwrite that eviction claim.
  const transition = await env.DATABASE.prepare(
    `UPDATE workspaces SET status = 'stopped', error_message = NULL, updated_at = ? WHERE ${predicate}`
  )
    .bind(new Date().toISOString(), ...bindings)
    .run();
  return (transition.meta.changes ?? 0) === 1;
}

export async function finalizeWorkspaceStopOnNode(
  env: Env,
  identity: WorkspaceStopIdentity
): Promise<boolean> {
  const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(identity.nodeId));
  return (
    stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle
  ).finalizeWorkspaceStop(identity);
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
