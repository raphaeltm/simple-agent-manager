import { log } from '../../lib/logger';
import { projectDataGuardForReservedSubmission } from './reserved-project-data-guard';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/**
 * TDF-6: Ensure the chat session is linked to the workspace in both D1 and the
 * ProjectData DO. This is idempotent — safe to call on every retry/recovery.
 *
 * D1 update is done FIRST and separately because:
 * - D1 chat_session_id on workspace is used by idle cleanup and task completion hooks
 * - Even if the DO call fails, D1 must have the link for downstream correctness
 */
export async function ensureSessionLinked(
  state: TaskRunnerState,
  workspaceId: string,
  rc: TaskRunnerContext
): Promise<void> {
  const chatSessionId = state.stepResults.chatSessionId;
  if (!chatSessionId) return;

  const now = new Date().toISOString();

  try {
    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET chat_session_id = ?, updated_at = ? WHERE id = ?`
    )
      .bind(chatSessionId, now, workspaceId)
      .run();

    const taskLink = await rc.env.DATABASE.prepare(
      `UPDATE tasks
       SET chat_session_id = ?, workspace_id = ?, updated_at = ?
       WHERE id = ?
         AND (chat_session_id IS NULL OR chat_session_id = ?)
         AND (workspace_id IS NULL OR workspace_id = ?)`
    )
      .bind(chatSessionId, workspaceId, now, state.taskId, chatSessionId, workspaceId)
      .run();

    if (!taskLink.meta.changes) {
      const task = await rc.env.DATABASE.prepare(
        `SELECT chat_session_id, workspace_id FROM tasks WHERE id = ? LIMIT 1`
      )
        .bind(state.taskId)
        .first<{ chat_session_id: string | null; workspace_id: string | null }>();
      if (!task || task.chat_session_id !== chatSessionId || task.workspace_id !== workspaceId) {
        throw new Error(
          `Task ${state.taskId} has conflicting session/workspace linkage ` +
            `(task.chat_session_id=${task?.chat_session_id ?? 'missing'}, ` +
            `task.workspace_id=${task?.workspace_id ?? 'missing'})`
        );
      }
    }

    if (state.config.resumeSnapshotChatSessionId) {
      const { drizzle } = await import('drizzle-orm/d1');
      const schema = await import('../../db/schema');
      const { recordSessionSnapshotRecoveryWorkspace } =
        await import('../../services/session-snapshots');
      await recordSessionSnapshotRecoveryWorkspace(
        drizzle(rc.env.DATABASE, { schema }),
        state.config.resumeSnapshotChatSessionId,
        state.taskId,
        workspaceId
      );
    }

    log.info('task_runner_do.session_d1_linked', {
      taskId: state.taskId,
      sessionId: chatSessionId,
      workspaceId,
    });
  } catch (err) {
    log.error('task_runner_do.session_d1_link_failed', {
      taskId: state.taskId,
      sessionId: chatSessionId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    const permanentError = new Error(
      `Failed to link chatSessionId to workspace ${workspaceId} in D1: ${err instanceof Error ? err.message : String(err)}`
    );
    (permanentError as Error & { permanent: boolean }).permanent = true;
    throw permanentError;
  }

  try {
    const projectDataService = await import('../../services/project-data');
    await projectDataService.linkSessionToWorkspace(
      rc.env,
      state.projectId,
      chatSessionId,
      workspaceId,
      projectDataGuardForReservedSubmission(state, workspaceId)
    );

    if (state.config.taskMode === 'task') {
      await projectDataService.scheduleIdleCleanup(
        rc.env,
        state.projectId,
        chatSessionId,
        workspaceId,
        state.taskId
      );
      log.info('task_runner_do.session_idle_cleanup_scheduled', {
        taskId: state.taskId,
        sessionId: chatSessionId,
        workspaceId,
      });
    }

    log.info('task_runner_do.session_linked_to_workspace', {
      taskId: state.taskId,
      sessionId: chatSessionId,
      workspaceId,
    });
  } catch (err) {
    log.error('task_runner_do.session_do_link_failed', {
      taskId: state.taskId,
      sessionId: chatSessionId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (state.config.startGuard?.kind === 'reserved_submission') {
      const guardedLinkError = new Error(
        `Failed to link reserved ProjectData session ${chatSessionId} to workspace ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      (guardedLinkError as Error & { permanent: boolean }).permanent = true;
      throw guardedLinkError;
    }
  }
}
