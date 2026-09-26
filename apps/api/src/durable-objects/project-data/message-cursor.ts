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
 *
 * Exact bounds depend on `chat_messages.sequence` being non-NULL, as
 * `readTokensAfter` in materialization.ts does: a row value compared into a NULL
 * is NULL, which excludes the row. DO migration 007 backfilled every existing row
 * and every insert assigns one.
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
 * The timestamp and row ID at the edge of an archive chunk facing each bound:
 * its first row for `before`, its last for `after`. `row_ids_json` lists the
 * chunk's rows in transcript order.
 */
const CHUNK_EDGE = {
  before: { createdAt: 'first_created_at', id: `json_extract(row_ids_json, '$[0]')` },
  after: {
    createdAt: 'last_created_at',
    id: `json_extract(row_ids_json, '$[' || (json_array_length(row_ids_json) - 1) || ']')`,
  },
} as const;

/**
 * ` AND ...` predicates keeping archive chunks that can hold a row inside the
 * bounds. A legacy timestamp excludes its ties. Rows tied with an exact
 * position's timestamp may fall on either side of it, so a chunk whose edge
 * shares that timestamp is kept — unless its edge row is the cursor itself, as
 * it is whenever pages and chunks share a size.
 */
export function chunkBoundsClause(bounds: MessageBounds): SqlClause {
  const clause: SqlClause = { sql: '', values: [] };
  for (const { bound, operator } of DIRECTIONS) {
    const cursor = bounds[bound];
    if (cursor === null) continue;
    const edge = CHUNK_EDGE[bound];
    if (typeof cursor === 'number') {
      clause.sql += ` AND ${edge.createdAt} ${operator} ?`;
      clause.values.push(cursor);
    } else {
      clause.sql += ` AND (${edge.createdAt} ${operator} ? OR (${edge.createdAt} = ? AND ${edge.id} != ?))`;
      clause.values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
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

function rowPosition(row: Record<string, unknown>): MessagePosition {
  return { createdAt: Number(row.created_at), sequence: Number(row.sequence), id: String(row.id) };
}
