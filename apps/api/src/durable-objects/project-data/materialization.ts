/**
 * Message materialization — grouping streaming tokens and FTS5 indexing.
 */

/**
 * Roles whose consecutive tokens are concatenated into a single grouped message.
 * Non-groupable roles (user, system, plan) pass through as individual messages.
 */
const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);

/**
 * Materialize grouped messages for a stopped session.
 * Reads raw tokens, groups consecutive same-role tokens (for groupable roles),
 * and writes the result to chat_messages_grouped + FTS5 index.
 *
 * Idempotent — skips sessions that are already materialized.
 */
export function materializeSession(sql: SqlStorage, sessionId: string): void {
  const session = sql
    .exec('SELECT materialized_at, status FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!session) return;
  if (session.materialized_at !== null) return;

  const tokens = sql
    .exec(
      'SELECT id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, sequence ASC',
      sessionId
    )
    .toArray();

  if (tokens.length === 0) {
    sql.exec(
      'UPDATE chat_sessions SET materialized_at = ? WHERE id = ?',
      Date.now(),
      sessionId
    );
    return;
  }

  // Group consecutive same-role tokens
  const grouped: Array<{ id: string; role: string; content: string; createdAt: number }> = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (
      last &&
      last.role === (token.role as string) &&
      GROUPABLE_ROLES.has(token.role as string)
    ) {
      last.content += token.content as string;
    } else {
      grouped.push({
        id: token.id as string,
        role: token.role as string,
        content: token.content as string,
        createdAt: token.created_at as number,
      });
    }
  }

  // Insert grouped messages and sync FTS5 index
  for (const msg of grouped) {
    sql.exec(
      'INSERT OR IGNORE INTO chat_messages_grouped (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      msg.id,
      sessionId,
      msg.role,
      msg.content,
      msg.createdAt
    );

    try {
      const rowResult = sql
        .exec('SELECT rowid FROM chat_messages_grouped WHERE id = ?', msg.id)
        .toArray()[0];
      if (rowResult) {
        sql.exec(
          'INSERT OR IGNORE INTO chat_messages_grouped_fts (rowid, content) VALUES (?, ?)',
          rowResult.rowid as number,
          msg.content
        );
      }
    } catch {
      // FTS5 table may not exist — grouped table still has value for LIKE search
    }
  }

  sql.exec(
    'UPDATE chat_sessions SET materialized_at = ? WHERE id = ?',
    Date.now(),
    sessionId
  );
}

/**
 * Materialize all stopped sessions that haven't been materialized yet.
 * Used for backfilling existing data after migration 011.
 */
export function materializeAllStopped(
  sql: SqlStorage,
  limit: number = 50
): { materialized: number; errors: number; remaining: number } {
  const sessions = sql
    .exec(
      `SELECT id FROM chat_sessions WHERE status = 'stopped' AND materialized_at IS NULL LIMIT ?`,
      limit
    )
    .toArray();

  let materialized = 0;
  let errors = 0;
  for (const session of sessions) {
    try {
      materializeSession(sql, session.id as string);
      materialized++;
    } catch (e) {
      console.error('Failed to materialize session', {
        sessionId: session.id,
        error: String(e),
      });
      errors++;
    }
  }

  const remainingRow = sql
    .exec(`SELECT COUNT(*) as count FROM chat_sessions WHERE status = 'stopped' AND materialized_at IS NULL`)
    .toArray()[0];
  const remaining = (remainingRow?.count as number) ?? 0;

  return { materialized, errors, remaining };
}
