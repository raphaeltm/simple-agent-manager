import { createModuleLogger, serializeError } from '../../lib/logger';
import type { ProjectDataStorageTelemetry, StorageSafetyConfig } from './storage-safety';
import {
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import type { ToolPayloadArchiveOperationBudget } from './tool-payload-archive-r2';
import { readNextToolPayloadCleanupRetryAt } from './tool-payload-cleanup-attempts';
import {
  clearRearchivableOversizedToolPayloadCleanupAttempts,
  scanToolPayloadCandidates,
  selectToolPayloadCandidates,
  type ToolPayloadCandidate,
  type ToolPayloadCleanupCursor,
} from './tool-payload-cleanup-candidates';
import {
  readToolPayloadCleanupManifestBatch,
  readToolPayloadCleanupManifestRoot,
} from './tool-payload-cleanup-manifest';
import {
  clearToolPayloadCleanupContinuationState,
  clearToolPayloadCleanupState,
  hasCompleteLegacyV2ToolPayloadCleanupCursor,
  isToolPayloadCleanupPlanTerminal,
  publicToolPayloadCleanupCursor,
  readProjectDataToolPayloadArchiveLastRunAt as readToolPayloadArchiveLastRunAt,
  readProjectDataToolPayloadCleanupRecheckAt as readToolPayloadCleanupRecheckAt,
  readToolPayloadCleanupCumulativeProgress,
  readToolPayloadCleanupCursor,
  readToolPayloadCleanupPersistedPlan,
  type ToolPayloadCleanupCumulativeProgress,
  writeProjectDataToolPayloadArchiveLastRunAt,
  writeToolPayloadCleanupCumulativeProgress,
  writeToolPayloadCleanupCursor,
  writeToolPayloadCleanupPlanTerminal,
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

type ToolPayloadCleanupReason = 'retention_due' | 'storage_pressure' | 'continuation' | 'manual';

type ToolPayloadCleanupPlan = {
  projectId: string;
  planId: string;
  fingerprint: string;
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
  archiveRetryDelayMs: number;
  archiveWriteTimeoutMs: number;
  archiveMaxOperations: number;
  archiveChunkBytes: number;
  archiveMaxMetadataBytes: number;
  cutoffCreatedAt: number;
  deadlineMs: number;
  wallClockStart: number;
  manifestKey: string | null;
  manifestSha256: string | null;
  batchManifestMaxBytes: number;
  rootManifestMaxBytes: number;
  maxTotalRows: number | null;
  maxTotalBytes: number | null;
  maxTotalR2Operations: number | null;
  maxTotalWallTimeMs: number | null;
  reservedR2Operations: number;
  reservedWallTimeMs: number;
  cumulative: ToolPayloadCleanupCumulativeProgress;
  pendingCursor: ToolPayloadCleanupCursor | null;
  transactionSync?: <T>(callback: () => T) => T;
};

type ToolPayloadCleanupBatch = {
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
  approvedRowsCompleted: number;
  approvedBytesCompleted: number;
  archiveOperations: number;
  rowsFailed: number;
  rearchivableOversizedAttemptsReset: number;
  toolMetadataBytesScanned: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  errorMessages: string[];
  lastCursor: ToolPayloadCleanupCursor | null;
  pauseCursor: ToolPayloadCleanupCursor | null;
  retryableFailure: boolean;
  hasMoreCandidates: boolean;
  nextRetryAt: number | null;
};

function createToolPayloadCleanupPlan(
  sql: SqlStorage,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions
): ToolPayloadCleanupPlan | null {
  if (!config.enabled || !config.toolPayloadCleanupEnabled || !projectId) return null;
  const fixedCutoffConfigured = config.toolPayloadCleanupCutoffCreatedAt !== null;
  if (
    fixedCutoffConfigured &&
    (!config.toolPayloadCleanupExactConfigValid ||
      config.toolPayloadCleanupCutoffCreatedAt === -1 ||
      !config.toolPayloadCleanupPlanId ||
      !config.toolPayloadCleanupManifestKey ||
      !config.toolPayloadCleanupManifestSha256 ||
      !/^[a-f0-9]{64}$/.test(config.toolPayloadCleanupManifestSha256) ||
      config.toolPayloadCleanupMaxTotalRows === null ||
      config.toolPayloadCleanupMaxTotalBytes === null ||
      config.toolPayloadCleanupMaxTotalR2Operations === null ||
      config.toolPayloadCleanupMaxTotalWallTimeMs === null ||
      !options.transactionSync ||
      config.toolPayloadCleanupProjectIds?.length !== 1 ||
      config.toolPayloadCleanupProjectIds[0] !== projectId)
  ) {
    return null;
  }
  if (
    !options.forceStart &&
    config.toolPayloadCleanupProjectIds !== null &&
    !config.toolPayloadCleanupProjectIds.includes(projectId)
  ) {
    return null;
  }
  const now = options.now ?? Date.now();
  const wallClockStart = options.nowMs ? options.nowMs() : Date.now();
  if (
    config.toolPayloadCleanupCutoffCreatedAt !== null &&
    config.toolPayloadCleanupCutoffCreatedAt > now
  ) {
    return null;
  }

  const beforeBytes = sql.databaseSize;
  const triggerBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTriggerRatio);
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  let pendingCursor = readToolPayloadCleanupCursor(sql);
  let persistedPlan = readToolPayloadCleanupPersistedPlan(sql);
  let pendingRecheckAt = readToolPayloadCleanupRecheckAt(sql);
  const lastArchiveRunAt = readToolPayloadArchiveLastRunAt(sql);
  const retentionDue =
    lastArchiveRunAt === null || now - lastArchiveRunAt >= config.toolPayloadArchiveIntervalMs;
  let hasPendingCleanup = pendingCursor !== null || pendingRecheckAt !== null;
  if (hasPendingCleanup && !persistedPlan) {
    if (fixedCutoffConfigured && !hasCompleteLegacyV2ToolPayloadCleanupCursor(sql)) return null;
    // Compatibility with the production v2 cursor/recheck state, which
    // predates immutable plan fingerprints. Source payloads remain
    // authoritative. A fixed plan has already passed exact manifest/project/
    // cap validation above, so it can safely supersede the old broad cursor.
    clearToolPayloadCleanupState(sql);
    pendingCursor = null;
    pendingRecheckAt = null;
    persistedPlan = null;
    hasPendingCleanup = false;
  }
  const cutoffCreatedAt = persistedPlan
    ? persistedPlan.cutoffCreatedAt
    : (config.toolPayloadCleanupCutoffCreatedAt ?? now - config.toolPayloadArchiveRetentionMs);
  const planId = config.toolPayloadCleanupPlanId ?? 'automatic-retention';
  const cumulative = readToolPayloadCleanupCumulativeProgress(sql);
  const fingerprint = JSON.stringify({
    projectId,
    planId,
    cutoffCreatedAt,
    targetRatio: config.toolPayloadCleanupTargetRatio,
    batchRows: config.toolPayloadCleanupBatchRows,
    batchBytes: config.toolPayloadCleanupBatchBytes,
    maxRowBytes: config.toolPayloadCleanupMaxRowBytes,
    wallTimeMs: config.toolPayloadCleanupWallTimeMs,
    archivePrefix: config.toolPayloadArchiveR2Prefix,
    archiveWriteTimeoutMs: config.toolPayloadArchiveWriteTimeoutMs,
    archiveMaxOperations: config.toolPayloadArchiveMaxOperations,
    archiveChunkBytes: config.toolPayloadArchiveChunkBytes,
    archiveMaxMetadataBytes: config.toolPayloadArchiveMaxMetadataBytes,
    manifestKey: config.toolPayloadCleanupManifestKey,
    manifestSha256: config.toolPayloadCleanupManifestSha256,
    batchManifestMaxBytes: config.toolPayloadCleanupBatchManifestMaxBytes,
    rootManifestMaxBytes: config.toolPayloadCleanupRootManifestMaxBytes,
    maxTotalRows: config.toolPayloadCleanupMaxTotalRows,
    maxTotalBytes: config.toolPayloadCleanupMaxTotalBytes,
    maxTotalR2Operations: config.toolPayloadCleanupMaxTotalR2Operations,
    maxTotalWallTimeMs: config.toolPayloadCleanupMaxTotalWallTimeMs,
  });
  if (
    persistedPlan &&
    (persistedPlan.planId !== planId ||
      persistedPlan.fingerprint !== fingerprint ||
      (fixedCutoffConfigured &&
        persistedPlan.cutoffCreatedAt !== config.toolPayloadCleanupCutoffCreatedAt))
  ) {
    return null;
  }
  if (fixedCutoffConfigured && persistedPlan && isToolPayloadCleanupPlanTerminal(sql)) {
    return null;
  }
  if (
    fixedCutoffConfigured &&
    (cumulative.rows >= (config.toolPayloadCleanupMaxTotalRows ?? 0) ||
      cumulative.bytes >= (config.toolPayloadCleanupMaxTotalBytes ?? 0) ||
      cumulative.r2Operations >= (config.toolPayloadCleanupMaxTotalR2Operations ?? 0) ||
      cumulative.wallTimeMs >= (config.toolPayloadCleanupMaxTotalWallTimeMs ?? 0))
  ) {
    return null;
  }
  const underStoragePressure =
    beforeBytes >= triggerBytes || (hasPendingCleanup && beforeBytes > targetBytes);

  if (pendingRecheckAt !== null && pendingRecheckAt > now && !options.forceStart) {
    return null;
  }
  if (fixedCutoffConfigured && beforeBytes <= targetBytes) {
    return null;
  }
  if (!hasPendingCleanup && !retentionDue && !options.allowStart && !options.forceStart) {
    return null;
  }
  if (!hasPendingCleanup && !retentionDue && !underStoragePressure && !options.forceStart) {
    clearToolPayloadCleanupState(sql);
    return null;
  }

  let reason: ToolPayloadCleanupReason = 'retention_due';
  if (options.forceStart && !hasPendingCleanup && !retentionDue && !underStoragePressure) {
    reason = 'manual';
  } else if (hasPendingCleanup) {
    reason = 'continuation';
  } else if (underStoragePressure) {
    reason = 'storage_pressure';
  }

  const remainingTotalWallTimeMs = config.toolPayloadCleanupMaxTotalWallTimeMs
    ? config.toolPayloadCleanupMaxTotalWallTimeMs - cumulative.wallTimeMs
    : config.toolPayloadCleanupWallTimeMs;
  const passWallTimeMs = Math.min(config.toolPayloadCleanupWallTimeMs, remainingTotalWallTimeMs);
  const remainingTotalR2Operations = config.toolPayloadCleanupMaxTotalR2Operations
    ? config.toolPayloadCleanupMaxTotalR2Operations - cumulative.r2Operations
    : config.toolPayloadArchiveMaxOperations;
  const passR2Operations = Math.min(
    config.toolPayloadArchiveMaxOperations,
    remainingTotalR2Operations
  );
  return {
    projectId,
    planId,
    fingerprint,
    reason,
    now,
    beforeBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    batchRows: config.toolPayloadCleanupBatchRows,
    batchBytes: config.toolPayloadCleanupBatchBytes,
    maxRowBytes: config.toolPayloadCleanupMaxRowBytes,
    archiveRetryDelayMs: config.toolPayloadArchiveRetryDelayMs,
    archiveWriteTimeoutMs: config.toolPayloadArchiveWriteTimeoutMs,
    archiveMaxOperations: config.toolPayloadArchiveMaxOperations,
    archiveChunkBytes: config.toolPayloadArchiveChunkBytes,
    archiveMaxMetadataBytes: config.toolPayloadArchiveMaxMetadataBytes,
    cutoffCreatedAt,
    deadlineMs: wallClockStart + passWallTimeMs,
    wallClockStart,
    manifestKey: config.toolPayloadCleanupManifestKey,
    manifestSha256: config.toolPayloadCleanupManifestSha256,
    batchManifestMaxBytes: config.toolPayloadCleanupBatchManifestMaxBytes,
    rootManifestMaxBytes: config.toolPayloadCleanupRootManifestMaxBytes,
    maxTotalRows: config.toolPayloadCleanupMaxTotalRows,
    maxTotalBytes: config.toolPayloadCleanupMaxTotalBytes,
    maxTotalR2Operations: config.toolPayloadCleanupMaxTotalR2Operations,
    maxTotalWallTimeMs: config.toolPayloadCleanupMaxTotalWallTimeMs,
    reservedR2Operations: fixedCutoffConfigured ? passR2Operations : 0,
    reservedWallTimeMs: fixedCutoffConfigured ? passWallTimeMs : 0,
    cumulative,
    pendingCursor,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.transactionSync ? { transactionSync: options.transactionSync } : {}),
  };
}

function createEmptyToolPayloadCleanupBatch(): ToolPayloadCleanupBatch {
  return {
    sessionsScanned: 0,
    rowsScanned: 0,
    rowsUpdated: 0,
    approvedRowsCompleted: 0,
    approvedBytesCompleted: 0,
    archiveOperations: 0,
    rowsFailed: 0,
    rearchivableOversizedAttemptsReset: 0,
    toolMetadataBytesScanned: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    errorMessages: [],
    lastCursor: null,
    pauseCursor: null,
    retryableFailure: false,
    hasMoreCandidates: false,
    nextRetryAt: null,
  };
}

function countSessions(candidates: ToolPayloadCandidate[]): number {
  return new Set(candidates.map((candidate) => candidate.sessionId)).size;
}

async function scanApprovedToolPayloadCleanupBatch(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  plan: ToolPayloadCleanupPlan
): Promise<ToolPayloadCleanupBatch> {
  const batch = createEmptyToolPayloadCleanupBatch();
  const r2 = env.PROJECT_DATA_ARCHIVE_R2;
  if (
    !r2 ||
    !plan.manifestKey ||
    !plan.manifestSha256 ||
    plan.maxTotalRows === null ||
    plan.maxTotalBytes === null ||
    plan.maxTotalR2Operations === null
  ) {
    throw new Error('approved tool payload cleanup manifest configuration is incomplete');
  }
  const operationBudget: ToolPayloadArchiveOperationBudget = {
    used: 0,
    max: plan.reservedR2Operations,
  };
  const root = await readToolPayloadCleanupManifestRoot({
    r2,
    key: plan.manifestKey,
    sha256: plan.manifestSha256,
    timeoutMs: plan.archiveWriteTimeoutMs,
    deadlineMs: plan.deadlineMs,
    operationBudget,
    maxBytes: plan.rootManifestMaxBytes,
    ...(plan.nowMs ? { nowMs: plan.nowMs } : {}),
  });
  if (
    root.planId !== plan.planId ||
    root.projectId !== plan.projectId ||
    root.cutoffCreatedAt !== plan.cutoffCreatedAt ||
    root.eligibleRows > plan.maxTotalRows ||
    root.eligibleBytes > plan.maxTotalBytes
  ) {
    throw new Error('approved tool payload cleanup manifest does not match configured scope');
  }

  const remainingRows = plan.maxTotalRows - plan.cumulative.rows;
  const remainingBytes = plan.maxTotalBytes - plan.cumulative.bytes;
  const candidates: ToolPayloadCandidate[] = [];
  let candidateMetadataBytes = 0;
  let candidateProjectedBytes = 0;
  let previousManifestRowId = 0;
  let manifestHasMore = false;
  outer: for (const proof of root.batches) {
    if (plan.pendingCursor && proof.lastRowId <= plan.pendingCursor.rowId) {
      previousManifestRowId = proof.lastRowId;
      continue;
    }
    if (operationBudget.used + 2 > operationBudget.max) {
      manifestHasMore = true;
      break;
    }
    const manifestBatch = await readToolPayloadCleanupManifestBatch({
      r2,
      proof,
      root,
      timeoutMs: plan.archiveWriteTimeoutMs,
      deadlineMs: plan.deadlineMs,
      operationBudget,
      maxBytes: plan.batchManifestMaxBytes,
      ...(plan.nowMs ? { nowMs: plan.nowMs } : {}),
    });
    for (const target of manifestBatch.targets) {
      if (target.rowId <= previousManifestRowId) {
        throw new Error('approved tool payload cleanup targets are not globally ordered');
      }
      previousManifestRowId = target.rowId;
      if (plan.pendingCursor && target.rowId <= plan.pendingCursor.rowId) continue;
      const nextMetadataBytes = candidateMetadataBytes + target.toolMetadataBytes;
      const nextProjectedBytes = candidateProjectedBytes + target.projectedReclaimableBytes;
      if (
        candidates.length >= Math.min(plan.batchRows, remainingRows) ||
        (nextMetadataBytes > plan.batchBytes && candidates.length > 0) ||
        nextProjectedBytes > remainingBytes
      ) {
        manifestHasMore = true;
        break outer;
      }
      candidates.push({
        rowId: target.rowId,
        sessionId: target.sessionId,
        createdAt: target.messageCreatedAt,
        sequence: target.messageSequence,
        messageId: target.messageId,
        toolMetadataBytes: target.toolMetadataBytes,
        approvedToolMetadataSha256: target.toolMetadataSha256,
        projectedReclaimableBytes: target.projectedReclaimableBytes,
      });
      candidateMetadataBytes = nextMetadataBytes;
      candidateProjectedBytes = nextProjectedBytes;
    }
  }

  if (candidates.length === 0) {
    batch.archiveOperations = operationBudget.used;
    if (manifestHasMore) {
      throw new Error('approved cleanup budget cannot admit the next manifest target');
    }
    return batch;
  }
  const scanned = await scanToolPayloadCandidates({
    sql,
    env,
    projectId: plan.projectId,
    archivePrefix: config.toolPayloadArchiveR2Prefix,
    archiveRetryDelayMs: plan.archiveRetryDelayMs,
    archiveWriteTimeoutMs: plan.archiveWriteTimeoutMs,
    archiveMaxOperations: operationBudget.max,
    archiveChunkBytes: plan.archiveChunkBytes,
    archiveMaxMetadataBytes: plan.archiveMaxMetadataBytes,
    operationBudget,
    requireApprovedTargets: true,
    ...(plan.transactionSync ? { transactionSync: plan.transactionSync } : {}),
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
  batch.approvedRowsCompleted = scanned.approvedRowsCompleted;
  batch.approvedBytesCompleted = scanned.approvedBytesCompleted;
  batch.archiveOperations = scanned.archiveOperations;
  batch.rowsFailed = scanned.rowsFailed;
  batch.toolMetadataBytesScanned = scanned.toolMetadataBytesScanned;
  batch.toolMetadataBytesRead = scanned.toolMetadataBytesRead;
  batch.originalToolMetadataBytes = scanned.originalToolMetadataBytes;
  batch.storedToolMetadataBytes = scanned.storedToolMetadataBytes;
  batch.errorMessages.push(...scanned.errorMessages);
  batch.lastCursor = scanned.lastCursor;
  batch.retryableFailure = scanned.retryableFailure;
  if (scanned.retryableFailure || scanned.pausedForWallTime) {
    batch.hasMoreCandidates = true;
    batch.pauseCursor = scanned.retryCursor ?? scanned.lastCursor;
  } else if (manifestHasMore) {
    batch.hasMoreCandidates = true;
    batch.pauseCursor = scanned.lastCursor;
  }
  return batch;
}

async function scanToolPayloadCleanupBatch(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  plan: ToolPayloadCleanupPlan
): Promise<ToolPayloadCleanupBatch> {
  if (plan.manifestKey) {
    return scanApprovedToolPayloadCleanupBatch(sql, env, config, plan);
  }
  const batch = createEmptyToolPayloadCleanupBatch();
  const rearchivableResult = clearRearchivableOversizedToolPayloadCleanupAttempts(
    sql,
    plan.pendingCursor,
    plan.cutoffCreatedAt,
    plan.archiveMaxMetadataBytes,
    plan.batchRows
  );
  batch.rearchivableOversizedAttemptsReset = rearchivableResult.rowsChanged;
  const selection = selectToolPayloadCandidates(
    sql,
    plan.pendingCursor,
    plan.cutoffCreatedAt,
    plan.now,
    plan.batchRows,
    plan.batchBytes,
    true,
    config.storageReliefMeasureMaxBatchRows
  );
  const candidates = selection.candidates;

  if (candidates.length === 0) {
    if (selection.hasMore && selection.nextCursor) {
      batch.hasMoreCandidates = true;
      batch.pauseCursor = selection.nextCursor;
      return batch;
    }
    const nextRetryAt = readNextToolPayloadCleanupRetryAt(sql, plan.now);
    if (nextRetryAt !== null) {
      batch.hasMoreCandidates = true;
      batch.nextRetryAt = nextRetryAt;
    }
    return batch;
  }

  const scanned = await scanToolPayloadCandidates({
    sql,
    env,
    projectId: plan.projectId,
    archivePrefix: config.toolPayloadArchiveR2Prefix,
    archiveRetryDelayMs: plan.archiveRetryDelayMs,
    archiveWriteTimeoutMs: plan.archiveWriteTimeoutMs,
    archiveMaxOperations: plan.archiveMaxOperations,
    archiveChunkBytes: plan.archiveChunkBytes,
    archiveMaxMetadataBytes: plan.archiveMaxMetadataBytes,
    ...(plan.transactionSync ? { transactionSync: plan.transactionSync } : {}),
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
  batch.archiveOperations = scanned.archiveOperations;
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

  // Infer hasMore from the selection/rearchivable results instead of running
  // separate full-scan existence queries (the deleted hasToolPayloadCandidatesAfter
  // and hasRearchivableOversizedToolPayloadCleanupAttemptsAfter functions).
  const lastCursor = scanned.lastCursor;
  if (lastCursor && (selection.hasMore || rearchivableResult.hasMore)) {
    batch.hasMoreCandidates = true;
    batch.pauseCursor = selection.nextCursor ?? lastCursor;
    return batch;
  }

  const nextRetryAt = readNextToolPayloadCleanupRetryAt(sql, plan.now);
  if (nextRetryAt !== null) {
    batch.hasMoreCandidates = true;
    batch.nextRetryAt = nextRetryAt;
  }

  return batch;
}

function resolveContinuationCursor(
  batch: ToolPayloadCleanupBatch
): ToolPayloadCleanupCursor | null {
  if (!batch.hasMoreCandidates) return null;
  if (batch.nextRetryAt !== null) return null;
  if (batch.retryableFailure) return batch.pauseCursor;
  return batch.pauseCursor ?? batch.lastCursor;
}

function persistToolPayloadCleanupState(
  sql: SqlStorage,
  plan: ToolPayloadCleanupPlan,
  continuationCursor: ToolPayloadCleanupCursor | null,
  recheckAt: number | null
): void {
  if (continuationCursor && recheckAt !== null) {
    writeToolPayloadCleanupCursor(sql, continuationCursor, recheckAt, plan);
  } else if (recheckAt !== null) {
    if (plan.manifestKey) clearToolPayloadCleanupContinuationState(sql);
    else clearToolPayloadCleanupState(sql);
    writeToolPayloadCleanupRecheckAt(sql, recheckAt, plan);
  } else if (plan.manifestKey) {
    writeToolPayloadCleanupPlanTerminal(sql, plan);
  } else {
    clearToolPayloadCleanupState(sql);
  }
}

function reserveApprovedToolPayloadCleanupPass(
  sql: SqlStorage,
  plan: ToolPayloadCleanupPlan
): void {
  if (!plan.manifestKey) return;
  if (!plan.transactionSync) {
    throw new Error('approved tool payload cleanup requires transactional state reservation');
  }
  const reserved: ToolPayloadCleanupCumulativeProgress = {
    ...plan.cumulative,
    r2Operations: plan.cumulative.r2Operations + plan.reservedR2Operations,
    wallTimeMs: plan.cumulative.wallTimeMs + plan.reservedWallTimeMs,
  };
  plan.transactionSync(() => {
    if (plan.pendingCursor) {
      writeToolPayloadCleanupCursor(sql, plan.pendingCursor, plan.now, plan);
    } else {
      writeToolPayloadCleanupRecheckAt(sql, plan.now, plan);
    }
    writeToolPayloadCleanupCumulativeProgress(sql, reserved);
  });
  plan.cumulative = reserved;
}

function buildToolPayloadCleanupResult(
  plan: ToolPayloadCleanupPlan,
  batch: ToolPayloadCleanupBatch,
  afterBytes: number,
  terminationReason: ProjectDataToolPayloadCleanupResult['terminationReason'],
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
    cutoffCreatedAt: plan.cutoffCreatedAt,
    batchRows: plan.batchRows,
    batchBytes: plan.batchBytes,
    maxRowBytes: plan.maxRowBytes,
    sessionsScanned: batch.sessionsScanned,
    rowsScanned: batch.rowsScanned,
    rowsUpdated: batch.rowsUpdated,
    rowsFailed: batch.rowsFailed,
    rearchivableOversizedAttemptsReset: batch.rearchivableOversizedAttemptsReset,
    toolMetadataBytesScanned: batch.toolMetadataBytesScanned,
    toolMetadataBytesRead: batch.toolMetadataBytesRead,
    originalToolMetadataBytes: batch.originalToolMetadataBytes,
    storedToolMetadataBytes: batch.storedToolMetadataBytes,
    terminationReason,
    reclaimedBytes: Math.max(plan.beforeBytes - afterBytes, 0),
    cursor: shouldContinue ? publicToolPayloadCleanupCursor(continuationCursor) : null,
    exhaustedCandidates,
    recheckAt,
  };
}

function resolveToolPayloadTerminationReason(
  plan: ToolPayloadCleanupPlan,
  batch: ToolPayloadCleanupBatch,
  shouldContinue: boolean,
  exhaustedCandidates: boolean
): ProjectDataToolPayloadCleanupResult['terminationReason'] {
  if (batch.retryableFailure) return 'error';
  if (
    batch.errorMessages.some(
      (message) =>
        message.includes('per-row byte budget') || message.includes('archive metadata byte budget')
    )
  ) {
    return 'oversized_skip';
  }
  if (batch.errorMessages.length > 0) return 'error';
  if (batch.hasMoreCandidates && batch.nextRetryAt !== null) return 'oversized_skip';
  if (shouldContinue && batch.pauseCursor !== null && batch.rowsScanned >= plan.batchRows) {
    return 'row_budget';
  }
  if (shouldContinue && batch.toolMetadataBytesRead >= plan.batchBytes) return 'byte_budget';
  if (shouldContinue) return 'wall_time';
  if (exhaustedCandidates) return 'candidates_exhausted';
  return 'target_reached';
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
    const purgeReason = options.purgeReason ?? 'auto_tool_payload_archive_cleanup';
    await options.recordTelemetry(telemetry, {
      lastPurgeAt: rowsUpdated > 0 ? measuredAt : null,
      lastPurgeReason: rowsUpdated > 0 ? purgeReason : null,
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
    batch.rearchivableOversizedAttemptsReset > 0 ||
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
    cutoffCreatedAt: plan.cutoffCreatedAt,
    batchRows: plan.batchRows,
    batchBytes: plan.batchBytes,
    maxRowBytes: plan.maxRowBytes,
    sessionsScanned: 0,
    rowsScanned: 0,
    rowsUpdated: 0,
    rowsFailed: 1,
    rearchivableOversizedAttemptsReset: 0,
    toolMetadataBytesScanned: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    terminationReason: 'error',
    reclaimedBytes: 0,
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
    writeToolPayloadCleanupCursor(sql, plan.pendingCursor, recheckAt, plan);
  } else {
    writeToolPayloadCleanupRecheckAt(sql, recheckAt, plan);
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
    reserveApprovedToolPayloadCleanupPass(sql, plan);
    batch = await scanToolPayloadCleanupBatch(sql, env, config, plan);
  } catch (error) {
    return handleToolPayloadCleanupFailure(sql, config, options, plan, error);
  }
  const afterBytes = sql.databaseSize;
  const continuationCursor = resolveContinuationCursor(batch);
  const shouldContinue = batch.hasMoreCandidates;
  const recheckAt = shouldContinue
    ? (batch.nextRetryAt ?? plan.now + config.toolPayloadCleanupRecheckMs)
    : null;
  if (plan.manifestKey) {
    const transactionSync = plan.transactionSync;
    if (!transactionSync) {
      throw new Error('approved tool payload cleanup lost transactional state reservation');
    }
    transactionSync(() => {
      persistToolPayloadCleanupState(sql, plan, continuationCursor, recheckAt);
      writeToolPayloadCleanupCumulativeProgress(sql, {
        ...plan.cumulative,
        rows: plan.cumulative.rows + batch.approvedRowsCompleted,
        bytes: plan.cumulative.bytes + batch.approvedBytesCompleted,
      });
    });
  } else {
    persistToolPayloadCleanupState(sql, plan, continuationCursor, recheckAt);
  }

  const exhaustedCandidates =
    plan.reason === 'storage_pressure' && afterBytes > plan.targetBytes && !shouldContinue;
  if (!shouldContinue) {
    writeProjectDataToolPayloadArchiveLastRunAt(sql, plan.now);
  }

  const result = buildToolPayloadCleanupResult(
    plan,
    batch,
    afterBytes,
    resolveToolPayloadTerminationReason(plan, batch, shouldContinue, exhaustedCandidates),
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
