import { createModuleLogger, serializeError } from '../../lib/logger';
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

const META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID = 'storageSafetyGroupedFtsCleanupCursorSessionId';
const META_GROUPED_FTS_CLEANUP_RECHECK_AT = 'storageSafetyGroupedFtsCleanupRecheckAt';
const META_GROUPED_FTS_CLEANUP_DISABLED_REASON = 'storageSafetyGroupedFtsCleanupDisabledReason';
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
  | 'oversized_skip'
  | 'wall_unsafe'
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
  searchSemantics: 'full_fts' | 'partial_raw_like_fallback';
  cursor: { sessionId: string } | null;
  recheckAt: number | null;
  circuitBreaker: string | null;
};

type SessionCandidate = {
  sessionId: string;
  groupedRows: number;
  contentBytes: number;
};

type CleanupOptions = {
  allowStart?: boolean;
  now?: number;
  nowMs?: () => number;
  classifyStatus: (databaseSizeBytes: number) => ProjectDataStorageStatus;
};

export function readProjectDataGroupedFtsCleanupRecheckAt(sql: SqlStorage): number | null {
  return readStorageSafetyMetaNumber(sql, META_GROUPED_FTS_CLEANUP_RECHECK_AT);
}

function clearGroupedFtsCleanupState(sql: SqlStorage): void {
  sql.exec(
    `DELETE FROM do_meta
     WHERE key IN (?, ?, ?)`,
    META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID,
    META_GROUPED_FTS_CLEANUP_RECHECK_AT,
    META_GROUPED_FTS_CLEANUP_DISABLED_REASON
  );
}

function writeGroupedFtsCleanupState(
  sql: SqlStorage,
  sessionId: string | null,
  recheckAt: number | null,
  disabledReason: string | null = null
): void {
  sql.exec(
    `DELETE FROM do_meta
     WHERE key IN (?, ?, ?)`,
    META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID,
    META_GROUPED_FTS_CLEANUP_RECHECK_AT,
    META_GROUPED_FTS_CLEANUP_DISABLED_REASON
  );
  if (sessionId) {
    writeStorageSafetyMeta(sql, META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID, sessionId);
  }
  if (recheckAt !== null) {
    writeStorageSafetyMeta(sql, META_GROUPED_FTS_CLEANUP_RECHECK_AT, String(recheckAt));
  }
  if (disabledReason) {
    writeStorageSafetyMeta(
      sql,
      META_GROUPED_FTS_CLEANUP_DISABLED_REASON,
      truncateStorageSafetyMetaValue(disabledReason, 500)
    );
  }
}

function emptyResult(input: {
  projectId: string;
  beforeBytes: number;
  config: StorageSafetyConfig;
  terminationReason: ProjectDataCleanupTerminationReason;
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
    searchSemantics: 'full_fts',
    cursor: null,
    recheckAt: null,
    circuitBreaker: input.circuitBreaker ?? null,
  };
}

function readCandidates(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  cursorSessionId: string | null,
  now: number
): SessionCandidate[] {
  const cutoff = now - config.groupedFtsCleanupMinSessionAgeMs;
  const rows = sql
    .exec(
      `SELECT
         s.id,
         COUNT(g.id) AS grouped_rows,
         COALESCE(SUM(length(CAST(g.content AS BLOB))), 0) AS content_bytes
       FROM chat_sessions s
       JOIN chat_messages_grouped g ON g.session_id = s.id
       WHERE s.status IN ('stopped', 'failed')
         AND s.updated_at <= ?
         AND s.materialized_at IS NOT NULL
         AND COALESCE(s.search_index_state, 'complete') != 'grouped_fts_pruned'
         AND NOT EXISTS (
           SELECT 1 FROM project_data_archive_source_intents intent
           WHERE intent.session_id = s.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_data_archive_targets target
           WHERE target.session_id = s.id
         )
         AND (? IS NULL OR s.id > ?)
       GROUP BY s.id
       ORDER BY s.id ASC
       LIMIT ?`,
      cutoff,
      cursorSessionId,
      cursorSessionId ?? '',
      config.groupedFtsCleanupBatchSessions + 1
    )
    .raw();

  const candidates: SessionCandidate[] = [];
  for (const row of rows) {
    const sessionId = row[0];
    const groupedRows = Number(row[1]);
    const contentBytes = Number(row[2]);
    if (
      typeof sessionId === 'string' &&
      Number.isSafeInteger(groupedRows) &&
      groupedRows > 0 &&
      Number.isFinite(contentBytes)
    ) {
      candidates.push({ sessionId, groupedRows, contentBytes });
    }
  }
  return candidates;
}

function deleteGroupedFtsForSession(
  sql: SqlStorage,
  sessionId: string,
  now: number
): {
  skipped: boolean;
  groupedRowsDeleted: number;
  ftsRowsDeleted: number;
  contentBytes: number;
} {
  const archivePlacement = sql
    .exec(
      `SELECT 1 AS fenced FROM project_data_archive_source_intents WHERE session_id = ?
       UNION ALL
       SELECT 1 AS fenced FROM project_data_archive_targets WHERE session_id = ?
       LIMIT 1`,
      sessionId,
      sessionId
    )
    .toArray()[0];
  if (archivePlacement) {
    return { skipped: true, groupedRowsDeleted: 0, ftsRowsDeleted: 0, contentBytes: 0 };
  }
  const rows = sql
    .exec(
      `SELECT rowid, content, length(CAST(content AS BLOB)) AS content_bytes
       FROM chat_messages_grouped
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC`,
      sessionId
    )
    .raw();

  let groupedRowsDeleted = 0;
  let ftsRowsDeleted = 0;
  let contentBytes = 0;
  for (const row of rows) {
    const rowid = Number(row[0]);
    const content = row[1];
    const rowBytes = Number(row[2]);
    if (!Number.isSafeInteger(rowid) || typeof content !== 'string') continue;
    if (Number.isFinite(rowBytes)) contentBytes += rowBytes;
    try {
      sql.exec(
        `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
         VALUES('delete', ?, ?)`,
        rowid,
        content
      );
      ftsRowsDeleted++;
    } catch (error) {
      log.warn('fts_delete_marker_failed', { sessionId, rowid, ...serializeError(error) });
    }
    sql.exec('DELETE FROM chat_messages_grouped WHERE rowid = ?', rowid);
    groupedRowsDeleted++;
  }

  sql.exec(
    `UPDATE chat_sessions
     SET materialized_at = NULL,
         search_index_state = 'grouped_fts_pruned',
         search_index_updated_at = ?,
         search_index_degradation_reason = ?
     WHERE id = ?`,
    now,
    'Grouped/FTS derived rows were pruned for storage relief; search uses raw-message LIKE fallback for this terminal session.',
    sessionId
  );

  return { skipped: false, groupedRowsDeleted, ftsRowsDeleted, contentBytes };
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

export async function runProjectDataGroupedFtsCleanup(
  sql: SqlStorage,
  _env: Env,
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
  const pendingRecheckAt = readProjectDataGroupedFtsCleanupRecheckAt(sql);
  const cursorSessionId = readStorageSafetyMeta(sql, META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID);

  if (!config.groupedFtsCleanupEnabled) {
    clearGroupedFtsCleanupState(sql);
    return emptyResult({ projectId, beforeBytes, config, terminationReason: 'disabled' });
  }
  if (beforeBytes >= unsafeBytes) {
    clearGroupedFtsCleanupState(sql);
    return emptyResult({ projectId, beforeBytes, config, terminationReason: 'wall_unsafe' });
  }
  if (beforeBytes <= targetBytes) {
    clearGroupedFtsCleanupState(sql);
    return emptyResult({ projectId, beforeBytes, config, terminationReason: 'target_reached' });
  }
  if (pendingRecheckAt !== null && pendingRecheckAt > now) return null;
  if (!cursorSessionId && beforeBytes < triggerBytes && !options.allowStart) return null;

  const overloadSignal = hasRecentOverloadSignal(sql, now, config);
  if (overloadSignal) {
    const reason = `recent overload/reset signal: ${overloadSignal}`;
    writeGroupedFtsCleanupState(
      sql,
      cursorSessionId,
      now + config.groupedFtsCleanupRecheckMs,
      reason
    );
    return emptyResult({
      projectId,
      beforeBytes,
      config,
      terminationReason: 'circuit_breaker',
      circuitBreaker: 'recent_overload_or_reset',
    });
  }

  const deadlineMs = now + config.groupedFtsCleanupWallTimeMs;
  const nowMs = options.nowMs ?? Date.now;
  const candidates = readCandidates(sql, config, cursorSessionId, now);
  if (candidates.length === 0) {
    clearGroupedFtsCleanupState(sql);
    return emptyResult({
      projectId,
      beforeBytes,
      config,
      terminationReason: 'candidates_exhausted',
    });
  }

  let rowsExamined = 0;
  let sessionsExamined = 0;
  let sessionsCleaned = 0;
  let groupedRowsDeleted = 0;
  let ftsRowsDeleted = 0;
  let originalContentBytes = 0;
  let terminationReason: ProjectDataCleanupTerminationReason = 'candidates_exhausted';
  let lastProcessedSessionId: string | null = cursorSessionId;
  let shouldContinue = false;

  for (const candidate of candidates) {
    if (sessionsExamined >= config.groupedFtsCleanupBatchSessions) {
      terminationReason = 'row_budget';
      shouldContinue = true;
      break;
    }
    if (sessionsExamined > 0 && nowMs() >= deadlineMs) {
      terminationReason = 'wall_time';
      shouldContinue = true;
      break;
    }
    sessionsExamined++;
    rowsExamined += candidate.groupedRows;

    if (candidate.groupedRows > config.groupedFtsCleanupBatchRows) {
      terminationReason = 'oversized_skip';
      lastProcessedSessionId = candidate.sessionId;
      shouldContinue = true;
      continue;
    }
    if (groupedRowsDeleted + candidate.groupedRows > config.groupedFtsCleanupBatchRows) {
      terminationReason = 'row_budget';
      shouldContinue = true;
      break;
    }
    if (originalContentBytes + candidate.contentBytes > config.groupedFtsCleanupBatchBytes) {
      if (candidate.contentBytes > config.groupedFtsCleanupBatchBytes) {
        terminationReason = 'oversized_skip';
        lastProcessedSessionId = candidate.sessionId;
        shouldContinue = true;
        continue;
      }
      terminationReason = 'byte_budget';
      shouldContinue = true;
      break;
    }

    const deleted = deleteGroupedFtsForSession(sql, candidate.sessionId, now);
    if (deleted.skipped) {
      lastProcessedSessionId = candidate.sessionId;
      shouldContinue = true;
      continue;
    }
    groupedRowsDeleted += deleted.groupedRowsDeleted;
    ftsRowsDeleted += deleted.ftsRowsDeleted;
    originalContentBytes += deleted.contentBytes;
    sessionsCleaned++;
    lastProcessedSessionId = candidate.sessionId;

    if (nowMs() >= deadlineMs) {
      terminationReason = 'wall_time';
      shouldContinue = true;
      break;
    }
  }

  if (candidates.length > config.groupedFtsCleanupBatchSessions) {
    shouldContinue = true;
    if (terminationReason === 'candidates_exhausted') terminationReason = 'row_budget';
  }

  const afterBytes = sql.databaseSize;
  const reclaimedBytes = Math.max(beforeBytes - afterBytes, 0);
  if (groupedRowsDeleted > 0 && reclaimedBytes < config.groupedFtsCleanupWeakReclaimBytes) {
    terminationReason = 'weak_reclaim';
    shouldContinue = false;
    writeStorageSafetyMeta(
      sql,
      META_LAST_ERROR,
      truncateStorageSafetyMetaValue(
        `grouped FTS cleanup weak reclaim: rows=${groupedRowsDeleted}, reclaimedBytes=${reclaimedBytes}`,
        500
      )
    );
  }

  const recheckAt = shouldContinue ? now + config.groupedFtsCleanupRecheckMs : null;
  if (shouldContinue) {
    writeGroupedFtsCleanupState(sql, lastProcessedSessionId, recheckAt);
  } else {
    clearGroupedFtsCleanupState(sql);
  }

  const result: ProjectDataGroupedFtsCleanupResult = {
    projectId,
    beforeBytes,
    afterBytes,
    reclaimedBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    rowsExamined,
    sessionsExamined,
    sessionsCleaned,
    groupedRowsDeleted,
    ftsRowsDeleted,
    originalContentBytes,
    terminationReason,
    searchSemantics: groupedRowsDeleted > 0 ? 'partial_raw_like_fallback' : 'full_fts',
    cursor: shouldContinue && lastProcessedSessionId ? { sessionId: lastProcessedSessionId } : null,
    recheckAt,
    circuitBreaker: null,
  };

  if (groupedRowsDeleted > 0 || terminationReason !== 'candidates_exhausted') {
    log.warn('completed', result);
  }
  return result;
}
