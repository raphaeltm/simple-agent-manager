/** Fence a delayed blocked-sleep report against a new episode or user wake. */
import type { Env } from './types';

export async function finishBlockedSessionSleep(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  input: { snapshotId: string; chatSessionId: string; workspaceId: string; recordJson: string },
  fail: () => Promise<boolean>
): Promise<boolean> {
  if (!projectId) return false;
  const current = await env.DATABASE.prepare(
    `SELECT id FROM session_snapshots WHERE id = ? AND project_id = ? AND chat_session_id = ?
       AND workspace_id = ? AND sleep_status = 'terminal_failed' AND sleeping_at IS NULL AND sleep_fallback_json = ? LIMIT 1`
  )
    .bind(input.snapshotId, projectId, input.chatSessionId, input.workspaceId, input.recordJson)
    .first();
  if (!current) return false;
  // Read after the await. An active conversation/new runtime is a newer intent,
  // even when an explicit restart reuses the same workspace ID.
  const chat = sql
    .exec('SELECT status, workspace_id FROM chat_sessions WHERE id = ?', input.chatSessionId)
    .toArray()[0];
  if (
    chat?.workspace_id !== input.workspaceId ||
    !['sleeping', 'failed'].includes(String(chat.status))
  )
    return false;
  if (chat.status === 'failed') return true;
  return fail();
}
