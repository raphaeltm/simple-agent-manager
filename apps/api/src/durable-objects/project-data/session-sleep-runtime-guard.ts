/** Fence the final local chat transition to the sleep's captured runtime/claim. */
export interface SessionSleepRuntimeGuard {
  projectId: string;
  userId: string;
  workspaceId: string;
  nodeId: string;
  evictionGeneration: string | null;
  claimId: string;
}

export async function sessionSleepRuntimeIsCurrent(
  database: D1Database,
  sessionId: string,
  guard: SessionSleepRuntimeGuard
): Promise<boolean> {
  return !!(await database.prepare(`SELECT w.id FROM workspaces w
    JOIN session_snapshots s ON s.workspace_id = w.id
    WHERE w.id = ? AND w.project_id = ? AND w.user_id = ? AND w.node_id = ?
      AND w.chat_session_id = ? AND w.eviction_generation IS ?
      AND w.status IN ('running', 'recovery', 'sleeping', 'stopped')
      AND s.project_id = ? AND s.user_id = ? AND s.chat_session_id = ?
      AND s.sleep_status = 'stopping' AND s.sleep_claim_id = ? AND s.sleeping_at IS NULL
    LIMIT 1`)
    .bind(guard.workspaceId, guard.projectId, guard.userId, guard.nodeId, sessionId,
      guard.evictionGeneration, guard.projectId, guard.userId, sessionId, guard.claimId)
    .first());
}

/** Called under the DO concurrency gate; no await between local check and write. */
export async function guardedSessionSleep(
  database: D1Database,
  sql: SqlStorage,
  sessionId: string,
  guard: SessionSleepRuntimeGuard,
  sleep: () => boolean
): Promise<boolean> {
  if (!(await sessionSleepRuntimeIsCurrent(database, sessionId, guard))) return false;
  const chat = sql.exec('SELECT status FROM chat_sessions WHERE id = ? AND workspace_id = ?',
    sessionId, guard.workspaceId).toArray()[0];
  if (chat?.status === 'sleeping') return true;
  return chat?.status === 'active' && sleep();
}
