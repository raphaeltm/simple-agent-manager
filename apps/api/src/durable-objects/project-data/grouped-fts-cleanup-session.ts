/**
 * One run of the storage alarm's grouped/FTS cleanup, session by session: which sessions this
 * run visits (`selectRunCandidates`) and how each is pruned page by page (`cleanSession`).
 * `grouped-fts-cleanup.ts` owns the gates and the run's result.
 */
import {
  GROUPED_PAGE_START,
  type GroupedFtsCandidate,
  type GroupedPageCursor,
  hasGroupedRowsAfter,
  readGroupedFtsCandidates,
  readGroupedPage,
} from './grouped-fts-pages';
import { prunePageAtomically } from './grouped-fts-wall-recovery-prune';
import type { StorageSafetyConfig } from './storage-safety';

/** Running totals for one alarm run. */
export interface RunTotals {
  rowsExamined: number;
  sessionsExamined: number;
  sessionsCleaned: number;
  groupedRowsDeleted: number;
  contentBytes: number;
  pagesRolledBackForGrowth: number;
  pagesRefusedAtCap: number;
  /** Sessions with a row no run could afford: by design, not a failure. */
  excludedForBudget: string[];
  /** Sessions whose page failed, grew the database, or did not fit at the cap. */
  excludedForFailure: string[];
  lastSessionId: string | null;
  failureMessage: string | null;
}

export function emptyRunTotals(): RunTotals {
  return {
    rowsExamined: 0,
    sessionsExamined: 0,
    sessionsCleaned: 0,
    groupedRowsDeleted: 0,
    contentBytes: 0,
    pagesRolledBackForGrowth: 0,
    pagesRefusedAtCap: 0,
    excludedForBudget: [],
    excludedForFailure: [],
    lastSessionId: null,
    failureMessage: null,
  };
}

/**
 * Why a session stopped. `drained`, `excluded` and `failed` finish the session for this pass;
 * the budget and time stops leave it to be resumed first next run.
 */
export type SessionStop =
  'drained' | 'excluded' | 'failed' | 'row_budget' | 'byte_budget' | 'wall_time';

/**
 * The sessions this run visits, in the largest-first candidate order, starting after
 * `traversal` (the last session the run finished with) and wrapping around to the largest
 * once it passes the end. The traversal advances past failed sessions as well as cleaned
 * ones, so a set of sessions that keep failing cannot hold every run, however many there are
 * and whether or not their exclusions could be recorded. More than `wanted` returned means the
 * run has more to do after this pass.
 */
export function selectRunCandidates(
  sql: SqlStorage,
  cutoff: number,
  wanted: number,
  exclusions: ReadonlyMap<string, number>,
  traversal: GroupedFtsCandidate | null
): GroupedFtsCandidate[] {
  const limit = wanted + exclusions.size + 1;
  const eligible = (candidate: GroupedFtsCandidate) => !exclusions.has(candidate.sessionId);
  const picked = readGroupedFtsCandidates(sql, cutoff, limit, traversal ?? undefined).filter(
    eligible
  );
  if (!traversal || picked.length > wanted) return picked;
  const seen = new Set(picked.map((candidate) => candidate.sessionId));
  for (const candidate of readGroupedFtsCandidates(sql, cutoff, limit).filter(eligible)) {
    if (!seen.has(candidate.sessionId)) picked.push(candidate);
  }
  return picked;
}

/** True when the session's next grouped row alone is larger than a whole run's byte budget. */
function nextRowExceedsRunBudget(
  sql: SqlStorage,
  sessionId: string,
  cursor: GroupedPageCursor,
  runBudgetBytes: number
): boolean {
  const [next] = readGroupedPage(
    sql,
    sessionId,
    cursor,
    1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  return next !== undefined && next.bytes > runBudgetBytes;
}

/** Prunes one session page by page until it is drained, a budget runs out, or a page stops it. */
export function cleanSession(
  sql: SqlStorage,
  sessionId: string,
  config: StorageSafetyConfig,
  pageLimits: { rows: number; bytes: number },
  transactionSync: <T>(callback: () => T) => T,
  now: number,
  deadline: () => boolean,
  totals: RunTotals
): SessionStop {
  let cursor: GroupedPageCursor = GROUPED_PAGE_START;
  let cleanedAny = false;
  for (;;) {
    const rowsLeft = config.groupedFtsCleanupBatchRows - totals.groupedRowsDeleted;
    const bytesLeft = config.groupedFtsCleanupBatchBytes - totals.contentBytes;
    if (rowsLeft <= 0) return 'row_budget';
    if (bytesLeft <= 0) return 'byte_budget';
    if (deadline()) return 'wall_time';
    const page = readGroupedPage(
      sql,
      sessionId,
      cursor,
      Math.min(pageLimits.rows, rowsLeft),
      Math.min(pageLimits.bytes, bytesLeft),
      bytesLeft
    );
    if (page.length === 0) {
      if (!hasGroupedRowsAfter(sql, sessionId, cursor)) return 'drained';
      // A row no run could ever afford would otherwise stop every run on this session.
      if (nextRowExceedsRunBudget(sql, sessionId, cursor, config.groupedFtsCleanupBatchBytes)) {
        totals.excludedForBudget.push(sessionId);
        return 'excluded';
      }
      return 'byte_budget';
    }
    totals.rowsExamined += page.length;
    const outcome = prunePageAtomically(sql, sessionId, page, now, transactionSync);
    if (outcome.kind !== 'pruned') {
      // The page was rolled back whole. Leave the session for later and let the run move on:
      // another session's page may well fit where this one did not.
      totals.excludedForFailure.push(sessionId);
      if (outcome.kind === 'storage_full') {
        totals.pagesRefusedAtCap++;
        totals.failureMessage = `grouped FTS cleanup page refused at the storage cap: session=${sessionId}`;
      } else if (outcome.kind === 'grew') {
        totals.pagesRolledBackForGrowth++;
        totals.failureMessage = `grouped FTS cleanup page would grow the database by ${outcome.growthBytes} bytes: session=${sessionId}`;
      } else {
        totals.failureMessage = `grouped FTS cleanup page failed: session=${sessionId}: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`;
      }
      return 'failed';
    }
    if (!cleanedAny) {
      cleanedAny = true;
      totals.sessionsCleaned++;
    }
    totals.groupedRowsDeleted += page.length;
    totals.contentBytes += page.reduce((sum, row) => sum + row.bytes, 0);
    totals.lastSessionId = sessionId;
    const last = page[page.length - 1];
    if (last) cursor = { createdAt: last.createdAt, rowid: last.rowid };
  }
}
