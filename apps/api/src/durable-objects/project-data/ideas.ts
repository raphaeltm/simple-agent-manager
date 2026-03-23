/**
 * Session–Idea (task) linking — many-to-many associations.
 */

export function linkSessionIdea(
  sql: SqlStorage,
  sessionId: string,
  taskId: string,
  context: string | null
): void {
  const session = sql
    .exec('SELECT id FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  sql.exec(
    `INSERT OR IGNORE INTO chat_session_ideas (session_id, task_id, context, created_at)
     VALUES (?, ?, ?, ?)`,
    sessionId,
    taskId,
    context,
    Date.now()
  );
}

export function unlinkSessionIdea(
  sql: SqlStorage,
  sessionId: string,
  taskId: string
): void {
  sql.exec(
    'DELETE FROM chat_session_ideas WHERE session_id = ? AND task_id = ?',
    sessionId,
    taskId
  );
}

export function getIdeasForSession(
  sql: SqlStorage,
  sessionId: string
): Array<{ taskId: string; context: string | null; createdAt: number }> {
  const rows = sql
    .exec(
      'SELECT task_id, context, created_at FROM chat_session_ideas WHERE session_id = ? ORDER BY created_at ASC',
      sessionId
    )
    .toArray();
  return rows.map((r) => ({
    taskId: r.task_id as string,
    context: r.context as string | null,
    createdAt: r.created_at as number,
  }));
}

export function getSessionsForIdea(
  sql: SqlStorage,
  taskId: string
): Array<{
  sessionId: string;
  topic: string | null;
  status: string;
  context: string | null;
  linkedAt: number;
}> {
  const rows = sql
    .exec(
      `SELECT csi.session_id, cs.topic, cs.status, csi.context, csi.created_at
       FROM chat_session_ideas csi
       JOIN chat_sessions cs ON cs.id = csi.session_id
       WHERE csi.task_id = ?
       ORDER BY csi.created_at ASC`,
      taskId
    )
    .toArray();
  return rows.map((r) => ({
    sessionId: r.session_id as string,
    topic: r.topic as string | null,
    status: r.status as string,
    context: r.context as string | null,
    linkedAt: r.created_at as number,
  }));
}
