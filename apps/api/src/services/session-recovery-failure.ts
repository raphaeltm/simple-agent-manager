import { ulid } from '../lib/ulid';

/**
 * A wake attempt is not the conversation's outcome. Keep its stable owner live
 * when the same unexpired snapshot can be tried again (including budget cooldown).
 * The compare-and-set fences both concurrent terminal intent and newer wakes.
 */
export async function returnFailedWakeToSleep(
  database: D1Database,
  input: {
    taskId: string;
    projectId: string;
    chatSessionId: string;
    recoveryAttemptId: string;
    errorMessage: string;
  }
): Promise<boolean> {
  const {
    taskId,
    projectId,
    chatSessionId: sessionId,
    recoveryAttemptId: attemptId,
    errorMessage,
  } = input;
  const now = new Date().toISOString();
  const previous = await database
    .prepare('SELECT status FROM tasks WHERE id = ? AND project_id = ?')
    .bind(taskId, projectId)
    .first<{ status: string }>();
  const result = await database
    .prepare(
      `UPDATE tasks SET status = 'sleeping', execution_step = NULL,
        completed_at = NULL, error_message = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND chat_session_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled')
        AND EXISTS (
          SELECT 1 FROM session_snapshots snapshot
           WHERE snapshot.project_id = tasks.project_id AND snapshot.user_id = tasks.user_id
             AND snapshot.chat_session_id = tasks.chat_session_id
             AND snapshot.recovery_task_id = tasks.id AND snapshot.recovery_attempt_id = ?
             AND snapshot.sleeping_at IS NOT NULL AND snapshot.sleep_status = 'sleeping'
             AND snapshot.expires_at > ? AND julianday(snapshot.expires_at) IS NOT NULL
             AND ((snapshot.status = 'available' AND snapshot.degradation = 'none')
               OR (snapshot.status = 'degraded' AND snapshot.degradation IS NOT NULL
                   AND snapshot.degradation != 'none'))
        ) RETURNING id`
    )
    .bind(errorMessage, now, taskId, projectId, sessionId, attemptId, now)
    .first();
  if (!result) return false;
  if (previous?.status === 'sleeping') return true;
  await database
    .prepare(
      `INSERT INTO task_status_events
      (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
      VALUES (?, ?, ?, 'sleeping', 'system', NULL, ?, ?)`
    )
    .bind(
      ulid(),
      taskId,
      previous?.status ?? 'queued',
      `Wake attempt failed; saved conversation retained: ${errorMessage}`,
      now
    )
    .run();
  return true;
}
