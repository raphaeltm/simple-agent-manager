/** Retire only cleanup state whose exact runtime has durably completed sleep. */
import type { Env } from './types';

export async function finishConfirmedSessionSleep(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  sessionId: string,
  workspaceId: string
): Promise<{ applied: boolean; markersResolved: number }> {
  if (!projectId) return { applied: false, markersResolved: 0 };
  const snapshot = await env.DATABASE.prepare(
    `SELECT snapshot.id FROM session_snapshots snapshot
     JOIN workspaces workspace ON workspace.id = snapshot.workspace_id
     WHERE snapshot.chat_session_id = ? AND snapshot.project_id = ? AND snapshot.workspace_id = ?
       AND workspace.project_id = snapshot.project_id AND workspace.user_id = snapshot.user_id
       AND workspace.chat_session_id = snapshot.chat_session_id AND workspace.status IN ('sleeping', 'deleted')
       AND snapshot.sleep_status = 'sleeping' AND snapshot.sleeping_at IS NOT NULL
       AND snapshot.recovery_status IS NOT 'waking'
       AND snapshot.expires_at > ?
       AND ((snapshot.status = 'available' AND snapshot.degradation = 'none')
         OR (snapshot.status = 'degraded' AND snapshot.degradation != 'none'))
     LIMIT 1`
  )
    .bind(sessionId, projectId, workspaceId, new Date().toISOString())
    .first();
  if (!snapshot) return { applied: false, markersResolved: 0 };
  // Re-read after the D1 await. A user wake may have changed the chat in between.
  const chat = sql
    .exec('SELECT status, workspace_id FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (chat?.status !== 'sleeping' || chat.workspace_id !== workspaceId)
    return { applied: false, markersResolved: 0 };
  sql.exec(
    'DELETE FROM idle_cleanup_schedule WHERE session_id = ? AND workspace_id = ?',
    sessionId,
    workspaceId
  );
  const resolved = sql.exec(
    `UPDATE session_attention_markers SET resolved_at = ?, resolved_by_actor_type = 'system', resolved_reason = 'sleep_confirmed'
     WHERE session_id = ? AND workspace_id = ? AND kind = 'idle_cleanup_failed' AND resolved_at IS NULL`,
    Date.now(),
    sessionId,
    workspaceId
  );
  return { applied: true, markersResolved: resolved.rowsWritten };
}
