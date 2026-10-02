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
 * 2. Each transaction reads a bounded page of `(rowid, content)`, DELETEs those
 *    `chat_messages_grouped` rows (freeing their pages), then removes the matching
 *    external-content FTS entries with FTS5 `'delete'` commands (whose segment data
 *    is flushed into the pages just freed), then marks the session
 *    `grouped_fts_pruned` exactly like the alarm cleanup does.
 * 3. Each transaction runs in `transactionSync`, so a failure rolls the whole page
 *    back: the FTS index is never left out of step with its content table.
 *
 * Message text (`chat_messages`) is never read or written. Pruned sessions keep
 * working search through the raw-message LIKE fallback, and materialization
 * refuses to re-index them (`SEARCH_INDEX_STATE_PRUNED`).
 *
 * The whole call is synchronous (no `await`), so no other request interleaves
 * with a page between its read and its transaction. It blocks the object for up
 * to `wallTimeMs`; operators choose that budget per call.
 */
import { createModuleLogger, serializeError } from '../../lib/logger';
import { SEARCH_INDEX_STATE_PRUNED } from './materialization';
import type { StorageSafetyConfig } from './storage-safety';
import type { Env } from './types';

const log = createModuleLogger('project_data.grouped_fts_wall_recovery');

export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_ROWS = 100_000;
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_SESSIONS = 500;
export const DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_WALL_TIME_MS = 25_000;
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
  maxWallTimeMs: number;
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
  wallTimeMs: number;
}

export interface GroupedFtsWallRecoveryInput extends GroupedFtsWallRecoveryRequest {
  transactionRows: number;
  transactionBytes: number;
}

export type GroupedFtsWallRecoveryStopReason =
  | 'candidates_exhausted'
  | 'row_budget'
  | 'byte_budget'
  | 'session_budget'
  | 'wall_time'
  | 'transaction_failed';

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
  contentBytes: number;
  transactions: number;
  stopReason: GroupedFtsWallRecoveryStopReason;
  error: string | null;
  sessions: GroupedFtsWallRecoverySessionResult[];
  durationMs: number;
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
    maxWallTimeMs: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_WALL_TIME_MS,
      DEFAULT_GROUPED_FTS_WALL_RECOVERY_MAX_WALL_TIME_MS
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
type PageRow = { rowid: number; bytes: number };

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
 * The next page of the session's grouped rows after `afterRowid`, cut to the row
 * and byte limits. Sizes are read without the content so a page's memory is
 * decided before any content is loaded.
 */
function readPage(
  sql: SqlStorage,
  sessionId: string,
  afterRowid: number,
  rowLimit: number,
  byteLimit: number,
  callBytesLeft: number
): PageRow[] {
  const rows = sql
    .exec(
      `SELECT rowid, length(CAST(content AS BLOB))
       FROM chat_messages_grouped
       WHERE session_id = ? AND rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`,
      sessionId,
      afterRowid,
      rowLimit
    )
    .raw();
  const page: PageRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowid = Number(row[0]);
    const rowBytes = Number(row[1]);
    if (!Number.isSafeInteger(rowid) || !Number.isFinite(rowBytes)) {
      throw new Error(`grouped row ${String(row[0])} has an unreadable size`);
    }
    if (bytes + rowBytes > byteLimit) {
      // A legacy row larger than one transaction's byte bound would otherwise
      // stop every call on the same session. Take it alone while the call's own
      // byte budget still covers it.
      if (page.length === 0 && rowBytes <= callBytesLeft) {
        page.push({ rowid, bytes: rowBytes });
      }
      break;
    }
    page.push({ rowid, bytes: rowBytes });
    bytes += rowBytes;
  }
  return page;
}

function readPageContent(
  sql: SqlStorage,
  sessionId: string,
  firstRowid: number,
  lastRowid: number
): Array<{ rowid: number; content: string }> {
  const rows = sql
    .exec(
      `SELECT rowid, content
       FROM chat_messages_grouped
       WHERE session_id = ? AND rowid BETWEEN ? AND ?
       ORDER BY rowid ASC`,
      sessionId,
      firstRowid,
      lastRowid
    )
    .raw();
  const content: Array<{ rowid: number; content: string }> = [];
  for (const row of rows) {
    const rowid = Number(row[0]);
    const text = row[1];
    if (!Number.isSafeInteger(rowid) || typeof text !== 'string') {
      throw new Error(`grouped row ${String(row[0])} has unreadable content`);
    }
    content.push({ rowid, content: text });
  }
  return content;
}

/** Delete-first: free the grouped pages, then drop the FTS entries, then mark the session. */
function pruneGroupedPage(
  sql: SqlStorage,
  sessionId: string,
  page: { firstRowid: number; lastRowid: number },
  rows: Array<{ rowid: number; content: string }>,
  now: number
): void {
  const { firstRowid, lastRowid } = page;
  sql.exec(
    `DELETE FROM chat_messages_grouped
     WHERE session_id = ? AND rowid BETWEEN ? AND ?`,
    sessionId,
    firstRowid,
    lastRowid
  );
  for (const row of rows) {
    sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
       VALUES('delete', ?, ?)`,
      row.rowid,
      row.content
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

function hasGroupedRowsAfter(sql: SqlStorage, sessionId: string, afterRowid: number): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM chat_messages_grouped WHERE session_id = ? AND rowid > ? LIMIT 1`,
        sessionId,
        afterRowid
      )
      .toArray().length > 0
  );
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
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const deadline = startedAt + input.wallTimeMs;
  const beforeBytes = sql.databaseSize;
  const cutoff = startedAt - storageConfig.groupedFtsCleanupMinSessionAgeMs;
  // One extra row tells a budget stop apart from running out of candidates.
  const candidates = readCandidates(sql, cutoff, input.maxSessions + 1);

  const sessions: GroupedFtsWallRecoverySessionResult[] = [];
  let groupedRowsDeleted = 0;
  let contentBytes = 0;
  let transactions = 0;
  let stopReason: GroupedFtsWallRecoveryStopReason =
    candidates.length > input.maxSessions ? 'session_budget' : 'candidates_exhausted';
  let error: string | null = null;

  candidateLoop: for (const candidate of candidates.slice(0, input.maxSessions)) {
    const session: GroupedFtsWallRecoverySessionResult = {
      sessionId: candidate.sessionId,
      messageCount: candidate.messageCount,
      groupedRowsDeleted: 0,
      contentBytes: 0,
      drained: false,
    };
    sessions.push(session);
    let cursor = 0;

    for (;;) {
      if (nowMs() >= deadline) {
        stopReason = 'wall_time';
        break candidateLoop;
      }
      const rowsLeft = input.maxRows - groupedRowsDeleted;
      if (rowsLeft <= 0) {
        stopReason = 'row_budget';
        break candidateLoop;
      }
      const page = readPage(
        sql,
        candidate.sessionId,
        cursor,
        Math.min(input.transactionRows, rowsLeft),
        Math.min(input.transactionBytes, input.maxBytes - contentBytes),
        input.maxBytes - contentBytes
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
      const firstRowid = page[0]?.rowid ?? 0;
      const lastRowid = page[page.length - 1]?.rowid ?? 0;

      if (!input.dryRun) {
        try {
          deps.transactionSync(() => {
            const rows = readPageContent(sql, candidate.sessionId, firstRowid, lastRowid);
            if (rows.length !== page.length) {
              throw new Error(
                `grouped page changed between size read and prune: expected ${page.length} rows, read ${rows.length}`
              );
            }
            pruneGroupedPage(sql, candidate.sessionId, { firstRowid, lastRowid }, rows, nowMs());
          });
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          stopReason = 'transaction_failed';
          log.error('transaction_failed', {
            projectId,
            sessionId: candidate.sessionId,
            pageRows: page.length,
            pageBytes,
            ...serializeError(err),
          });
          break candidateLoop;
        }
        transactions++;
      }

      session.groupedRowsDeleted += page.length;
      session.contentBytes += pageBytes;
      groupedRowsDeleted += page.length;
      contentBytes += pageBytes;
      cursor = lastRowid;
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
    ftsEntriesDeleted: input.dryRun ? 0 : groupedRowsDeleted,
    contentBytes,
    transactions,
    stopReason,
    error,
    sessions: reported,
    durationMs: nowMs() - startedAt,
  };
  log.warn('completed', {
    projectId,
    reason: input.reason,
    dryRun: input.dryRun,
    beforeBytes,
    afterBytes,
    candidateSessions: result.candidateSessions,
    sessionsTouched: result.sessionsTouched,
    sessionsDrained: result.sessionsDrained,
    groupedRowsDeleted,
    contentBytes,
    transactions,
    stopReason,
    error,
    durationMs: result.durationMs,
  });
  return result;
}
