/**
 * Pagination cursors for persisted chat messages.
 *
 * A session's transcript has one total order: `createdAt`, then `sequence`,
 * then `id`. Timestamps alone are not unique — a whole VM-agent batch can land
 * on one millisecond — so a cursor that carries only a timestamp cannot say
 * where inside a group of tied rows a page ended, and the rest of that group
 * is skipped. A {@link MessagePosition} names the exact row instead.
 */

/** Exact place of one persisted message in its session's total order. */
export interface MessagePosition {
  createdAt: number;
  sequence: number;
  id: string;
}

/**
 * A `before`/`after` bound: an exact position, or a legacy millisecond
 * timestamp that excludes every row sharing it.
 */
export type MessageCursor = MessagePosition | number;

/** Orders two positions in the transcript total order (negative when `a` comes first). */
export function compareMessagePositions(a: MessagePosition, b: MessagePosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  // Message IDs are ASCII (UUIDs/ULIDs), so code-unit order matches SQLite's BINARY collation.
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Encodes a position as the `before`/`after` query value `[createdAt,sequence,id]`. */
export function formatMessageCursor(position: MessagePosition): string {
  return JSON.stringify([position.createdAt, position.sequence, position.id]);
}

/**
 * Decodes a `before`/`after` query value: an integer timestamp or the
 * `[createdAt,sequence,id]` array produced by {@link formatMessageCursor}.
 * Returns null when the value is neither.
 */
export function parseMessageCursor(raw: string): MessageCursor | null {
  if (/^-?\d+$/.test(raw)) {
    const timestamp = Number(raw);
    return Number.isSafeInteger(timestamp) ? timestamp : null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null;
  const [createdAt, sequence, id] = decoded as unknown[];
  if (!isSafeInteger(createdAt) || !isSafeInteger(sequence)) return null;
  if (typeof id !== 'string' || id === '') return null;
  return { createdAt, sequence, id };
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}
