import {
  compareMessagePositions,
  type MessageCursor,
  type MessagePosition,
} from '@simple-agent-manager/shared';

/**
 * The exclusive `before`/`after` bounds of one transcript page.
 *
 * An exact position bounds the full `(created_at, sequence, id)` key — the
 * order every transcript read sorts by — so a page that ends inside a group of
 * tied timestamps resumes exactly where it stopped. A legacy numeric cursor
 * keeps its original meaning and bounds `created_at` alone.
 *
 * The three functions below express the same bounds for `chat_messages` SQL,
 * for archive chunk selection, and for rows decoded from an archive chunk.
 */
export type MessageBounds = {
  before: MessageCursor | null;
  after: MessageCursor | null;
};

type SqlClause = { sql: string; values: Array<number | string> };

const DIRECTIONS = [
  { bound: 'before', operator: '<', sign: -1 },
  { bound: 'after', operator: '>', sign: 1 },
] as const;

/** ` AND ...` predicates keeping `chat_messages` rows strictly inside the bounds. */
export function messageBoundsClause(bounds: MessageBounds): SqlClause {
  const clause: SqlClause = { sql: '', values: [] };
  for (const { bound, operator } of DIRECTIONS) {
    const cursor = bounds[bound];
    if (cursor === null) continue;
    if (typeof cursor === 'number') {
      clause.sql += ` AND created_at ${operator} ?`;
      clause.values.push(cursor);
    } else {
      clause.sql += ` AND (created_at, sequence, id) ${operator} (?, ?, ?)`;
      clause.values.push(cursor.createdAt, cursor.sequence, cursor.id);
    }
  }
  return clause;
}

/**
 * ` AND ...` predicates keeping archive chunks that can hold a row inside the
 * bounds. Rows tied with an exact position's timestamp may fall on either side
 * of it, so that edge is inclusive; a legacy timestamp excludes its ties.
 */
export function chunkBoundsClause(bounds: MessageBounds): SqlClause {
  const clause: SqlClause = { sql: '', values: [] };
  for (const { bound, operator } of DIRECTIONS) {
    const cursor = bounds[bound];
    if (cursor === null) continue;
    const column = bound === 'before' ? 'first_created_at' : 'last_created_at';
    const inclusive = typeof cursor === 'number' ? '' : '=';
    clause.sql += ` AND ${column} ${operator}${inclusive} ?`;
    clause.values.push(typeof cursor === 'number' ? cursor : cursor.createdAt);
  }
  return clause;
}

/** Whether a decoded archive row lies strictly inside the bounds. */
export function rowWithinBounds(row: Record<string, unknown>, bounds: MessageBounds): boolean {
  return DIRECTIONS.every(({ bound, sign }) => {
    const cursor = bounds[bound];
    if (cursor === null) return true;
    const comparison =
      typeof cursor === 'number'
        ? Math.sign(Number(row.created_at) - cursor)
        : compareMessagePositions(rowPosition(row), cursor);
    return comparison === sign;
  });
}

export function rowPosition(row: Record<string, unknown>): MessagePosition {
  return { createdAt: Number(row.created_at), sequence: Number(row.sequence), id: String(row.id) };
}
