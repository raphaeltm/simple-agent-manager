import type { Env } from '../env';
import { WORKSPACE_DELETION_DIAGNOSTIC_PREFIX } from './workspace-deletion';

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
            w.error_message AS workspaceErrorMessage,
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
      workspaceErrorMessage: string | null;
      nodeId: string | null;
      runtimeTerminationConfirmedAt: string | null;
    }>();

  if (row?.workspaceId && row.runtimeTerminationConfirmedAt) return;
  if (row?.workspaceId && row.nodeId && env.NODE_LIFECYCLE) {
    const stub = env.NODE_LIFECYCLE.get(
      env.NODE_LIFECYCLE.idFromName(row.nodeId)
    ) as DurableObjectStub<import('../durable-objects/node-lifecycle').NodeLifecycle>;
    const attempt = await stub.getWorkspaceDeletionAttemptState(row.workspaceId);
    if (attempt.attemptStarted) throw new WorkspaceDeletionUnconfirmedError(row.workspaceId);
  }

  if (
    !row?.workspaceId ||
    row.workspaceStatus !== 'stopping' ||
    !row.workspaceErrorMessage?.startsWith(WORKSPACE_DELETION_DIAGNOSTIC_PREFIX) ||
    row.runtimeTerminationConfirmedAt
  ) {
    return;
  }
  throw new WorkspaceDeletionUnconfirmedError(row.workspaceId);
}
