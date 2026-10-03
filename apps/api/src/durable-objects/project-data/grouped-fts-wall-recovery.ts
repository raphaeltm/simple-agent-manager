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
import type {
  GroupedFtsWallRecoveryResult,
  GroupedFtsWallRecoverySessionResult,
  GroupedFtsWallRecoveryStopReason,
} from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { type PageRow, prunePage } from './grouped-fts-wall-recovery-prune';
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

export type {
  GroupedFtsWallRecoveryResult,
  GroupedFtsWallRecoverySessionResult,
  GroupedFtsWallRecoveryStopReason,
} from '@simple-agent-manager/shared';

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

function assertPositiveInteger(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`grouped FTS wall recovery: ${name} must be a positive integer`);
  }
}

/** The route validates too; the RPC boundary does not trust its caller (rule 51). */
function assertInput(input: GroupedFtsWallRecoveryInput): void {
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new TypeError('grouped FTS wall recovery: reason is required');
  }
  if (typeof input.dryRun !== 'boolean') {
    throw new TypeError('grouped FTS wall recovery: dryRun must be a boolean');
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
    throw new TypeError('grouped FTS wall recovery: skipSessionIds must be an array of strings');
  }
}

/** Fixed inputs for one call. */
interface RunContext {
  sql: SqlStorage;
  projectId: string;
  input: GroupedFtsWallRecoveryInput;
  now: number;
  transactionSync: <T>(callback: () => T) => T;
}

/** Running totals for one call. `error` is set once, by the page that stops the call. */
interface RunTotals {
  groupedRowsDeleted: number;
  contentBytes: number;
  transactions: number;
  ftsStaleRows: number;
  error: string | null;
  failedSessionId: string | null;
}

function recordFailure(
  run: RunContext,
  totals: RunTotals,
  sessionId: string,
  page: PageRow[],
  pageBytes: number,
  error: unknown,
  rowsDeleted: boolean
): void {
  totals.error = error instanceof Error ? error.message : String(error);
  totals.failedSessionId = sessionId;
  log.error('transaction_failed', {
    projectId: run.projectId,
    sessionId,
    pageRows: page.length,
    pageBytes,
    rowsDeleted,
    ...serializeError(error),
  });
}

/**
 * Prunes one page (unless this is a dry run) and adds it to the totals. Returns
 * false when the call must stop. A page that failed outright changed nothing and is
 * not counted; a page whose FTS step failed did delete its rows, so it is counted.
 */
function applyPage(
  run: RunContext,
  totals: RunTotals,
  session: GroupedFtsWallRecoverySessionResult,
  page: PageRow[]
): boolean {
  const pageBytes = page.reduce((sum, row) => sum + row.bytes, 0);
  let keepGoing = true;
  if (!run.input.dryRun) {
    const outcome = prunePage(run.sql, session.sessionId, page, run.now, run.transactionSync);
    if (outcome.kind === 'failed') {
      recordFailure(run, totals, session.sessionId, page, pageBytes, outcome.error, false);
      return false;
    }
    if (outcome.kind === 'fts_failed') {
      recordFailure(run, totals, session.sessionId, page, pageBytes, outcome.error, true);
      keepGoing = false;
    }
    totals.transactions++;
    if (outcome.kind !== 'pruned') totals.ftsStaleRows += page.length;
  }
  session.groupedRowsDeleted += page.length;
  session.contentBytes += pageBytes;
  totals.groupedRowsDeleted += page.length;
  totals.contentBytes += pageBytes;
  return keepGoing;
}

/**
 * Prunes one session page by page from its first grouped row. Returns why the whole
 * call must stop, or null once the session is drained.
 */
function drainSession(
  run: RunContext,
  totals: RunTotals,
  session: GroupedFtsWallRecoverySessionResult
): GroupedFtsWallRecoveryStopReason | null {
  const { sql, input } = run;
  let cursor = PAGE_START;
  for (;;) {
    const rowsLeft = input.maxRows - totals.groupedRowsDeleted;
    if (rowsLeft <= 0) {
      session.drained = !hasGroupedRowsAfter(sql, session.sessionId, cursor);
      return 'row_budget';
    }
    const bytesLeft = input.maxBytes - totals.contentBytes;
    const page = readPage(
      sql,
      session.sessionId,
      cursor,
      Math.min(input.transactionRows, rowsLeft),
      Math.min(input.transactionBytes, bytesLeft),
      bytesLeft
    );
    const last = page.at(-1);
    if (!last) {
      // Rows remain but the next one does not fit what is left of the byte budget.
      if (hasGroupedRowsAfter(sql, session.sessionId, cursor)) return 'byte_budget';
      session.drained = true;
      return null;
    }
    if (!applyPage(run, totals, session, page)) return 'transaction_failed';
    cursor = { createdAt: last.createdAt, rowid: last.rowid };
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

  const run: RunContext = { sql, projectId, input, now, transactionSync: deps.transactionSync };
  const totals: RunTotals = {
    groupedRowsDeleted: 0,
    contentBytes: 0,
    transactions: 0,
    ftsStaleRows: 0,
    error: null,
    failedSessionId: null,
  };
  const sessions: GroupedFtsWallRecoverySessionResult[] = [];
  let stopReason: GroupedFtsWallRecoveryStopReason =
    candidates.length > input.maxSessions ? 'session_budget' : 'candidates_exhausted';
  for (const candidate of candidates.slice(0, input.maxSessions)) {
    const session: GroupedFtsWallRecoverySessionResult = {
      sessionId: candidate.sessionId,
      messageCount: candidate.messageCount,
      groupedRowsDeleted: 0,
      contentBytes: 0,
      drained: false,
    };
    sessions.push(session);
    const stop = drainSession(run, totals, session);
    if (stop) {
      stopReason = stop;
      break;
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
    groupedRowsDeleted: totals.groupedRowsDeleted,
    ftsEntriesDeleted: input.dryRun ? 0 : totals.groupedRowsDeleted - totals.ftsStaleRows,
    ftsStaleRows: totals.ftsStaleRows,
    contentBytes: totals.contentBytes,
    transactions: totals.transactions,
    stopReason,
    error: totals.error,
    failedSessionId: totals.failedSessionId,
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
    groupedRowsDeleted: totals.groupedRowsDeleted,
    contentBytes: totals.contentBytes,
    transactions: totals.transactions,
    ftsStaleRows: totals.ftsStaleRows,
    stopReason,
    error: totals.error,
    failedSessionId: totals.failedSessionId,
  });
  return result;
}
