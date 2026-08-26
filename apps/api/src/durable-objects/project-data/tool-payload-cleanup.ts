import { createModuleLogger, serializeError } from '../../lib/logger';
import type { ProjectDataStorageTelemetry, StorageSafetyConfig } from './storage-safety';
import {
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import {
  hasToolPayloadCandidatesAfter,
  scanToolPayloadCandidates,
  selectToolPayloadCandidates,
  type ToolPayloadCandidate,
  type ToolPayloadCleanupCursor,
} from './tool-payload-cleanup-candidates';
import {
  clearToolPayloadCleanupState,
  publicToolPayloadCleanupCursor,
  readProjectDataToolPayloadArchiveLastRunAt as readToolPayloadArchiveLastRunAt,
  readProjectDataToolPayloadCleanupRecheckAt as readToolPayloadCleanupRecheckAt,
  readToolPayloadCleanupCursor,
  writeProjectDataToolPayloadArchiveLastRunAt,
  writeToolPayloadCleanupCursor,
  writeToolPayloadCleanupRecheckAt,
} from './tool-payload-cleanup-state';
import type {
  ProjectDataToolPayloadCleanupOptions,
  ProjectDataToolPayloadCleanupResult,
} from './tool-payload-cleanup-types';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_cleanup');

export { DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX } from './tool-payload-archive';
export {
  readProjectDataToolPayloadArchiveLastRunAt,
  readProjectDataToolPayloadCleanupRecheckAt,
} from './tool-payload-cleanup-state';
export type {
  ProjectDataToolPayloadCleanupOptions,
  ProjectDataToolPayloadCleanupResult,
} from './tool-payload-cleanup-types';

type ToolPayloadCleanupReason = 'retention_due' | 'storage_pressure' | 'continuation';

type ToolPayloadCleanupPlan = {
  projectId: string;
  reason: ToolPayloadCleanupReason;
  now: number;
  nowMs?: () => number;
  beforeBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  batchBytes: number;
  maxRowBytes: number;
  cutoffCreatedAt: number;
  deadlineMs: number;
  pendingCursor: ToolPayloadCleanupCursor | null;
};

type ToolPayloadCleanupBatch = {
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
  rowsFailed: number;
  toolMetadataBytesScanned: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  errorMessages: string[];
  lastCursor: ToolPayloadCleanupCursor | null;
  pauseCursor: ToolPayloadCleanupCursor | null;
  retryableFailure: boolean;
  hasMoreCandidates: boolean;
};

function createToolPayloadCleanupPlan(
  sql: SqlStorage,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions
): ToolPayloadCleanupPlan | null {
  if (!config.enabled || !config.toolPayloadCleanupEnabled || !projectId) return null;
  const now = options.now ?? Date.now();

  const beforeBytes = sql.databaseSize;
  const triggerBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTriggerRatio);
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const pendingCursor = readToolPayloadCleanupCursor(sql);
  const pendingRecheckAt = readToolPayloadCleanupRecheckAt(sql);
  const lastArchiveRunAt = readToolPayloadArchiveLastRunAt(sql);
  const retentionDue =
    lastArchiveRunAt === null || now - lastArchiveRunAt >= config.toolPayloadArchiveIntervalMs;
  const hasPendingCleanup = pendingCursor !== null || pendingRecheckAt !== null;
  const underStoragePressure =
    beforeBytes >= triggerBytes || (hasPendingCleanup && beforeBytes > targetBytes);

  if (pendingRecheckAt !== null && pendingRecheckAt > now) {
    return null;
  }
  if (!hasPendingCleanup && !retentionDue && !options.allowStart) {
    return null;
  }
  if (!hasPendingCleanup && !retentionDue && !underStoragePressure) {
    clearToolPayloadCleanupState(sql);
    return null;
  }

  let reason: ToolPayloadCleanupReason = 'retention_due';
  if (hasPendingCleanup) {
    reason = 'continuation';
  } else if (underStoragePressure) {
    reason = 'storage_pressure';
  }

  return {
    projectId,
    reason,
    now,
    beforeBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    batchRows: config.toolPayloadCleanupBatchRows,
    batchBytes: config.toolPayloadCleanupBatchBytes,
    maxRowBytes: config.toolPayloadCleanupMaxRowBytes,
    cutoffCreatedAt: now - config.toolPayloadArchiveRetentionMs,
    deadlineMs: now + config.toolPayloadCleanupWallTimeMs,
    pendingCursor,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  };
}

function createEmptyToolPayloadCleanupBatch(): ToolPayloadCleanupBatch {
  return {
    sessionsScanned: 0,
    rowsScanned: 0,
    rowsUpdated: 0,
    rowsFailed: 0,
    toolMetadataBytesScanned: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    errorMessages: [],
    lastCursor: null,
    pauseCursor: null,
    retryableFailure: false,
    hasMoreCandidates: false,
  };
}

function countSessions(candidates: ToolPayloadCandidate[]): number {
  return new Set(candidates.map((candidate) => candidate.sessionId)).size;
}

async function scanToolPayloadCleanupBatch(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  plan: ToolPayloadCleanupPlan
): Promise<ToolPayloadCleanupBatch> {
  const batch = createEmptyToolPayloadCleanupBatch();
  const candidates = selectToolPayloadCandidates(
    sql,
    plan.pendingCursor,
    plan.cutoffCreatedAt,
    plan.batchRows,
    plan.batchBytes,
    true
  );

  if (candidates.length === 0) {
    return batch;
  }

  const scanned = await scanToolPayloadCandidates({
    sql,
    env,
    projectId: plan.projectId,
    archivePrefix: config.toolPayloadArchiveR2Prefix,
    batchBytes: plan.batchBytes,
    maxRowBytes: plan.maxRowBytes,
    candidates,
    initialCursor: plan.pendingCursor,
    archivedAt: plan.now,
    deadlineMs: plan.deadlineMs,
    ...(plan.nowMs ? { nowMs: plan.nowMs } : {}),
  });

  batch.sessionsScanned = countSessions(candidates.slice(0, scanned.rowsScanned));
  batch.rowsScanned = scanned.rowsScanned;
  batch.rowsUpdated = scanned.rowsUpdated;
  batch.rowsFailed = scanned.rowsFailed;
  batch.toolMetadataBytesScanned = scanned.toolMetadataBytesScanned;
  batch.toolMetadataBytesRead = scanned.toolMetadataBytesRead;
  batch.originalToolMetadataBytes = scanned.originalToolMetadataBytes;
  batch.storedToolMetadataBytes = scanned.storedToolMetadataBytes;
  batch.errorMessages.push(...scanned.errorMessages);
  batch.lastCursor = scanned.lastCursor;
  batch.retryableFailure = scanned.retryableFailure;

  if (scanned.retryableFailure) {
    batch.hasMoreCandidates = true;
    batch.pauseCursor = scanned.retryCursor;
    return batch;
  }

  if (scanned.pausedForWallTime) {
    batch.hasMoreCandidates = true;
    batch.pauseCursor = scanned.retryCursor ?? scanned.lastCursor;
    return batch;
  }

  const lastCursor = scanned.lastCursor;
  if (lastCursor && hasToolPayloadCandidatesAfter(sql, lastCursor, plan.cutoffCreatedAt)) {
    batch.hasMoreCandidates = true;
    batch.pauseCursor = lastCursor;
  }

  return batch;
}

function resolveContinuationCursor(
  batch: ToolPayloadCleanupBatch
): ToolPayloadCleanupCursor | null {
  if (!batch.hasMoreCandidates) return null;
  if (batch.retryableFailure) return batch.pauseCursor;
  return batch.pauseCursor ?? batch.lastCursor;
}

function persistToolPayloadCleanupState(
  sql: SqlStorage,
  continuationCursor: ToolPayloadCleanupCursor | null,
  recheckAt: number | null
): void {
  if (continuationCursor && recheckAt !== null) {
    writeToolPayloadCleanupCursor(sql, continuationCursor, recheckAt);
  } else if (recheckAt !== null) {
    clearToolPayloadCleanupState(sql);
    writeToolPayloadCleanupRecheckAt(sql, recheckAt);
  } else {
    clearToolPayloadCleanupState(sql);
  }
}

function buildToolPayloadCleanupResult(
  plan: ToolPayloadCleanupPlan,
  batch: ToolPayloadCleanupBatch,
  afterBytes: number,
  shouldContinue: boolean,
  continuationCursor: ToolPayloadCleanupCursor | null,
  exhaustedCandidates: boolean,
  recheckAt: number | null
): ProjectDataToolPayloadCleanupResult {
  return {
    projectId: plan.projectId,
    beforeBytes: plan.beforeBytes,
    afterBytes,
    limitBytes: plan.limitBytes,
    triggerBytes: plan.triggerBytes,
    targetBytes: plan.targetBytes,
    batchRows: plan.batchRows,
    batchBytes: plan.batchBytes,
    maxRowBytes: plan.maxRowBytes,
    sessionsScanned: batch.sessionsScanned,
    rowsScanned: batch.rowsScanned,
    rowsUpdated: batch.rowsUpdated,
    rowsFailed: batch.rowsFailed,
    toolMetadataBytesScanned: batch.toolMetadataBytesScanned,
    toolMetadataBytesRead: batch.toolMetadataBytesRead,
    originalToolMetadataBytes: batch.originalToolMetadataBytes,
    storedToolMetadataBytes: batch.storedToolMetadataBytes,
    cursor: shouldContinue ? publicToolPayloadCleanupCursor(continuationCursor) : null,
    exhaustedCandidates,
    recheckAt,
  };
}

function summarizeToolPayloadCleanupFailures(batch: ToolPayloadCleanupBatch): string | null {
  if (batch.rowsFailed <= 0 && batch.errorMessages.length === 0) return null;
  const details = batch.errorMessages.length > 0 ? `: ${batch.errorMessages[0]}` : '';
  return truncate(
    `tool payload archive cleanup failed closed ${batch.rowsFailed} candidate(s)${details}`,
    500
  );
}

function recordToolPayloadCleanupFailureMeta(
  sql: SqlStorage,
  projectId: string,
  batch: ToolPayloadCleanupBatch
): string | null {
  const message = summarizeToolPayloadCleanupFailures(batch);
  if (!message) return null;
  writeMeta(sql, META_LAST_ERROR, message);
  log.warn('candidate_failed_closed', {
    projectId,
    rowsFailed: batch.rowsFailed,
    retryableFailure: batch.retryableFailure,
    errors: batch.errorMessages.slice(0, 3),
  });
  return message;
}

async function recordToolPayloadCleanupTelemetry(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions,
  projectId: string,
  afterBytes: number,
  rowsUpdated: number,
  lastError: string | null
): Promise<void> {
  if (rowsUpdated <= 0 && !lastError) return;

  const measuredAt = Date.now();
  writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
  const statusAfter = options.classifyStatus(afterBytes);
  writeMeta(sql, META_LAST_STATUS, statusAfter);
  const telemetry: ProjectDataStorageTelemetry = {
    projectId,
    measuredAt,
    databaseSizeBytes: afterBytes,
    limitBytes: config.limitBytes,
    usageRatio: afterBytes / config.limitBytes,
    status: statusAfter,
    growthRateBytesPerDay: null,
    estimatedDaysToLimit: null,
    cleanupHealth: null,
    reclaimableBytes: null,
    categoryBreakdown: null,
  };

  try {
    await options.recordTelemetry(telemetry, {
      lastPurgeAt: rowsUpdated > 0 ? measuredAt : null,
      lastPurgeReason: rowsUpdated > 0 ? 'auto_tool_payload_archive_cleanup' : null,
      lastPurgeRows: rowsUpdated > 0 ? rowsUpdated : null,
      lastPurgeDatabaseSizeBytes: rowsUpdated > 0 ? afterBytes : null,
      lastError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    log.warn('telemetry_upsert_failed', {
      projectId,
      ...serializeError(error),
    });
  }
}

function shouldReturnToolPayloadCleanupResult(
  batch: ToolPayloadCleanupBatch,
  exhaustedCandidates: boolean,
  shouldContinue: boolean
): boolean {
  return (
    batch.rowsScanned > 0 ||
    batch.rowsUpdated > 0 ||
    batch.rowsFailed > 0 ||
    exhaustedCandidates ||
    shouldContinue
  );
}

function buildFailedToolPayloadCleanupResult(
  plan: ToolPayloadCleanupPlan,
  recheckAt: number
): ProjectDataToolPayloadCleanupResult {
  return {
    projectId: plan.projectId,
    beforeBytes: plan.beforeBytes,
    afterBytes: plan.beforeBytes,
    limitBytes: plan.limitBytes,
    triggerBytes: plan.triggerBytes,
    targetBytes: plan.targetBytes,
    batchRows: plan.batchRows,
    batchBytes: plan.batchBytes,
    maxRowBytes: plan.maxRowBytes,
    sessionsScanned: 0,
    rowsScanned: 0,
    rowsUpdated: 0,
    rowsFailed: 1,
    toolMetadataBytesScanned: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    cursor: publicToolPayloadCleanupCursor(plan.pendingCursor),
    exhaustedCandidates: false,
    recheckAt,
  };
}

async function handleToolPayloadCleanupFailure(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions,
  plan: ToolPayloadCleanupPlan,
  error: unknown
): Promise<ProjectDataToolPayloadCleanupResult> {
  const recheckAt = plan.now + config.toolPayloadCleanupRecheckMs;
  if (plan.pendingCursor) {
    writeToolPayloadCleanupCursor(sql, plan.pendingCursor, recheckAt);
  } else {
    writeToolPayloadCleanupRecheckAt(sql, recheckAt);
  }

  const message = truncate(error instanceof Error ? error.message : String(error), 500);
  writeMeta(sql, META_LAST_ERROR, message);
  log.warn('failed_retry_scheduled', {
    projectId: plan.projectId,
    recheckAt,
    ...serializeError(error),
  });

  await recordToolPayloadCleanupTelemetry(
    sql,
    config,
    options,
    plan.projectId,
    plan.beforeBytes,
    0,
    message
  );
  return buildFailedToolPayloadCleanupResult(plan, recheckAt);
}

export async function runProjectDataToolPayloadCleanup(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions
): Promise<ProjectDataToolPayloadCleanupResult | null> {
  const plan = createToolPayloadCleanupPlan(sql, projectId, config, options);
  if (!plan) return null;

  let batch: ToolPayloadCleanupBatch;
  try {
    batch = await scanToolPayloadCleanupBatch(sql, env, config, plan);
  } catch (error) {
    return handleToolPayloadCleanupFailure(sql, config, options, plan, error);
  }
  const afterBytes = sql.databaseSize;
  const continuationCursor = resolveContinuationCursor(batch);
  const shouldContinue = batch.hasMoreCandidates;
  const recheckAt = shouldContinue ? plan.now + config.toolPayloadCleanupRecheckMs : null;
  persistToolPayloadCleanupState(sql, continuationCursor, recheckAt);

  const exhaustedCandidates =
    plan.reason === 'storage_pressure' && afterBytes > plan.targetBytes && !shouldContinue;
  if (!shouldContinue) {
    writeProjectDataToolPayloadArchiveLastRunAt(sql, plan.now);
  }

  const result = buildToolPayloadCleanupResult(
    plan,
    batch,
    afterBytes,
    shouldContinue,
    continuationCursor,
    exhaustedCandidates,
    recheckAt
  );
  const failureMessage = recordToolPayloadCleanupFailureMeta(sql, plan.projectId, batch);
  await recordToolPayloadCleanupTelemetry(
    sql,
    config,
    options,
    plan.projectId,
    afterBytes,
    batch.rowsUpdated,
    failureMessage
  );
  if (batch.rowsUpdated > 0 || batch.rowsFailed > 0 || exhaustedCandidates) {
    log.warn('completed', { reason: plan.reason, ...result });
  }

  return shouldReturnToolPayloadCleanupResult(batch, exhaustedCandidates, shouldContinue)
    ? result
    : null;
}
