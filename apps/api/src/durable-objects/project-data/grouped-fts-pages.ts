/**
 * The grouped-row page engine shared by the operator wall recovery
 * (`grouped-fts-wall-recovery.ts`) and the storage alarm's grouped/FTS cleanup
 * (`grouped-fts-cleanup.ts`): which sessions are eligible, in what order, and how a
 * session's grouped rows are read one bounded page at a time.
 */
import type { PageRow } from './grouped-fts-wall-recovery-prune';

export type GroupedFtsCandidate = { sessionId: string; messageCount: number };
/** Position after the last row read: `(created_at, rowid)`, the index's own order. */
export type GroupedPageCursor = { createdAt: number; rowid: number };

export const GROUPED_PAGE_START: GroupedPageCursor = {
  createdAt: Number.MIN_SAFE_INTEGER,
  rowid: 0,
};

/**
 * Exported so a test can pin its plan against the real engine: an index walk in
 * `(created_at, rowid)` order with no temp sort, which is what keeps `LIMIT` a
 * bound on rows read.
 */
export const GROUPED_PAGE_SIZES_SQL = `SELECT rowid, created_at, length(CAST(content AS BLOB))
  FROM chat_messages_grouped
  WHERE session_id = ? AND (created_at, rowid) > (?, ?)
  ORDER BY created_at ASC, rowid ASC
  LIMIT ?`;

/**
 * Terminal sessions older than `cutoff` that still have grouped rows and are not mid-archive
 * (no source intent, no target copy), largest first. Shared with the storage alarm
 * (`grouped-fts-cleanup.ts`), so neither path can prune a session an archive is copying.
 */
export function readGroupedFtsCandidates(
  sql: SqlStorage,
  cutoff: number,
  limit: number
): GroupedFtsCandidate[] {
  const rows = sql
    .exec(
      `SELECT s.id, s.message_count
       FROM chat_sessions s
       WHERE s.status IN ('stopped', 'failed')
         AND s.updated_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM project_data_archive_source_intents i WHERE i.session_id = s.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_data_archive_target_sessions t WHERE t.session_id = s.id
         )
         AND EXISTS (
           SELECT 1 FROM chat_messages_grouped g WHERE g.session_id = s.id
         )
       ORDER BY s.message_count DESC, s.id ASC
       LIMIT ?`,
      cutoff,
      limit
    )
    .raw();
  const candidates: GroupedFtsCandidate[] = [];
  for (const row of rows) {
    const sessionId = row[0];
    const messageCount = Number(row[1]);
    if (typeof sessionId !== 'string') continue;
    candidates.push({
      sessionId,
      messageCount: Number.isSafeInteger(messageCount) ? messageCount : 0,
    });
  }
  return candidates;
}

/**
 * The next page of the session's grouped rows after `cursor`, cut to the row and
 * byte limits. It walks `idx_grouped_messages_session (session_id, created_at)` in
 * order, so `LIMIT` bounds the rows read: ordering by `rowid` alone would sort, and
 * size, every remaining row of the session on every page. Sizes are read without
 * the content so a page's memory is decided before any content is loaded.
 */
export function readGroupedPage(
  sql: SqlStorage,
  sessionId: string,
  cursor: GroupedPageCursor,
  rowLimit: number,
  byteLimit: number,
  callBytesLeft: number
): PageRow[] {
  const rows = sql
    .exec(GROUPED_PAGE_SIZES_SQL, sessionId, cursor.createdAt, cursor.rowid, rowLimit)
    .raw();
  const page: PageRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowid = Number(row[0]);
    const createdAt = Number(row[1]);
    const rowBytes = Number(row[2]);
    if (
      !Number.isSafeInteger(rowid) ||
      !Number.isSafeInteger(createdAt) ||
      !Number.isFinite(rowBytes)
    ) {
      throw new TypeError(
        `grouped row ${String(row[0])} has an unreadable rowid, created_at or size`
      );
    }
    if (bytes + rowBytes > byteLimit) {
      // A legacy row larger than one transaction's byte bound would otherwise
      // stop every call on the same session. Take it alone while the call's own
      // byte budget still covers it.
      if (page.length === 0 && rowBytes <= callBytesLeft) {
        page.push({ rowid, createdAt, bytes: rowBytes });
      }
      break;
    }
    page.push({ rowid, createdAt, bytes: rowBytes });
    bytes += rowBytes;
  }
  return page;
}

export function hasGroupedRowsAfter(
  sql: SqlStorage,
  sessionId: string,
  cursor: GroupedPageCursor
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM chat_messages_grouped
         WHERE session_id = ? AND (created_at, rowid) > (?, ?)
         LIMIT 1`,
        sessionId,
        cursor.createdAt,
        cursor.rowid
      )
      .toArray().length > 0
  );
}
