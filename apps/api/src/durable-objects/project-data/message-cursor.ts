/** Numeric cursors remain timestamp-exclusive for existing API callers. */
export type MessageCursor = number | { createdAt: number; sequence: number; id: string };

export function messageCursorPredicate(
  column: 'before' | 'after',
  cursor: MessageCursor
): { sql: string; values: Array<number | string> } {
  const operator = column === 'before' ? '<' : '>';
  if (typeof cursor === 'number') {
    return { sql: `created_at ${operator} ?`, values: [cursor] };
  }
  return {
    sql: `(created_at ${operator} ? OR (created_at = ? AND sequence ${operator} ?) OR (created_at = ? AND sequence = ? AND id ${operator} ?))`,
    values: [
      cursor.createdAt,
      cursor.createdAt,
      cursor.sequence,
      cursor.createdAt,
      cursor.sequence,
      cursor.id,
    ],
  };
}

export function messageIsWithinCursor(
  row: Record<string, unknown>,
  column: 'before' | 'after',
  cursor: MessageCursor
): boolean {
  const timestamp = Number(row.created_at);
  if (typeof cursor === 'number')
    return column === 'before' ? timestamp < cursor : timestamp > cursor;
  const sequence = Number(row.sequence);
  const id = String(row.id);
  let comparison = 0;
  if (timestamp !== cursor.createdAt) comparison = timestamp < cursor.createdAt ? -1 : 1;
  else if (sequence !== cursor.sequence) comparison = sequence < cursor.sequence ? -1 : 1;
  else if (id !== cursor.id) comparison = id < cursor.id ? -1 : 1;
  return column === 'before' ? comparison < 0 : comparison > 0;
}
