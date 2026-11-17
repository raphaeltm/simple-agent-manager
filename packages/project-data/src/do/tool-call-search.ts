import { SEARCH_INDEX_STATE_PRUNED } from './materialization';
import type { StoredBatchMessage } from './message-stream-ingest';
import type { Env } from './types';

/**
 * Keep the existing grouped-run granularity. Locate the preceding indexed group's
 * first raw row, then measure the canonical row's exact offset within that run.
 * Prefix reads scale with this single indexed group; no full-session rebuild.
 * A refusal rolls back the ingest transaction, including its replay receipt.
 */
export function refreshMaterializedTool(
  sql: SqlStorage,
  _env: Env,
  sessionId: string,
  message: StoredBatchMessage,
  previousContent: string
): void {
  if (message.content === previousContent) return;
  const session = sql
    .exec(
      `SELECT search_index_state, materialized_at,
    materialized_through_created_at, materialized_through_sequence FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!session || session.search_index_state === SEARCH_INDEX_STATE_PRUNED) return;
  const through = session.materialized_through_created_at ?? session.materialized_at;
  const sequence = session.materialized_through_sequence ?? Number.MAX_SAFE_INTEGER;
  if (
    typeof through !== 'number' ||
    message.createdAt > through ||
    (message.createdAt === through && message.sequence > Number(sequence))
  )
    return;
  const group = sql
    .exec(
      `SELECT g.rowid AS group_rowid, g.content, m.created_at, m.sequence
    FROM chat_messages_grouped g JOIN chat_messages m ON m.id = g.id AND m.session_id = g.session_id
    WHERE g.session_id = ? AND g.role = 'tool' AND (m.created_at, m.sequence) <= (?, ?)
    AND g.created_at <= ? ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1`,
      sessionId,
      message.createdAt,
      message.sequence,
      message.createdAt
    )
    .toArray()[0];
  if (!group || typeof group.content !== 'string' || typeof group.group_rowid !== 'number')
    throw new Error('Canonical tool has no materialized group');
  // SUM executes over this single indexed raw-row interval in constant JS memory.
  // Do not cap/abort a valid group's prefix: that would poison the reporter outbox.
  // UTF-8 bytes match SQLite BLOB length even for astral Unicode characters.
  const prefix = sql
    .exec(
      `SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes,
    COALESCE(SUM(CASE WHEN role != 'tool' THEN 1 ELSE 0 END), 0) AS other_roles
    FROM chat_messages WHERE session_id = ? AND COALESCE(origin, 'user') != 'system'
    AND (created_at, sequence) >= (?, ?) AND (created_at, sequence) < (?, ?)`,
      sessionId,
      Number(group.created_at),
      Number(group.sequence),
      message.createdAt,
      message.sequence
    )
    .toArray()[0];
  if (typeof prefix?.bytes !== 'number' || prefix.other_roles !== 0)
    throw new Error('Canonical tool materialized membership mismatch');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const bytes = encoder.encode(group.content);
  const old = encoder.encode(previousContent);
  if (decoder.decode(bytes.slice(prefix.bytes, prefix.bytes + old.length)) !== previousContent)
    throw new Error('Canonical tool materialized membership mismatch');
  const content =
    decoder.decode(bytes.slice(0, prefix.bytes)) +
    message.content +
    decoder.decode(bytes.slice(prefix.bytes + old.length));
  // External-content FTS needs the exact previous grouped text for its delete.
  sql.exec(
    `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
    VALUES('delete', ?, ?)`,
    group.group_rowid,
    group.content
  );
  sql.exec(
    'UPDATE chat_messages_grouped SET content = ? WHERE rowid = ? AND session_id = ?',
    content,
    group.group_rowid,
    sessionId
  );
  sql.exec(
    'INSERT INTO chat_messages_grouped_fts(rowid, content) VALUES (?, ?)',
    group.group_rowid,
    content
  );
}
