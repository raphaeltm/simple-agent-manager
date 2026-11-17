import type { Env } from '../env';

/**
 * Before TaskRunner commits in_progress, placement may not have created or linked a
 * workspace. Submission writers bind tasks.chat_session_id before starting the runner
 * (persistVmTaskSession, reserved submissions, dispatch_task and ProjectOrchestrator).
 * A follow-up in this window has nothing to wake and must wait in the existing inbox.
 *
 * Recovery also queues tasks: retained sleeping_at, the same history required by
 * loadRecoveryContext, leaves those conversations with ensureSessionRecovery. A mere
 * checkpoint row is not sleep history. Do not use execution_step or started_at here:
 * startup and retry writers do not maintain those as a first-placement discriminator.
 */
export async function isVmPromptTargetStarting(
  env: Env,
  projectId: string,
  chatSessionId: string
): Promise<boolean> {
  const starting = await env.DATABASE.prepare(
    `SELECT task.id
       FROM tasks task
      WHERE task.project_id = ? AND task.chat_session_id = ?
        AND task.status IN ('draft', 'ready', 'queued', 'delegated')
        AND NOT EXISTS (
          SELECT 1 FROM session_snapshots snapshot
           WHERE snapshot.chat_session_id = task.chat_session_id
             AND snapshot.sleeping_at IS NOT NULL
        )
      LIMIT 1`
  )
    .bind(projectId, chatSessionId)
    .first<{ id: string }>();
  return starting !== null;
}
