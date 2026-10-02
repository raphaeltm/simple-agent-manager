/**
 * Operator-triggered grouped/FTS relief that still works when the ProjectData
 * object is at Cloudflare's hard per-object storage cap.
 *
 * Why this exists next to `grouped-fts-cleanup.ts`: the alarm-driven cleanup
 * refuses to run above `PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO`, so
 * it is switched off exactly when an object hits the wall. Every other relief
 * path (archive drain, migration abandon, tool-payload cleanup) inserts a
 * bookkeeping row before it frees anything, and at the cap that first insert
 * fails with "Exceeded the maximum database size". On 2026-10-02 the SAM root
 * object reached 10,737,418,240 bytes and all of them failed.
 *
 * This path frees space before it writes anything:
 *
 * 1. Candidates are terminal sessions older than the grouped-FTS minimum age that
 *    still have grouped rows and no archive source intent, ranked by
 *    `message_count` so the largest sessions go first (rule 65).
 * 2. Each page is pruned in one `transactionSync`: DELETE the `chat_messages_grouped`
 *    rows (freeing their pages), mark the session `grouped_fts_pruned` exactly like
 *    the alarm cleanup does, then remove the matching external-content FTS entries
 *    with FTS5 `'delete'` commands. Any failure rolls the whole page back, so the
 *    index stays in step with its content table.
 * 3. FTS5 records a delete as a new segment roughly as large as the postings it
 *    cancels. For content made mostly of unique tokens (hashes, hex, base64) that can
 *    exceed what the row DELETE freed, so at the cap the whole page fails with a
 *    storage-full error. Only then, the page is retried as two transactions: the row
 *    DELETE and session mark (always net-negative), then the FTS deletes. If the
 *    second one still does not fit, those entries are left stale and counted in
 *    `ftsStaleRows`. Stale postings point at rowids with no content row, so search
 *    joins drop them; they waste index space until the FTS index is rebuilt
 *    (tracked in `tasks/backlog/2026-10-02-rebuild-grouped-fts-after-wall-recovery.md`).
 *
 * Message text (`chat_messages`) is never read or written. Pruned sessions fall
 * back to raw-message LIKE search, which covers less than FTS: project-wide LIKE
 * scans only the newest raw rows, and streamed assistant text split across token
 * rows may not match. Materialization refuses to re-index a pruned session
 * (`SEARCH_INDEX_STATE_PRUNED`).
 *
 * The whole call is synchronous (no `await`), so no other request interleaves
 * with a page between its read and its transaction. That also means there is no
 * wall-clock budget: `Date.now()` does not advance during synchronous execution in
 * Workers (see `alarm-sections.ts`), so a deadline check could never fire. Each
 * call is bounded by rows and bytes instead, with ceilings sized well under the
 * object's CPU limit. Local workerd measurements on 2026-10-02 ranged from ~7 ms/MiB
 * (low-entropy text) to 55-180 ms/MiB (prose and unique-token content); production
 * storage is slower still, so the 32 MiB ceiling keeps a call to a few seconds.
 */
import { createModuleLogger, serializeError } from '../../lib/logger';
import { isDurableObjectStorageFullError } from '../../services/durable-object-retry';
import { SEARCH_INDEX_STATE_PRUNED } from './materialization';
import type { StorageSafetyConfig } from './storage-safety';
import type { Env } from './types';

const log = createModuleLogger('project_data.grouped_fts_wall_recovery');

/** Per-call ceilings. Production storage is slower than local workerd; keep margin. */
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_ROWS = 10_000;
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_BYTES = 32 * 1024 * 1024;
/** Also bounds the length of `skipSessionIds`. */
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_SESSIONS = 500;
/** Rows per transaction. Bounds the work one rollback can discard. */
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_TRANSACTION_ROWS = 500;
/**
 * Content bytes held in isolate memory per transaction. A grouped row is capped at
 * `DEFAULT_MATERIALIZATION_MAX_GROUP_CHARS` characters, so one page stays far below
 * the isolate memory limit that has already reset this object (rule 69).
 */
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_TRANSACTION_BYTES = 8 * 1024 * 1024;

const PRUNED_REASON =
  'Grouped/FTS derived rows were pruned by operator wall recovery; search uses raw-message LIKE fallback for this terminal session.';

export interface GroupedFtsWallRecoveryConfig {
  maxRows: number;
  maxBytes: number;
  maxSessions: number;
  transactionRows: number;
  transactionBytes: number;
}

/** Operator request, already validated against `GroupedFtsWallRecoveryConfig` ceilings. */
export interface GroupedFtsWallRecoveryRequest {
  reason: string;
  /** Report what would be pruned without writing anything. */
  dryRun: boolean;
  maxRows: number;
  maxBytes: number;
  maxSessions: number;
  /**
   * Sessions to leave alone this call. The operator's escape hatch when one
   * session's page fails the same way every time, which would otherwise stop
   * every call at the same place.
   */
  skipSessionIds: string[];
}

export interface GroupedFtsWallRecoveryInput extends GroupedFtsWallRecoveryRequest {
  transactionRows: number;
  transactionBytes: number;
}

export type GroupedFtsWallRecoveryStopReason =
  'candidates_exhausted' | 'row_budget' | 'byte_budget' | 'session_budget' | 'transaction_failed';

export interface GroupedFtsWallRecoverySessionResult {
  sessionId: string;
  messageCount: number;
  groupedRowsDeleted: number;
  contentBytes: number;
  /** True when every grouped row of the session is gone after this call. */
  drained: boolean;
}

export interface GroupedFtsWallRecoveryResult {
  projectId: string;
  reason: string;
  dryRun: boolean;
  beforeBytes: number;
  afterBytes: number;
  /** `beforeBytes - afterBytes`; negative if the object grew while the call ran. */
  databaseSizeDeltaBytes: number;
  candidateSessions: number;
  sessionsTouched: number;
  sessionsDrained: number;
  groupedRowsDeleted: number;
  ftsEntriesDeleted: number;
  /** Grouped rows deleted at the cap whose FTS entries did not fit and were left stale. */
  ftsStaleRows: number;
  contentBytes: number;
  transactions: number;
  stopReason: GroupedFtsWallRecoveryStopReason;
  error: string | null;
  /** The session whose page failed, to pass back in `skipSessionIds` if it keeps failing. */
  failedSessionId: string | null;
  sessions: GroupedFtsWallRecoverySessionResult[];
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveGroupedFtsWallRecoveryConfig(env: Env): GroupedFtsWallRecoveryConfig {
  return {
    maxRows: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_ROWS,
      DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_ROWS
    ),
    maxBytes: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_BYTES,
      DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_BYTES
    ),
    maxSessions: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_SESSIONS,
      DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_SESSIONS
    ),
    transactionRows: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_TRANSACTION_ROWS,
      DEFAULT_GROUPED_FTS_WALL_RECOVERY_TRANSACTION_ROWS
    ),
    transactionBytes: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_TRANSACTION_BYTES,
      DEFAULT_GROUPED_FTS_WALL_RECOVERY_TRANSACTION_BYTES
    ),
  };
}

type Candidate = { sessionId: string; messageCount: number };
type PageRow = { rowid: number; createdAt: number; bytes: number };
type ContentRow = { rowid: number; content: string };
/** Position after the last row read: `(created_at, rowid)`, the index's own order. */
type PageCursor = { createdAt: number; rowid: number };

const PAGE_START: PageCursor = { createdAt: Number.MIN_SAFE_INTEGER, rowid: 0 };

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

function readCandidates(sql: SqlStorage, cutoff: number, limit: number): Candidate[] {
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
  const candidates: Candidate[] = [];
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
function readPage(
  sql: SqlStorage,
  sessionId: string,
  cursor: PageCursor,
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
      throw new Error(`grouped row ${String(row[0])} has an unreadable rowid, created_at or size`);
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
      throw new Error(`grouped row ${rowid} is missing or has unreadable content`);
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

function hasGroupedRowsAfter(sql: SqlStorage, sessionId: string, cursor: PageCursor): boolean {
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
function prunePage(
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
      lastRowid: rows[rows.length - 1]?.rowid ?? null,
      ...serializeError(error),
    });
    return { kind: 'fts_stale' };
  }
}

function assertPositiveInteger(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`grouped FTS wall recovery: ${name} must be a positive integer`);
  }
}

/** The route validates too; the RPC boundary does not trust its caller (rule 51). */
function assertInput(input: GroupedFtsWallRecoveryInput): void {
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new Error('grouped FTS wall recovery: reason is required');
  }
  if (typeof input.dryRun !== 'boolean') {
    throw new Error('grouped FTS wall recovery: dryRun must be a boolean');
  }
  assertPositiveInteger('maxRows', input.maxRows);
  assertPositiveInteger('maxBytes', input.maxBytes);
  assertPositiveInteger('maxSessions', input.maxSessions);
  assertPositiveInteger('transactionRows', input.transactionRows);
  assertPositiveInteger('transactionBytes', input.transactionBytes);
  if (
    !Array.isArray(input.skipSessionIds) ||
    input.skipSessionIds.some((id) => typeof id !== 'string')
  ) {
    throw new Error('grouped FTS wall recovery: skipSessionIds must be an array of strings');
  }
}

export function runGroupedFtsWallRecovery(
  sql: SqlStorage,
  projectId: string | null,
  input: GroupedFtsWallRecoveryInput,
  storageConfig: Pick<StorageSafetyConfig, 'groupedFtsCleanupMinSessionAgeMs'>,
  deps: {
    transactionSync: <T>(callback: () => T) => T;
    nowMs?: () => number;
  }
): GroupedFtsWallRecoveryResult {
  if (!projectId) {
    throw new Error('ProjectData grouped FTS wall recovery requires a persisted projectId');
  }
  assertInput(input);
  const now = (deps.nowMs ?? Date.now)();
  const beforeBytes = sql.databaseSize;
  const cutoff = now - storageConfig.groupedFtsCleanupMinSessionAgeMs;
  // Skipped ids are filtered here rather than bound into SQL: Cloudflare caps a
  // statement at 100 bound parameters (rule 69). One extra row tells a session
  // budget stop apart from running out of candidates.
  const skip = new Set(input.skipSessionIds);
  const candidates = readCandidates(sql, cutoff, input.maxSessions + skip.size + 1).filter(
    (candidate) => !skip.has(candidate.sessionId)
  );

  const sessions: GroupedFtsWallRecoverySessionResult[] = [];
  let groupedRowsDeleted = 0;
  let contentBytes = 0;
  let transactions = 0;
  let ftsStaleRows = 0;
  let stopReason: GroupedFtsWallRecoveryStopReason =
    candidates.length > input.maxSessions ? 'session_budget' : 'candidates_exhausted';
  let error: string | null = null;
  let failedSessionId: string | null = null;

  candidateLoop: for (const candidate of candidates.slice(0, input.maxSessions)) {
    const session: GroupedFtsWallRecoverySessionResult = {
      sessionId: candidate.sessionId,
      messageCount: candidate.messageCount,
      groupedRowsDeleted: 0,
      contentBytes: 0,
      drained: false,
    };
    sessions.push(session);
    let cursor = PAGE_START;

    for (;;) {
      const rowsLeft = input.maxRows - groupedRowsDeleted;
      if (rowsLeft <= 0) {
        session.drained = !hasGroupedRowsAfter(sql, candidate.sessionId, cursor);
        stopReason = 'row_budget';
        break candidateLoop;
      }
      const bytesLeft = input.maxBytes - contentBytes;
      const page = readPage(
        sql,
        candidate.sessionId,
        cursor,
        Math.min(input.transactionRows, rowsLeft),
        Math.min(input.transactionBytes, bytesLeft),
        bytesLeft
      );
      if (page.length === 0) {
        if (hasGroupedRowsAfter(sql, candidate.sessionId, cursor)) {
          // The next row does not fit what is left of the byte budget.
          stopReason = 'byte_budget';
          break candidateLoop;
        }
        session.drained = true;
        break;
      }
      const pageBytes = page.reduce((sum, row) => sum + row.bytes, 0);

      if (!input.dryRun) {
        const outcome = prunePage(sql, candidate.sessionId, page, now, deps.transactionSync);
        if (outcome.kind === 'failed' || outcome.kind === 'fts_failed') {
          error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          failedSessionId = candidate.sessionId;
          stopReason = 'transaction_failed';
          log.error('transaction_failed', {
            projectId,
            sessionId: candidate.sessionId,
            pageRows: page.length,
            pageBytes,
            rowsDeleted: outcome.kind === 'fts_failed',
            ...serializeError(outcome.error),
          });
        }
        if (outcome.kind === 'failed') break candidateLoop;
        transactions++;
        if (outcome.kind !== 'pruned') ftsStaleRows += page.length;
      }

      session.groupedRowsDeleted += page.length;
      session.contentBytes += pageBytes;
      groupedRowsDeleted += page.length;
      contentBytes += pageBytes;
      const last = page[page.length - 1];
      if (last) cursor = { createdAt: last.createdAt, rowid: last.rowid };
      if (stopReason === 'transaction_failed') break candidateLoop;
    }
  }

  const reported = sessions.filter((s) => s.groupedRowsDeleted > 0 || s.drained);
  const afterBytes = sql.databaseSize;
  const result: GroupedFtsWallRecoveryResult = {
    projectId,
    reason: input.reason,
    dryRun: input.dryRun,
    beforeBytes,
    afterBytes,
    databaseSizeDeltaBytes: beforeBytes - afterBytes,
    candidateSessions: Math.min(candidates.length, input.maxSessions),
    sessionsTouched: reported.filter((s) => s.groupedRowsDeleted > 0).length,
    sessionsDrained: reported.filter((s) => s.drained).length,
    groupedRowsDeleted,
    ftsEntriesDeleted: input.dryRun ? 0 : groupedRowsDeleted - ftsStaleRows,
    ftsStaleRows,
    contentBytes,
    transactions,
    stopReason,
    error,
    failedSessionId,
    sessions: reported,
  };
  log.warn('completed', {
    projectId,
    reason: input.reason,
    dryRun: input.dryRun,
    beforeBytes,
    afterBytes,
    candidateSessions: result.candidateSessions,
    skippedSessions: skip.size,
    sessionsTouched: result.sessionsTouched,
    sessionsDrained: result.sessionsDrained,
    groupedRowsDeleted,
    contentBytes,
    transactions,
    ftsStaleRows,
    stopReason,
    error,
    failedSessionId,
  });
  return result;
}
