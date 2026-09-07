/** Matches the active-only index installed by migration 053. */
export const MAILBOX_CAPACITY_QUERY = `SELECT COUNT(*) AS cnt FROM (
  SELECT id FROM session_inbox
  WHERE delivery_state NOT IN ('acked', 'failed', 'ambiguous', 'expired')
  LIMIT ?
)`;

/** The configured cap bounds index reads even when retained history is large. */
export function isMailboxAtCapacity(sql: SqlStorage, maxMessages: number): boolean {
  const row = sql.exec(MAILBOX_CAPACITY_QUERY, maxMessages).toArray()[0];
  // Capacity must not fail open on a malformed storage result.
  return typeof row?.cnt !== 'number' || row.cnt >= maxMessages;
}
