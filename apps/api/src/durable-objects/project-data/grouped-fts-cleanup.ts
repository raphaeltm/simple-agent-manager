/**
 * The storage alarm's grouped/FTS cleanup: frees ProjectData storage by pruning the search
 * index (grouped rows and their FTS entries) of old, ended sessions. Message text is never
 * touched; pruned sessions fall back to raw-message search.
 *
 * It shares the operator wall recovery's engine (`grouped-fts-wall-recovery.ts`): the largest
 * eligible sessions first, never a session an archive is copying (source intent or target
 * copy), paged through big sessions so none is too large to clean. Each page is one
 * transaction (rows, session mark, FTS deletes) that is rolled back whole if it fails, hits the
 * storage cap, or leaves the database larger than it found it (`prunePageAtomically`). Unlike
 * the wall recovery it never falls back to leaving stale FTS entries.
 *
 * Near the per-object cap (`groupedFtsCleanupWallUnsafeRatio`) it used to stop with
 * `wall_unsafe`, because an FTS5 delete writes a segment about as large as the postings it
 * cancels. With `PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED` it keeps running there:
 * the growth check makes each page provably non-growing, and a page the cap refuses changes
 * nothing. A session whose page fails or grows is left alone for a while so it cannot stall
 * every run on the same place.
 */
import { createModuleLogger } from '../../lib/logger';
import {
  clearGroupedFtsCleanupRun,
  excludeGroupedFtsCleanupSessions,
  readGroupedFtsCleanupExclusions,
  readGroupedFtsCleanupInProgressSessionId,
  readGroupedFtsCleanupRecheckAt,
  resolveGroupedFtsCleanupModeConfig,
  writeGroupedFtsCleanupRun,
} from './grouped-fts-cleanup-state';
import {
  GROUPED_PAGE_START,
  type GroupedPageCursor,
  hasGroupedRowsAfter,
  readGroupedFtsCandidates,
  readGroupedPage,
} from './grouped-fts-pages';
import { resolveGroupedFtsWallRecoveryConfig } from './grouped-fts-wall-recovery';
import { prunePageAtomically } from './grouped-fts-wall-recovery-prune';
import type { ProjectDataStorageStatus, StorageSafetyConfig } from './storage-safety';
import {
  META_LAST_MEASURED_AT,
  readStorageSafetyMeta,
  readStorageSafetyMetaNumber,
  truncateStorageSafetyMetaValue,
  writeStorageSafetyMeta,
} from './storage-safety-meta';
import type { Env } from './types';

const log = createModuleLogger('project_data.grouped_fts_cleanup');

const META_LAST_ERROR = 'storageSafetyLastError';
const OVERLOAD_ERROR_PATTERN =
  /reset|overload|queued for too long|storage operation exceeded timeout/i;

export type ProjectDataCleanupTerminationReason =
  | 'disabled'
  | 'not_due'
  | 'target_reached'
  | 'candidates_exhausted'
  | 'byte_budget'
  | 'row_budget'
  | 'wall_time'
  /** Tool-payload cleanup only; the grouped/FTS cleanup pages through any session. */
  | 'oversized_skip'
  | 'wall_unsafe'
  | 'storage_full'
  | 'circuit_breaker'
  | 'weak_reclaim'
  | 'error';

export type ProjectDataGroupedFtsCleanupResult = {
  projectId: string;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  rowsExamined: number;
  sessionsExamined: number;
  sessionsCleaned: number;
  groupedRowsDeleted: number;
  ftsRowsDeleted: number;
  originalContentBytes: number;
  terminationReason: ProjectDataCleanupTerminationReason;
  /** True when this run started at or above the wall-unsafe ratio (near-wall mode). */
  nearWall: boolean;
  /** Pages rolled back because they would have grown the database. */
  pagesRolledBackForGrowth: number;
  /** Sessions this run left alone for the exclusion window. */
  sessionsExcluded: number;
  searchSemantics: 'full_fts' | 'partial_raw_like_fallback';
  cursor: { sessionId: string } | null;
  recheckAt: number | null;
  circuitBreaker: string | null;
};

type CleanupOptions = {
  allowStart?: boolean;
  now?: number;
  nowMs?: () => number;
  /** Required for atomic pages; without it nothing is pruned near the cap. */
  transactionSync?: <T>(callback: () => T) => T;
  classifyStatus: (databaseSizeBytes: number) => ProjectDataStorageStatus;
};

export function readProjectDataGroupedFtsCleanupRecheckAt(sql: SqlStorage): number | null {
  return readGroupedFtsCleanupRecheckAt(sql);
}

function emptyResult(input: {
  projectId: string;
  beforeBytes: number;
  config: StorageSafetyConfig;
  terminationReason: ProjectDataCleanupTerminationReason;
  nearWall?: boolean;
  circuitBreaker?: string | null;
}): ProjectDataGroupedFtsCleanupResult {
  return {
    projectId: input.projectId,
    beforeBytes: input.beforeBytes,
    afterBytes: input.beforeBytes,
    reclaimedBytes: 0,
    limitBytes: input.config.limitBytes,
    triggerBytes: Math.floor(input.config.limitBytes * input.config.groupedFtsCleanupTriggerRatio),
    targetBytes: Math.floor(input.config.limitBytes * input.config.groupedFtsCleanupTargetRatio),
    rowsExamined: 0,
    sessionsExamined: 0,
    sessionsCleaned: 0,
    groupedRowsDeleted: 0,
    ftsRowsDeleted: 0,
    originalContentBytes: 0,
    terminationReason: input.terminationReason,
    nearWall: input.nearWall ?? false,
    pagesRolledBackForGrowth: 0,
    sessionsExcluded: 0,
    searchSemantics: 'full_fts',
    cursor: null,
    recheckAt: null,
    circuitBreaker: input.circuitBreaker ?? null,
  };
}

function hasRecentOverloadSignal(
  sql: SqlStorage,
  now: number,
  config: StorageSafetyConfig
): string | null {
  const lastError = readStorageSafetyMeta(sql, META_LAST_ERROR);
  if (!lastError || !OVERLOAD_ERROR_PATTERN.test(lastError)) return null;
  const lastMeasuredAt = readStorageSafetyMetaNumber(sql, META_LAST_MEASURED_AT);
  if (lastMeasuredAt === null) return null;
  const lastErrorAgeMs = now - lastMeasuredAt;
  if (lastErrorAgeMs >= 0 && lastErrorAgeMs <= config.groupedFtsCleanupRecheckMs) {
    return lastError;
  }
  return null;
}

function recordLastError(sql: SqlStorage, message: string): void {
  try {
    writeStorageSafetyMeta(sql, META_LAST_ERROR, truncateStorageSafetyMetaValue(message, 500));
  } catch {
    // Best-effort near the cap; the result and the log still carry it.
  }
}

/** Running totals for one alarm run. */
interface RunTotals {
  rowsExamined: number;
  sessionsExamined: number;
  sessionsCleaned: number;
  groupedRowsDeleted: number;
  contentBytes: number;
  pagesRolledBackForGrowth: number;
  excluded: string[];
  lastSessionId: string | null;
  failureMessage: string | null;
}

type SessionStop =
  'drained' | 'row_budget' | 'byte_budget' | 'wall_time' | 'storage_full' | 'excluded';

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
function cleanSession(
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
        totals.excluded.push(sessionId);
        return 'excluded';
      }
      return 'byte_budget';
    }
    totals.rowsExamined += page.length;
    const outcome = prunePageAtomically(sql, sessionId, page, now, transactionSync);
    if (outcome.kind === 'storage_full') {
      totals.failureMessage = `grouped FTS cleanup page refused at the storage cap: session=${sessionId}`;
      return 'storage_full';
    }
    if (outcome.kind === 'grew' || outcome.kind === 'failed') {
      if (outcome.kind === 'grew') totals.pagesRolledBackForGrowth++;
      totals.excluded.push(sessionId);
      totals.failureMessage =
        outcome.kind === 'grew'
          ? `grouped FTS cleanup page would grow the database by ${outcome.growthBytes} bytes: session=${sessionId}`
          : `grouped FTS cleanup page failed: session=${sessionId}: ${
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }`;
      return 'excluded';
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

export async function runProjectDataGroupedFtsCleanup(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: CleanupOptions
): Promise<ProjectDataGroupedFtsCleanupResult | null> {
  if (!projectId) return null;

  const now = options.now ?? Date.now();
  const beforeBytes = sql.databaseSize;
  const triggerBytes = Math.floor(config.limitBytes * config.groupedFtsCleanupTriggerRatio);
  const targetBytes = Math.floor(config.limitBytes * config.groupedFtsCleanupTargetRatio);
  const unsafeBytes = Math.floor(config.limitBytes * config.groupedFtsCleanupWallUnsafeRatio);
  const mode = resolveGroupedFtsCleanupModeConfig(env);
  const nearWall = beforeBytes >= unsafeBytes;

  if (!config.groupedFtsCleanupEnabled) {
    clearGroupedFtsCleanupRun(sql);
    return emptyResult({ projectId, beforeBytes, config, terminationReason: 'disabled' });
  }
  if (nearWall && (!mode.nearWallEnabled || !options.transactionSync)) {
    clearGroupedFtsCleanupRun(sql);
    return emptyResult({
      projectId,
      beforeBytes,
      config,
      terminationReason: 'wall_unsafe',
      nearWall,
    });
  }
  if (beforeBytes <= targetBytes) {
    clearGroupedFtsCleanupRun(sql);
    return emptyResult({ projectId, beforeBytes, config, terminationReason: 'target_reached' });
  }
  const pendingRecheckAt = readGroupedFtsCleanupRecheckAt(sql);
  if (pendingRecheckAt !== null && pendingRecheckAt > now) return null;
  const inProgress = readGroupedFtsCleanupInProgressSessionId(sql) !== null;
  if (!inProgress && beforeBytes < triggerBytes && !options.allowStart) return null;

  const overloadSignal = hasRecentOverloadSignal(sql, now, config);
  if (overloadSignal) {
    writeGroupedFtsCleanupRun(sql, {
      lastSessionId: readGroupedFtsCleanupInProgressSessionId(sql),
      recheckAt: now + config.groupedFtsCleanupRecheckMs,
      pausedReason: `recent overload/reset signal: ${overloadSignal}`,
    });
    return emptyResult({
      projectId,
      beforeBytes,
      config,
      terminationReason: 'circuit_breaker',
      nearWall,
      circuitBreaker: 'recent_overload_or_reset',
    });
  }

  // Below the wall-unsafe ratio the DO still passes a real transaction; a caller that does not
  // gets per-statement writes, as the cleanup always did there.
  const transactionSync = options.transactionSync ?? (<T>(callback: () => T): T => callback());
  const deadlineMs = now + config.groupedFtsCleanupWallTimeMs;
  const nowMs = options.nowMs ?? Date.now;
  const deadline = () => nowMs() >= deadlineMs;
  const exclusions = readGroupedFtsCleanupExclusions(sql, now);
  const cutoff = now - config.groupedFtsCleanupMinSessionAgeMs;
  const candidates = readGroupedFtsCandidates(
    sql,
    cutoff,
    config.groupedFtsCleanupBatchSessions + exclusions.size + 1
  ).filter((candidate) => !exclusions.has(candidate.sessionId));
  if (candidates.length === 0) {
    clearGroupedFtsCleanupRun(sql);
    return emptyResult({
      projectId,
      beforeBytes,
      config,
      terminationReason: 'candidates_exhausted',
      nearWall,
    });
  }

  const transaction = resolveGroupedFtsWallRecoveryConfig(env);
  const pageLimits = { rows: transaction.transactionRows, bytes: transaction.transactionBytes };
  const totals: RunTotals = {
    rowsExamined: 0,
    sessionsExamined: 0,
    sessionsCleaned: 0,
    groupedRowsDeleted: 0,
    contentBytes: 0,
    pagesRolledBackForGrowth: 0,
    excluded: [],
    lastSessionId: null,
    failureMessage: null,
  };
  let terminationReason: ProjectDataCleanupTerminationReason = 'candidates_exhausted';
  let shouldContinue = candidates.length > config.groupedFtsCleanupBatchSessions;
  for (const candidate of candidates.slice(0, config.groupedFtsCleanupBatchSessions)) {
    totals.sessionsExamined++;
    const stop = cleanSession(
      sql,
      candidate.sessionId,
      config,
      pageLimits,
      transactionSync,
      now,
      deadline,
      totals
    );
    if (stop === 'drained' || stop === 'excluded') continue;
    terminationReason = stop;
    shouldContinue = true;
    break;
  }
  if (shouldContinue && terminationReason === 'candidates_exhausted') {
    terminationReason = 'row_budget';
  }

  if (totals.excluded.length > 0) {
    excludeGroupedFtsCleanupSessions(
      sql,
      exclusions,
      totals.excluded,
      now + mode.exclusionMs,
      mode.maxExclusions
    );
    shouldContinue = true;
  }

  const afterBytes = sql.databaseSize;
  const reclaimedBytes = Math.max(beforeBytes - afterBytes, 0);
  if (
    totals.groupedRowsDeleted > 0 &&
    reclaimedBytes < config.groupedFtsCleanupWeakReclaimBytes &&
    terminationReason !== 'storage_full'
  ) {
    terminationReason = 'weak_reclaim';
    shouldContinue = false;
    totals.failureMessage = `grouped FTS cleanup weak reclaim: rows=${totals.groupedRowsDeleted}, reclaimedBytes=${reclaimedBytes}`;
  }
  if (totals.failureMessage) recordLastError(sql, totals.failureMessage);

  const recheckAt = shouldContinue ? now + config.groupedFtsCleanupRecheckMs : null;
  if (recheckAt !== null) {
    writeGroupedFtsCleanupRun(sql, { lastSessionId: totals.lastSessionId, recheckAt });
  } else {
    clearGroupedFtsCleanupRun(sql);
  }

  const result: ProjectDataGroupedFtsCleanupResult = {
    projectId,
    beforeBytes,
    afterBytes,
    reclaimedBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    rowsExamined: totals.rowsExamined,
    sessionsExamined: totals.sessionsExamined,
    sessionsCleaned: totals.sessionsCleaned,
    groupedRowsDeleted: totals.groupedRowsDeleted,
    // A page's FTS deletes commit with its rows or not at all.
    ftsRowsDeleted: totals.groupedRowsDeleted,
    originalContentBytes: totals.contentBytes,
    terminationReason,
    nearWall,
    pagesRolledBackForGrowth: totals.pagesRolledBackForGrowth,
    sessionsExcluded: totals.excluded.length,
    searchSemantics: totals.groupedRowsDeleted > 0 ? 'partial_raw_like_fallback' : 'full_fts',
    cursor: recheckAt !== null && totals.lastSessionId ? { sessionId: totals.lastSessionId } : null,
    recheckAt,
    circuitBreaker: null,
  };

  if (totals.groupedRowsDeleted > 0 || terminationReason !== 'candidates_exhausted') {
    log.warn('completed', result);
  }
  return result;
}
