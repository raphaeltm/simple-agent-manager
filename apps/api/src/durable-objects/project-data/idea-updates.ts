/** Project-local idea notes. D1 verifies the idea before any call reaches this store. */
import type { IdeaUpdateNote } from '@simple-agent-manager/shared';

interface Row {
  id: string;
  idea_id: string;
  author_kind: 'user' | 'agent';
  author_user_id: string | null;
  author_name: string | null;
  session_id: string | null;
  session_topic: string | null;
  body: string;
  quote: string | null;
  created_at: string;
  edited_at: string | null;
}

function note(row: Record<string, SqlStorageValue>): IdeaUpdateNote {
  const r = row as unknown as Row;
  return {
    id: r.id,
    ideaId: r.idea_id,
    authorKind: r.author_kind,
    authorUserId: r.author_user_id,
    authorName: r.author_name,
    sessionId: r.session_id,
    sessionTopic: r.session_topic,
    body: r.body,
    quote: r.quote,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  };
}

export function addIdeaUpdate(
  sql: SqlStorage,
  input: IdeaUpdateNote,
  minAgentIntervalMs: number
): IdeaUpdateNote {
  if (input.authorKind === 'agent') {
    if (!input.sessionId) throw new Error('Agent note requires a session');
    const latest = sql
      .exec(
        `SELECT created_at FROM idea_updates WHERE idea_id = ? AND session_id = ? AND author_kind = 'agent' ORDER BY created_at DESC LIMIT 1`,
        input.ideaId,
        input.sessionId
      )
      .toArray()[0];
    if (
      latest &&
      Date.parse(String(latest.created_at)) + minAgentIntervalMs > Date.parse(input.createdAt)
    ) {
      throw new Error('Agent note rate limit exceeded');
    }
  }
  sql.exec(
    `INSERT INTO idea_updates (id, idea_id, author_kind, author_user_id, author_name, session_id, session_topic, body, quote, created_at, edited_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    input.id,
    input.ideaId,
    input.authorKind,
    input.authorUserId,
    input.authorName,
    input.sessionId,
    input.sessionTopic,
    input.body,
    input.quote,
    input.createdAt
  );
  return input;
}

export function listIdeaUpdates(
  sql: SqlStorage,
  ideaId: string,
  cursor: { createdAt: string; id: string } | null,
  limit: number
) {
  const rows = cursor
    ? sql
        .exec(
          `SELECT * FROM idea_updates WHERE idea_id = ? AND deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
          ideaId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.id,
          limit + 1
        )
        .toArray()
    : sql
        .exec(
          `SELECT * FROM idea_updates WHERE idea_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`,
          ideaId,
          limit + 1
        )
        .toArray();
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    updates: selected.map(note),
    nextCursor:
      rows.length > limit && last
        ? { createdAt: String(last.created_at), id: String(last.id) }
        : null,
  };
}

/**
 * How many notes each of `ideaIds` has, excluding soft-deleted ones.
 *
 * One grouped count for the whole Ideas list, so the page's query count does not grow with
 * the number of ideas on it (rule 60). Ideas with no notes are absent from the result; the
 * caller reads a missing entry as zero.
 */
export function countIdeaUpdates(sql: SqlStorage, ideaIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!ideaIds.length) return counts;
  for (const row of sql
    .exec(
      `SELECT idea_id AS ideaId, COUNT(*) AS total FROM idea_updates
       WHERE idea_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
       GROUP BY idea_id`,
      JSON.stringify(ideaIds)
    )
    .toArray()) {
    counts[String(row.ideaId)] = Number(row.total);
  }
  return counts;
}

export function deleteIdeaUpdate(
  sql: SqlStorage,
  ideaId: string,
  updateId: string,
  actorUserId: string,
  canModerate: boolean,
  now: string
): boolean {
  const result = sql.exec(
    `UPDATE idea_updates SET deleted_at = ? WHERE id = ? AND idea_id = ? AND deleted_at IS NULL
       AND (author_user_id = ? OR ? = 1)`,
    now,
    updateId,
    ideaId,
    actorUserId,
    canModerate ? 1 : 0
  );
  return result.rowsWritten > 0;
}
