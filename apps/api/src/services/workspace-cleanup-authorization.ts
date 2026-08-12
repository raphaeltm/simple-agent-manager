import type { Env } from '../env';
import { log } from '../lib/logger';

const ACTIVE_TASK_STATUSES_SQL = "'queued', 'delegated', 'in_progress'";

export const ACTIVE_WORKSPACE_STATUSES = new Set([
  'running',
  'creating',
  'pending',
  'recovery',
  'sleeping',
]);

export function hasAuthorizedWorkspaceSessionLink(
  taskChatSessionId: string | null,
  workspaceChatSessionId: string | null,
  taskMode: string | null,
  taskUserId: string | null,
  workspaceUserId: string | null,
  callerScoped: boolean
): boolean {
  if (!taskChatSessionId) return true;

  if (taskMode === 'conversation') {
    return (
      workspaceChatSessionId === taskChatSessionId &&
      taskUserId !== null &&
      workspaceUserId !== null &&
      taskUserId === workspaceUserId
    );
  }

  if (workspaceChatSessionId !== null && workspaceChatSessionId !== taskChatSessionId) {
    return false;
  }

  if (callerScoped && workspaceUserId === null) {
    return false;
  }

  return true;
}

export interface WorkspaceCleanupClaim {
  workspaceId: string;
  nodeId: string;
  userId: string;
  projectId?: string | null;
  previousStatus: string;
}

export interface WorkspaceCleanupClaimInput {
  workspaceId: string;
  nodeId: string;
  userId: string;
  projectId?: string | null;
  allowedStatuses: readonly string[];
  taskId?: string | null;
  source: string;
}

interface WorkspaceClaimRow {
  id: string;
  node_id: string | null;
  user_id: string;
  project_id: string | null;
  status: string;
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

export async function claimWorkspaceForCleanup(
  env: Pick<Env, 'DATABASE'>,
  input: WorkspaceCleanupClaimInput
): Promise<WorkspaceCleanupClaim | null> {
  if (input.allowedStatuses.length === 0) {
    throw new Error('claimWorkspaceForCleanup requires at least one allowed status');
  }

  const row = await env.DATABASE.prepare(
    `SELECT id, node_id, user_id, project_id, status
     FROM workspaces
     WHERE id = ?
     LIMIT 1`
  )
    .bind(input.workspaceId)
    .first<WorkspaceClaimRow>();

  if (
    !row ||
    row.id !== input.workspaceId ||
    row.node_id !== input.nodeId ||
    row.user_id !== input.userId ||
    (input.projectId !== undefined && row.project_id !== input.projectId) ||
    !input.allowedStatuses.includes(row.status)
  ) {
    log.info('workspace.cleanup_claim_rejected', {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      userId: input.userId,
      projectId: input.projectId,
      source: input.source,
      observedStatus: row?.status ?? null,
      action: 'skipped',
    });
    return null;
  }

  const now = new Date().toISOString();
  const taskExclusion = input.taskId ? 'AND active.id != ?' : '';
  const projectPredicate =
    input.projectId === undefined
      ? ''
      : 'AND ((project_id = ?) OR (project_id IS NULL AND ? IS NULL))';
  const args: unknown[] = [
    now,
    input.workspaceId,
    input.nodeId,
    input.userId,
    row.status,
    ...input.allowedStatuses,
  ];
  if (input.projectId !== undefined) {
    args.splice(4, 0, input.projectId, input.projectId);
  }
  if (input.taskId) args.push(input.taskId);

  const result = await env.DATABASE.prepare(
    `UPDATE workspaces
     SET status = 'stopping', updated_at = ?
     WHERE id = ?
       AND node_id = ?
       AND user_id = ?
       ${projectPredicate}
       AND status = ?
       AND status IN (${placeholders(input.allowedStatuses)})
       AND NOT EXISTS (
         SELECT 1 FROM tasks active
         WHERE active.workspace_id = workspaces.id
           AND active.project_id IS workspaces.project_id
           AND active.status IN (${ACTIVE_TASK_STATUSES_SQL})
           ${taskExclusion}
       )`
  )
    .bind(...args)
    .run();

  if (!result.meta.changes || result.meta.changes === 0) {
    log.info('workspace.cleanup_claim_conflict', {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      userId: input.userId,
      projectId: input.projectId,
      source: input.source,
      action: 'skipped',
    });
    return null;
  }

  return {
    workspaceId: row.id,
    nodeId: input.nodeId,
    userId: row.user_id,
    projectId: row.project_id,
    previousStatus: row.status,
  };
}

export async function completeWorkspaceCleanupClaim(
  env: Pick<Env, 'DATABASE'>,
  claim: WorkspaceCleanupClaim,
  status: 'stopped' | 'deleted',
  extra?: { errorMessage?: string | null }
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE workspaces
     SET status = ?, error_message = ?, updated_at = ?
     WHERE id = ? AND node_id = ? AND user_id = ? AND status = 'stopping'`
  )
    .bind(
      status,
      extra?.errorMessage ?? null,
      new Date().toISOString(),
      claim.workspaceId,
      claim.nodeId,
      claim.userId
    )
    .run();

  return Boolean(result.meta.changes && result.meta.changes > 0);
}

export async function restoreWorkspaceCleanupClaim(
  env: Pick<Env, 'DATABASE'>,
  claim: WorkspaceCleanupClaim,
  errorMessage?: string | null
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE workspaces
     SET status = ?, error_message = COALESCE(?, error_message), updated_at = ?
     WHERE id = ? AND node_id = ? AND user_id = ? AND status = 'stopping'`
  )
    .bind(
      claim.previousStatus,
      errorMessage ?? null,
      new Date().toISOString(),
      claim.workspaceId,
      claim.nodeId,
      claim.userId
    )
    .run();
}
