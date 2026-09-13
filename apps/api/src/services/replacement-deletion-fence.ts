import type { Env } from '../env';

export class WorkspaceDeletionUnconfirmedError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Replacement is fenced while workspace ${workspaceId} deletion is unconfirmed`);
    this.name = 'WorkspaceDeletionUnconfirmedError';
  }
}

/**
 * Refuse linked replacement/recovery while its predecessor runtime may still
 * exist. The node lifecycle label is intentionally ignored; only the strict
 * provider/container marker can release a still-stopping workspace.
 */
export async function assertReplacementDeletionConfirmed(
  env: Env,
  input: { sourceTaskId: string; projectId: string; userId: string }
): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT w.id AS workspaceId,
            w.status AS workspaceStatus,
            w.runtime_deletion_confirmed_at AS runtimeDeletionConfirmedAt,
            w.node_id AS nodeId,
            n.runtime_termination_confirmed_at AS runtimeTerminationConfirmedAt
       FROM tasks t
       LEFT JOIN workspaces w ON w.id = t.workspace_id
       LEFT JOIN nodes n ON n.id = w.node_id
      WHERE t.id = ?
        AND t.project_id = ?
        AND t.user_id = ?
      LIMIT 1`
  )
    .bind(input.sourceTaskId, input.projectId, input.userId)
    .first<{
      workspaceId: string | null;
      workspaceStatus: string | null;
      runtimeDeletionConfirmedAt: string | null;
      nodeId: string | null;
      runtimeTerminationConfirmedAt: string | null;
    }>();

  if (row?.workspaceId && (row.runtimeDeletionConfirmedAt || row.runtimeTerminationConfirmedAt)) {
    return;
  }
  if (row?.workspaceId && row.nodeId && env.NODE_LIFECYCLE) {
    const stub = env.NODE_LIFECYCLE.get(
      env.NODE_LIFECYCLE.idFromName(row.nodeId)
    ) as DurableObjectStub<import('../durable-objects/node-lifecycle').NodeLifecycle>;
    const attempt = await stub.getWorkspaceDeletionAttemptState(row.workspaceId);
    if (attempt.pending) throw new WorkspaceDeletionUnconfirmedError(row.workspaceId);
  }

  if (!row?.workspaceId || row.runtimeDeletionConfirmedAt || row.runtimeTerminationConfirmedAt) {
    return;
  }
  if (row.workspaceStatus === 'stopping') {
    throw new WorkspaceDeletionUnconfirmedError(row.workspaceId);
  }
  // A legacy `deleted` label is not deletion proof. Older teardown paths could
  // write it after provider failure, so existing tombstones fail closed too.
  if (row.workspaceStatus === 'deleted') {
    throw new WorkspaceDeletionUnconfirmedError(row.workspaceId);
  }
}
