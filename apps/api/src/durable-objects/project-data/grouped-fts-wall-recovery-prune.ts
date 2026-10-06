/**
 * How `grouped-fts-wall-recovery.ts` prunes one page of a session's grouped rows,
 * including the storage-full fallback described in that module's comment.
 */
import { createModuleLogger, serializeError } from '../../lib/logger';
import { isDurableObjectStorageFullError } from '../../services/durable-object-retry';
import { SEARCH_INDEX_STATE_PRUNED } from './materialization';

const log = createModuleLogger('project_data.grouped_fts_wall_recovery');

const PRUNED_REASON =
  'Grouped/FTS derived rows were pruned by operator wall recovery; search uses raw-message LIKE fallback for this terminal session.';

export type PageRow = { rowid: number; createdAt: number; bytes: number };
type ContentRow = { rowid: number; content: string };

/** Point lookups by rowid; each row must still belong to the session. */
function readPageContent(sql: SqlStorage, sessionId: string, page: PageRow[]): ContentRow[] {
  return page.map(({ rowid }) => {
    const row = sql
      .exec(
        `SELECT content FROM chat_messages_grouped WHERE rowid = ? AND session_id = ?`,
        rowid,
        sessionId
      )
      .raw()
      .next();
    const content = row.done ? undefined : row.value[0];
    if (typeof content !== 'string') {
      throw new TypeError(`grouped row ${rowid} is missing or has unreadable content`);
    }
    return { rowid, content };
  });
}

/** Free the grouped rows' pages, then mark the session. Never grows the database net. */
function deleteGroupedRowsAndMarkSession(
  sql: SqlStorage,
  sessionId: string,
  page: PageRow[],
  now: number
): void {
  for (const { rowid } of page) {
    sql.exec(
      `DELETE FROM chat_messages_grouped WHERE rowid = ? AND session_id = ?`,
      rowid,
      sessionId
    );
  }
  // Same state change as `grouped-fts-cleanup.ts`: the watermark dies with the rows
  // it described, and the pruned state makes materialization refuse to re-index.
  sql.exec(
    `UPDATE chat_sessions
     SET materialized_at = NULL,
         materialized_through_created_at = NULL,
         materialized_through_sequence = NULL,
         search_index_state = ?,
         search_index_updated_at = ?,
         search_index_degradation_reason = ?
     WHERE id = ?`,
    SEARCH_INDEX_STATE_PRUNED,
    now,
    PRUNED_REASON,
    sessionId
  );
}

/** External-content FTS5 delete: the indexed values must be supplied verbatim. */
function deleteFtsEntries(sql: SqlStorage, rows: ContentRow[]): void {
  for (const row of rows) {
    sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
       VALUES('delete', ?, ?)`,
      row.rowid,
      row.content
    );
  }
}

/**
 * - `pruned`: rows and FTS entries gone.
 * - `fts_stale`: rows gone; the FTS deletes did not fit at the cap (documented degradation).
 * - `fts_failed`: rows gone; the FTS deletes failed for another reason. The rows still
 *   count as deleted and stale, but the call stops and reports the error.
 * - `failed`: nothing changed.
 */
type PagePruneOutcome =
  | { kind: 'pruned' }
  | { kind: 'fts_stale' }
  | { kind: 'fts_failed'; error: unknown }
  | { kind: 'failed'; error: unknown };

/**
 * One atomic transaction when it fits; the two-step fallback only for a
 * storage-full failure (see the module comment). Any other failure of the atomic
 * attempt is returned untouched, with the page fully rolled back.
 */
export function prunePage(
  sql: SqlStorage,
  sessionId: string,
  page: PageRow[],
  now: number,
  transactionSync: <T>(callback: () => T) => T
): PagePruneOutcome {
  // Read before the transaction; nothing can interleave because nothing awaits.
  let rows: ContentRow[];
  try {
    rows = readPageContent(sql, sessionId, page);
  } catch (error) {
    return { kind: 'failed', error };
  }
  try {
    transactionSync(() => {
      deleteGroupedRowsAndMarkSession(sql, sessionId, page, now);
      deleteFtsEntries(sql, rows);
    });
    return { kind: 'pruned' };
  } catch (error) {
    if (!isDurableObjectStorageFullError(error)) return { kind: 'failed', error };
  }
  try {
    transactionSync(() => deleteGroupedRowsAndMarkSession(sql, sessionId, page, now));
  } catch (error) {
    return { kind: 'failed', error };
  }
  try {
    transactionSync(() => deleteFtsEntries(sql, rows));
    return { kind: 'pruned' };
  } catch (error) {
    if (!isDurableObjectStorageFullError(error)) return { kind: 'fts_failed', error };
    log.warn('fts_entries_left_stale', {
      sessionId,
      rows: rows.length,
      firstRowid: rows[0]?.rowid ?? null,
      lastRowid: rows.at(-1)?.rowid ?? null,
      ...serializeError(error),
    });
    return { kind: 'fts_stale' };
  }
}
