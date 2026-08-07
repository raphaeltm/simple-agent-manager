import { createModuleLogger, serializeError } from '../../lib/logger';

const log = createModuleLogger('idle_cleanup_workspace');

/** Stop a workspace after an authoritative lifecycle decision. */
export async function stopWorkspaceInD1(
  db: D1Database,
  workspaceId: string,
  projectId?: string
): Promise<void> {
  const now = new Date().toISOString();
  try {
    const statement = projectId
      ? db
          .prepare(
            `UPDATE workspaces SET status = 'stopped', updated_at = ?
         WHERE id = ? AND project_id = ? AND status IN ('running', 'recovery')`
          )
          .bind(now, workspaceId, projectId)
      : db
          .prepare(
            `UPDATE workspaces SET status = 'stopped', updated_at = ?
         WHERE id = ? AND status IN ('running', 'recovery')`
          )
          .bind(now, workspaceId);
    await statement.run();
  } catch (err) {
    log.error('d1_workspace_stop_failed', { workspaceId, ...serializeError(err) });
    throw err;
  }
}

/** Project-scoped destructive workspace transition used by idle cleanup. */
export async function deleteWorkspaceInD1(
  db: D1Database,
  workspaceId: string,
  projectId: string
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `UPDATE workspaces SET status = 'stopped', updated_at = ?
       WHERE id = ? AND project_id = ? AND status IN ('running', 'creating', 'recovery')`
      )
      .bind(now, workspaceId, projectId)
      .run();
  } catch (err) {
    log.error('d1_workspace_deletion_failed', { workspaceId, ...serializeError(err) });
    throw err;
  }
}
