/**
 * Message materialization — grouping streaming tokens and FTS5 indexing.
 */

/**
 * Roles whose consecutive tokens are concatenated into a single grouped message.
 * Non-groupable roles (user, system, plan) pass through as individual messages.
 */
import { log } from '../../lib/logger';
import {
  parseMaterializationToken,
  parseRowid,
  parseSessionId,
  parseCount,
} from './row-schemas';

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
    .toArray()
    .map((row) => parseMaterializationToken(row));

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
      last.role === token.role &&
      GROUPABLE_ROLES.has(token.role)
    ) {
      last.content += token.content;
    } else {
      grouped.push({
        id: token.id,
        role: token.role,
        content: token.content,
        createdAt: token.createdAt,
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
          parseRowid(rowResult, 'materialization.grouped_rowid'),
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
  for (const row of sessions) {
    try {
      materializeSession(sql, parseSessionId(row, 'materialization.batch_session'));
      materialized++;
    } catch (e) {
      log.error('materialization.session_failed', {
        sessionId: row.id,
        error: String(e),
      });
      errors++;
    }
  }

  const remainingRow = sql
    .exec(`SELECT COUNT(*) as count FROM chat_sessions WHERE status = 'stopped' AND materialized_at IS NULL`)
    .toArray()[0];
  const remaining = remainingRow ? parseCount(remainingRow, 'materialization.remaining') : 0;

  return { materialized, errors, remaining };
}
