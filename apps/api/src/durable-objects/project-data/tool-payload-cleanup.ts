import { createModuleLogger, serializeError } from '../../lib/logger';
import type {
  ProjectDataStorageStatus,
  ProjectDataStorageTelemetry,
  StorageSafetyConfig,
} from './storage-safety';
import {
  deleteStorageSafetyMeta as deleteMeta,
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import {
  hasToolPayloadCandidatesAfter,
  scanToolPayloadCandidates,
  selectToolPayloadCandidates,
  type ToolPayloadCleanupCursor,
} from './tool-payload-cleanup-candidates';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_cleanup');

const META_TOOL_CLEANUP_CURSOR_SESSION_ID = 'storageSafetyToolCleanupCursorSessionId';
const META_TOOL_CLEANUP_CURSOR_CREATED_AT = 'storageSafetyToolCleanupCursorCreatedAt';
const META_TOOL_CLEANUP_CURSOR_SEQUENCE = 'storageSafetyToolCleanupCursorSequence';
const META_TOOL_CLEANUP_CURSOR_MESSAGE_ID = 'storageSafetyToolCleanupCursorMessageId';
const META_TOOL_CLEANUP_RECHECK_AT = 'storageSafetyToolCleanupRecheckAt';
const TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID = '__session_exhausted__';

export interface ProjectDataToolPayloadCleanupResult {
  projectId: string;
  beforeBytes: number;
  afterBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  batchBytes: number;
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
  rowsFailed: number;
  toolMetadataBytesScanned: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  cursor:
    | {
        sessionId: string;
        createdAt: number;
        sequence: number;
        messageId: string;
      }
    | null;
  exhaustedCandidates: boolean;
  recheckAt: number | null;
}

export interface ProjectDataToolPayloadCleanupOptions {
  allowStart?: boolean;
  now?: number;
  classifyStatus: (databaseSizeBytes: number) => ProjectDataStorageStatus;
  recordTelemetry: (
    telemetry: ProjectDataStorageTelemetry,
    fields: {
      lastPurgeAt?: number | null;
      lastPurgeReason?: string | null;
      lastPurgeRows?: number | null;
      lastPurgeDatabaseSizeBytes?: number | null;
      lastError?: string | null;
    }
  ) => Promise<void>;
}

export function readProjectDataToolPayloadCleanupRecheckAt(sql: SqlStorage): number | null {
  return readMetaNumber(sql, META_TOOL_CLEANUP_RECHECK_AT);
}

function readToolPayloadCleanupCursor(sql: SqlStorage): ToolPayloadCleanupCursor | null {
  const sessionId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  const createdAt = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  const sequence = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  const messageId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  if (!sessionId || createdAt === null || sequence === null || !messageId) return null;
  return { sessionId, createdAt, sequence, messageId };
}

function writeToolPayloadCleanupCursor(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor,
  recheckAt: number
): void {
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID, cursor.sessionId);
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT, String(cursor.createdAt));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE, String(cursor.sequence));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID, cursor.messageId);
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
}

function writeToolPayloadCleanupRecheckAt(sql: SqlStorage, recheckAt: number): void {
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
}

function clearToolPayloadCleanupState(sql: SqlStorage): void {
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_RECHECK_AT);
}

function isSessionExhaustedCursor(cursor: ToolPayloadCleanupCursor): boolean {
  return (
    cursor.createdAt === Number.MAX_SAFE_INTEGER &&
    cursor.sequence === Number.MAX_SAFE_INTEGER &&
    cursor.messageId === TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID
  );
}

function buildSessionExhaustedCursor(sessionId: string): ToolPayloadCleanupCursor {
  return {
    sessionId,
    createdAt: Number.MAX_SAFE_INTEGER,
    sequence: Number.MAX_SAFE_INTEGER,
    messageId: TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID,
  };
}

function publicToolPayloadCleanupCursor(
  cursor: ToolPayloadCleanupCursor | null
): ProjectDataToolPayloadCleanupResult['cursor'] {
  if (!cursor) return null;
  return {
    sessionId: cursor.sessionId,
    createdAt: cursor.createdAt,
    sequence: cursor.sequence,
    messageId: cursor.messageId,
  };
}

function selectNextTerminalSessionId(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  afterSessionId: string
): string | null {
  const cursor = sql
    .exec(
      `SELECT id
       FROM chat_sessions
       WHERE status IN ('stopped', 'failed')
         AND updated_at <= ?
         AND id > ?
       ORDER BY id ASC
       LIMIT 1`,
      cutoffUpdatedAt,
      afterSessionId
    )
    .raw();

  let sessionId: string | null = null;
  for (const row of cursor) {
    const id = row[0];
    if (typeof id === 'string') sessionId = id;
  }
  return sessionId;
}

type ToolPayloadCleanupPlan = {
  projectId: string;
  now: number;
  beforeBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  batchBytes: number;
  cutoffUpdatedAt: number;
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
  lastScannedSessionId: string | null;
  pauseCursor: ToolPayloadCleanupCursor | null;
  hasMoreCandidates: boolean;
  finalSessionId: string | null;
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
  const pendingRecheckAt = readMetaNumber(sql, META_TOOL_CLEANUP_RECHECK_AT);
  const hasPendingCleanup = pendingCursor !== null || pendingRecheckAt !== null;

  if (beforeBytes <= targetBytes) {
    clearToolPayloadCleanupState(sql);
    return null;
  }
  if (pendingRecheckAt !== null && pendingRecheckAt > now) {
    return null;
  }
  if (!hasPendingCleanup && !options.allowStart) {
    return null;
  }
  if (beforeBytes < triggerBytes && !hasPendingCleanup) {
    return null;
  }

  return {
    projectId,
    now,
    beforeBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    batchRows: config.toolPayloadCleanupBatchRows,
    batchBytes: config.toolPayloadCleanupBatchBytes,
    cutoffUpdatedAt: now - config.toolPayloadCleanupMinSessionAgeMs,
    pendingCursor,
  };
}

function selectInitialCleanupSessionId(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  cursor: ToolPayloadCleanupCursor | null
): string | null {
  if (!cursor) return selectNextTerminalSessionId(sql, cutoffUpdatedAt, '');
  if (isSessionExhaustedCursor(cursor)) {
    return selectNextTerminalSessionId(sql, cutoffUpdatedAt, cursor.sessionId);
  }
  return cursor.sessionId;
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
    lastScannedSessionId: null,
    pauseCursor: null,
    hasMoreCandidates: false,
    finalSessionId: null,
  };
}

function scanToolPayloadCleanupBatch(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  plan: ToolPayloadCleanupPlan
): ToolPayloadCleanupBatch {
  const batch = createEmptyToolPayloadCleanupBatch();
  let cursor = plan.pendingCursor;
  let sessionId = selectInitialCleanupSessionId(sql, plan.cutoffUpdatedAt, cursor);

  while (
    sessionId &&
    batch.rowsScanned < plan.batchRows &&
    batch.sessionsScanned < config.toolPayloadCleanupMaxSessionsPerAlarm &&
    (batch.rowsScanned === 0 || batch.toolMetadataBytesScanned < plan.batchBytes)
  ) {
    const remainingRows = plan.batchRows - batch.rowsScanned;
    const remainingBytes = Math.max(plan.batchBytes - batch.toolMetadataBytesScanned, 0);
    const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
    const allowOversizedFirst = batch.rowsScanned === 0;
    const candidates = selectToolPayloadCandidates(
      sql,
      sessionId,
      messageCursor,
      remainingRows,
      remainingBytes,
      allowOversizedFirst
    );

    if (candidates.length === 0) {
      const previousScannedSessionId = batch.lastScannedSessionId;
      batch.lastScannedSessionId = sessionId;
      batch.sessionsScanned++;
      if (hasToolPayloadCandidatesAfter(sql, sessionId, messageCursor)) {
        batch.hasMoreCandidates = true;
        if (messageCursor) {
          batch.pauseCursor = messageCursor;
        } else if (previousScannedSessionId) {
          batch.pauseCursor = buildSessionExhaustedCursor(previousScannedSessionId);
        } else {
          batch.pauseCursor = null;
        }
        batch.finalSessionId = sessionId;
        break;
      }

      sessionId = selectNextTerminalSessionId(sql, plan.cutoffUpdatedAt, sessionId);
      cursor = null;
      continue;
    }

    const scanned = scanToolPayloadCandidates(sql, env, plan.batchBytes, candidates);

    batch.lastScannedSessionId = sessionId;
    batch.sessionsScanned++;
    batch.rowsScanned += scanned.rowsScanned;
    batch.rowsUpdated += scanned.rowsUpdated;
    batch.rowsFailed += scanned.rowsFailed;
    batch.toolMetadataBytesScanned += scanned.toolMetadataBytesScanned;
    batch.toolMetadataBytesRead += scanned.toolMetadataBytesRead;
    batch.originalToolMetadataBytes += scanned.originalToolMetadataBytes;
    batch.storedToolMetadataBytes += scanned.storedToolMetadataBytes;
    batch.errorMessages.push(...scanned.errorMessages);
    batch.lastCursor = scanned.lastCursor ?? batch.lastCursor;

    const lastCandidate = candidates[candidates.length - 1] ?? null;
    const moreInSession =
      lastCandidate !== null && hasToolPayloadCandidatesAfter(sql, sessionId, lastCandidate);
    if (moreInSession) {
      batch.hasMoreCandidates = true;
      batch.pauseCursor = lastCandidate;
      break;
    }

    if (batch.toolMetadataBytesScanned >= plan.batchBytes) {
      const nextSessionId = selectNextTerminalSessionId(sql, plan.cutoffUpdatedAt, sessionId);
      if (nextSessionId) {
        batch.hasMoreCandidates = true;
        batch.pauseCursor = buildSessionExhaustedCursor(sessionId);
        batch.finalSessionId = nextSessionId;
        break;
      }
    }

    sessionId = selectNextTerminalSessionId(sql, plan.cutoffUpdatedAt, sessionId);
    cursor = null;
  }

  batch.finalSessionId = sessionId;
  return batch;
}

function resolveContinuationCursor(
  batch: ToolPayloadCleanupBatch,
  config: StorageSafetyConfig,
  afterBytes: number,
  targetBytes: number
): ToolPayloadCleanupCursor | null {
  if (batch.hasMoreCandidates) return batch.pauseCursor ?? batch.lastCursor;
  const pausedForSessionScanBudget =
    afterBytes > targetBytes &&
    batch.finalSessionId !== null &&
    batch.sessionsScanned >= config.toolPayloadCleanupMaxSessionsPerAlarm &&
    batch.lastScannedSessionId !== null;
  if (!pausedForSessionScanBudget || !batch.lastScannedSessionId) return null;
  return buildSessionExhaustedCursor(batch.lastScannedSessionId);
}

function persistToolPayloadCleanupState(
  sql: SqlStorage,
  continuationCursor: ToolPayloadCleanupCursor | null,
  recheckAt: number | null
): void {
  if (continuationCursor && recheckAt !== null) {
    writeToolPayloadCleanupCursor(sql, continuationCursor, recheckAt);
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
    `auto tool payload cleanup failed closed ${batch.rowsFailed} candidate(s)${details}`,
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
  };

  try {
    await options.recordTelemetry(telemetry, {
      lastPurgeAt: rowsUpdated > 0 ? measuredAt : null,
      lastPurgeReason: rowsUpdated > 0 ? 'auto_tool_payload_cleanup' : null,
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
    batch = scanToolPayloadCleanupBatch(sql, env, config, plan);
  } catch (error) {
    return handleToolPayloadCleanupFailure(sql, config, options, plan, error);
  }
  const afterBytes = sql.databaseSize;
  const continuationCursor = resolveContinuationCursor(
    batch,
    config,
    afterBytes,
    plan.targetBytes
  );
  const shouldContinue = afterBytes > plan.targetBytes && continuationCursor !== null;
  const recheckAt = shouldContinue ? plan.now + config.toolPayloadCleanupRecheckMs : null;
  persistToolPayloadCleanupState(sql, continuationCursor, recheckAt);

  const exhaustedCandidates =
    afterBytes > plan.targetBytes && !shouldContinue && batch.finalSessionId === null;
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
    log.warn('completed', { ...result });
  }

  return shouldReturnToolPayloadCleanupResult(batch, exhaustedCandidates, shouldContinue)
    ? result
    : null;
}
