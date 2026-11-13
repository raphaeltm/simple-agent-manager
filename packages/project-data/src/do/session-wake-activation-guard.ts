/** A local lifecycle guard across the wake-ready D1 await; never use wall-clock equality. */
import { generateId } from './types';

function activationKey(sessionId: string): string {
  return `session-wake-activation:${sessionId}`;
}

export function invalidateSessionWakeActivation(sql: SqlStorage, sessionId: string): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', activationKey(sessionId));
}

export function beginSessionWakeActivation(
  sql: SqlStorage,
  sessionId: string,
  workspaceId: string,
  fence: string
): string | null {
  const eligible =
    sql
      .exec(
        `SELECT 1 FROM chat_sessions s WHERE s.id = ? AND s.status = 'sleeping' AND s.workspace_id = ?
      AND NOT EXISTS (SELECT 1 FROM session_wake_readiness r WHERE r.session_id = s.id AND r.fence = ?)`,
        sessionId,
        workspaceId,
        fence
      )
      .toArray().length > 0;
  if (!eligible) return null;
  const token = generateId();
  sql.exec(
    'INSERT INTO do_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    activationKey(sessionId),
    token
  );
  return token;
}

export function commitSessionWakeActivation(
  sql: SqlStorage,
  sessionId: string,
  workspaceId: string,
  token: string | null,
  now: number
): boolean {
  if (!token) return false;
  const updated =
    sql.exec(
      `UPDATE chat_sessions SET status = 'active', updated_at = ?
      WHERE id = ? AND status = 'sleeping' AND workspace_id = ?
        AND EXISTS (SELECT 1 FROM do_meta WHERE key = ? AND value = ?)`,
      now,
      sessionId,
      workspaceId,
      activationKey(sessionId),
      token
    ).rowsWritten > 0;
  sql.exec('DELETE FROM do_meta WHERE key = ? AND value = ?', activationKey(sessionId), token);
  return updated;
}
