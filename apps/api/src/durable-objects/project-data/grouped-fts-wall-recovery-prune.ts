/**
 * How one page of a session's grouped rows is pruned: by the operator wall recovery
 * (`grouped-fts-wall-recovery.ts`, `prunePage`, with the storage-full fallback described in
 * that module's comment) and by the storage alarm (`grouped-fts-cleanup.ts`,
 * `prunePageAtomically`, which never leaves a stale index entry).
 */
import { createModuleLogger, serializeError } from '../../lib/logger';
import { isDurableObjectStorageFullError } from '../../services/durable-object-retry';
import { SEARCH_INDEX_STATE_PRUNED } from './materialization';

const log = createModuleLogger('project_data.grouped_fts_wall_recovery');

const PRUNED_REASON =
  'Grouped/FTS derived rows were pruned by operator wall recovery; search uses raw-message LIKE fallback for this terminal session.';
export const ALARM_PRUNED_REASON =
  'Grouped/FTS derived rows were pruned for storage relief; search uses raw-message LIKE fallback for this terminal session.';

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
  now: number,
  reason: string = PRUNED_REASON
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
    reason,
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

/** Thrown inside the page transaction to roll back a page that left the database larger. */
class PageGrewError extends Error {
  constructor(readonly growthBytes: number) {
    super(`grouped page grew the database by ${growthBytes} bytes`);
    this.name = 'PageGrewError';
  }
}

/**
 * - `pruned`: the rows, the session mark and the FTS entries committed together.
 * - `grew`: rolled back, because the page left the database larger than it found it (an FTS5
 *   delete writes a segment about as large as the postings it cancels, which unique-token
 *   content can make larger than the rows it frees). Nothing changed.
 * - `storage_full`: rolled back at the per-object cap. Nothing changed.
 * - `failed`: rolled back for any other reason. Nothing changed.
 */
export type AtomicPagePruneOutcome =
  | { kind: 'pruned' }
  | { kind: 'grew'; growthBytes: number }
  | { kind: 'storage_full'; error: unknown }
  | { kind: 'failed'; error: unknown };

/**
 * The storage alarm's page: one transaction or nothing. Unlike `prunePage` it has no two-step
 * fallback, so it can never leave a stale FTS entry, and it rolls back a page whose own writes
 * grew the database: inside `transactionSync`, `databaseSize` already counts the uncommitted
 * pages, and a rollback restores it (verified in workerd).
 */
export function prunePageAtomically(
  sql: SqlStorage,
  sessionId: string,
  page: PageRow[],
  now: number,
  transactionSync: <T>(callback: () => T) => T
): AtomicPagePruneOutcome {
  let rows: ContentRow[];
  try {
    rows = readPageContent(sql, sessionId, page);
  } catch (error) {
    return { kind: 'failed', error };
  }
  const beforeBytes = sql.databaseSize;
  try {
    transactionSync(() => {
      deleteGroupedRowsAndMarkSession(sql, sessionId, page, now, ALARM_PRUNED_REASON);
      deleteFtsEntries(sql, rows);
      const afterBytes = sql.databaseSize;
      if (afterBytes > beforeBytes) throw new PageGrewError(afterBytes - beforeBytes);
    });
    return { kind: 'pruned' };
  } catch (error) {
    if (error instanceof PageGrewError) return { kind: 'grew', growthBytes: error.growthBytes };
    if (isDurableObjectStorageFullError(error)) return { kind: 'storage_full', error };
    return { kind: 'failed', error };
  }
}
