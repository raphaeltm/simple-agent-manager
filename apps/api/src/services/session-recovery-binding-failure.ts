/** Reconcile the missing clean-failure anchor of a stale workspace-binding collision.
 * The task already reported failure; strict runtime deletion proves cleanup finished.
 * Attempts are never reset here: the existing cooldown remains authoritative.
 */
export async function reconcileSessionRecoveryBindingFailure(
  database: D1Database,
  input: {
    chatSessionId: string;
    userId: string;
    taskId: string;
    recoveryAttemptId: string;
    staleBefore: string;
    now: string;
  }
): Promise<string | null> {
  const row = await database
    .prepare(
      `UPDATE session_snapshots AS snapshot
          SET recovery_failed_at = (
                SELECT strftime('%Y-%m-%dT%H:%M:%fZ', task.updated_at)
                  FROM tasks task WHERE task.id = snapshot.recovery_task_id
              ), updated_at = ?
        WHERE snapshot.chat_session_id = ? AND snapshot.user_id = ?
          AND snapshot.recovery_task_id = ? AND snapshot.recovery_attempt_id = ?
          AND snapshot.recovery_status = 'waking' AND snapshot.recovery_failed_at IS NULL
          AND snapshot.runtime = 'vm' AND snapshot.sleeping_at IS NOT NULL
          AND snapshot.sleep_status = 'sleeping' AND julianday(snapshot.expires_at) > julianday(?)
          AND ((snapshot.status = 'available' AND snapshot.degradation = 'none')
            OR (snapshot.status = 'degraded' AND snapshot.degradation IS NOT NULL
              AND snapshot.degradation != 'none'))
          AND snapshot.recovery_claimed_at <= ?
          AND EXISTS (
            SELECT 1 FROM tasks task
             WHERE task.id = snapshot.recovery_task_id
               AND task.project_id = snapshot.project_id AND task.user_id = snapshot.user_id
               AND task.chat_session_id = snapshot.chat_session_id
               AND task.status = 'sleeping' AND task.workspace_id IS NULL
               AND instr(task.error_message, 'UNIQUE constraint failed: workspaces.chat_session_id') > 0
               AND julianday(task.updated_at) >= julianday(snapshot.recovery_claimed_at)
               AND julianday(task.updated_at) <= julianday(?)
          )
          AND EXISTS (
            SELECT 1 FROM workspaces predecessor LEFT JOIN nodes node ON node.id = predecessor.node_id
             WHERE predecessor.chat_session_id = snapshot.chat_session_id
               AND predecessor.id != snapshot.workspace_id
               AND predecessor.project_id = snapshot.project_id AND predecessor.user_id = snapshot.user_id
               AND predecessor.status = 'deleted'
               AND (predecessor.runtime_deletion_confirmed_at IS NOT NULL
                 OR node.runtime_termination_confirmed_at IS NOT NULL)
          )
          AND EXISTS (
            SELECT 1 FROM workspaces original LEFT JOIN nodes node ON node.id = original.node_id
             WHERE original.id = snapshot.workspace_id
               AND original.project_id = snapshot.project_id AND original.user_id = snapshot.user_id
               AND original.status = 'deleted'
               AND (original.runtime_deletion_confirmed_at IS NOT NULL
                 OR node.runtime_termination_confirmed_at IS NOT NULL)
          )
          AND (snapshot.recovery_workspace_id IS NULL OR EXISTS (
            SELECT 1 FROM workspaces recovery LEFT JOIN nodes node ON node.id = recovery.node_id
             WHERE recovery.id = snapshot.recovery_workspace_id
               AND recovery.project_id = snapshot.project_id AND recovery.user_id = snapshot.user_id
               AND recovery.status = 'deleted'
               AND (recovery.runtime_deletion_confirmed_at IS NOT NULL
                 OR node.runtime_termination_confirmed_at IS NOT NULL)
          ))
        RETURNING recovery_failed_at AS failedAt`
    )
    .bind(
      input.now,
      input.chatSessionId,
      input.userId,
      input.taskId,
      input.recoveryAttemptId,
      input.now,
      input.staleBefore,
      input.now
    )
    .first<{ failedAt: string }>();
  return row?.failedAt ?? null;
}
