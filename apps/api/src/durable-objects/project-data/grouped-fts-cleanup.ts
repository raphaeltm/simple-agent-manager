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
 * nothing. A session whose page fails, grows or does not fit is left alone for a while, and the
 * run moves on to the next session; a multi-run pass also walks the candidate order with a
 * durable traversal that wraps around, so sessions that keep failing cannot stall every run.
 * Every caller passes the object's real `transactionSync`: a page without one would not be atomic.
 */
import { createModuleLogger } from '../../lib/logger';
import { cleanSession, emptyRunTotals, selectRunCandidates } from './grouped-fts-cleanup-session';
import {
  clearGroupedFtsCleanupRun,
  excludeGroupedFtsCleanupSessions,
  readGroupedFtsCleanupExclusions,
  readGroupedFtsCleanupInProgressSessionId,
  readGroupedFtsCleanupRecheckAt,
  readGroupedFtsCleanupTraversal,
  resolveGroupedFtsCleanupModeConfig,
  writeGroupedFtsCleanupRun,
} from './grouped-fts-cleanup-state';
import type { GroupedFtsCandidate } from './grouped-fts-pages';
import { resolveGroupedFtsWallRecoveryConfig } from './grouped-fts-wall-recovery';
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
  /** Pages rolled back because they did not fit at the storage cap. */
  pagesRefusedAtCap: number;
  /** Sessions this run left alone for the exclusion window, for any reason. */
  sessionsExcluded: number;
  /** Of those, sessions whose page failed, grew or did not fit (not a too-large row). */
  sessionsExcludedForFailure: number;
  searchSemantics: 'full_fts' | 'partial_raw_like_fallback';
  cursor: { sessionId: string } | null;
  recheckAt: number | null;
  circuitBreaker: string | null;
};

type CleanupOptions = {
  allowStart?: boolean;
  now?: number;
  nowMs?: () => number;
  /** The object's `ctx.storage.transactionSync`: each page is one transaction. */
  transactionSync: <T>(callback: () => T) => T;
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
    pagesRefusedAtCap: 0,
    sessionsExcluded: 0,
    sessionsExcludedForFailure: 0,
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
  if (nearWall && !mode.nearWallEnabled) {
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
      traversal: readGroupedFtsCleanupTraversal(sql),
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

  const deadlineMs = now + config.groupedFtsCleanupWallTimeMs;
  const nowMs = options.nowMs ?? Date.now;
  const deadline = () => nowMs() >= deadlineMs;
  const exclusions = readGroupedFtsCleanupExclusions(sql, now);
  const traversal = readGroupedFtsCleanupTraversal(sql);
  const cutoff = now - config.groupedFtsCleanupMinSessionAgeMs;
  const candidates = selectRunCandidates(
    sql,
    cutoff,
    config.groupedFtsCleanupBatchSessions,
    exclusions,
    traversal
  );
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
  const totals = emptyRunTotals();
  let terminationReason: ProjectDataCleanupTerminationReason = 'candidates_exhausted';
  let shouldContinue = candidates.length > config.groupedFtsCleanupBatchSessions;
  // The last session this pass finished (cleaned, failed or excluded); a session stopped by a
  // budget is not finished, so the next run resumes it first.
  let finished: GroupedFtsCandidate | null = traversal;
  for (const candidate of candidates.slice(0, config.groupedFtsCleanupBatchSessions)) {
    totals.sessionsExamined++;
    const stop = cleanSession(
      sql,
      candidate.sessionId,
      config,
      pageLimits,
      options.transactionSync,
      now,
      deadline,
      totals
    );
    if (stop === 'drained' || stop === 'excluded' || stop === 'failed') {
      finished = candidate;
      continue;
    }
    terminationReason = stop;
    shouldContinue = true;
    break;
  }
  if (shouldContinue && terminationReason === 'candidates_exhausted') {
    terminationReason = 'row_budget';
  }
  // Every page this run tried was refused at the cap: say so rather than a budget reason.
  if (totals.pagesRefusedAtCap > 0 && totals.groupedRowsDeleted === 0) {
    terminationReason = 'storage_full';
    shouldContinue = true;
  }

  const excluded = [...totals.excludedForBudget, ...totals.excludedForFailure];
  if (excluded.length > 0) {
    excludeGroupedFtsCleanupSessions(
      sql,
      exclusions,
      excluded,
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
    writeGroupedFtsCleanupRun(sql, {
      lastSessionId: totals.lastSessionId,
      recheckAt,
      traversal: finished,
    });
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
    pagesRefusedAtCap: totals.pagesRefusedAtCap,
    sessionsExcluded: excluded.length,
    sessionsExcludedForFailure: totals.excludedForFailure.length,
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
