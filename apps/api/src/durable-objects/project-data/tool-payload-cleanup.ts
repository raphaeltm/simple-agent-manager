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
import { stripToolMetadataPayloadForStorage } from './tool-metadata-storage';
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
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
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
      lastPurgeAt: number;
      lastPurgeReason: string;
      lastPurgeRows: number;
      lastPurgeDatabaseSizeBytes: number;
      lastError: null;
    }
  ) => Promise<void>;
}

type ToolPayloadCleanupCursor = {
  sessionId: string;
  createdAt: number;
  sequence: number;
  messageId: string;
};

type ToolPayloadCandidate = ToolPayloadCleanupCursor & {
  toolMetadata: string;
};

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
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

function selectToolPayloadCandidates(
  sql: SqlStorage,
  sessionId: string,
  cursor: ToolPayloadCleanupCursor | null,
  limit: number
): ToolPayloadCandidate[] {
  const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
  const cursorCreatedAt = messageCursor?.createdAt ?? null;
  const cursorSequence = messageCursor?.sequence ?? null;
  const cursorMessageId = messageCursor?.messageId ?? null;
  const rows = sql
    .exec(
      `SELECT id, created_at, COALESCE(sequence, 0) AS sequence, tool_metadata
       FROM chat_messages
       WHERE session_id = ?
         AND role = 'tool'
         AND tool_metadata IS NOT NULL
         AND tool_metadata LIKE '%"content"%'
         AND (
           ? IS NULL
           OR created_at > ?
           OR (created_at = ? AND COALESCE(sequence, 0) > ?)
           OR (created_at = ? AND COALESCE(sequence, 0) = ? AND id > ?)
         )
       ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC
       LIMIT ?`,
      sessionId,
      cursorCreatedAt,
      cursorCreatedAt ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorMessageId ?? '',
      limit
    )
    .raw();
  return parseToolPayloadCandidateRows(sessionId, rows);
}

function parseToolPayloadCandidateRows(
  sessionId: string,
  rows: IterableIterator<unknown[]>
): ToolPayloadCandidate[] {
  const candidates: ToolPayloadCandidate[] = [];
  for (const row of rows) {
    const id = row[0];
    const createdAt = rawNumber(row[1]);
    const sequence = rawNumber(row[2]);
    const toolMetadata = row[3];
    if (
      typeof id === 'string' &&
      createdAt !== null &&
      sequence !== null &&
      typeof toolMetadata === 'string'
    ) {
      candidates.push({ sessionId, createdAt, sequence, messageId: id, toolMetadata });
    }
  }
  return candidates;
}

function updateToolMetadata(sql: SqlStorage, messageId: string, toolMetadata: string | null): void {
  sql.exec('UPDATE chat_messages SET tool_metadata = ? WHERE id = ?', toolMetadata, messageId);
}

type ToolPayloadCleanupPlan = {
  projectId: string;
  now: number;
  beforeBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  cutoffUpdatedAt: number;
  pendingCursor: ToolPayloadCleanupCursor | null;
};

type ToolPayloadCleanupBatch = {
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  lastCursor: ToolPayloadCleanupCursor | null;
  lastScannedSessionId: string | null;
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
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    lastCursor: null,
    lastScannedSessionId: null,
    hasMoreCandidates: false,
    finalSessionId: null,
  };
}

function scanToolPayloadCandidates(
  sql: SqlStorage,
  env: Env,
  candidates: ToolPayloadCandidate[]
): Pick<
  ToolPayloadCleanupBatch,
  | 'rowsScanned'
  | 'rowsUpdated'
  | 'originalToolMetadataBytes'
  | 'storedToolMetadataBytes'
  | 'lastCursor'
> {
  let rowsUpdated = 0;
  let originalToolMetadataBytes = 0;
  let storedToolMetadataBytes = 0;
  let lastCursor: ToolPayloadCleanupCursor | null = null;

  for (const candidate of candidates) {
    lastCursor = candidate;
    const stripped = stripToolMetadataPayloadForStorage(candidate.toolMetadata, env);
    if (!stripped.stripped) continue;

    updateToolMetadata(sql, candidate.messageId, stripped.value);
    rowsUpdated++;
    originalToolMetadataBytes += stripped.originalBytes;
    storedToolMetadataBytes += stripped.storedBytes;
  }

  return {
    rowsScanned: candidates.length,
    rowsUpdated,
    originalToolMetadataBytes,
    storedToolMetadataBytes,
    lastCursor,
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
    batch.sessionsScanned < config.toolPayloadCleanupMaxSessionsPerAlarm
  ) {
    const remainingRows = plan.batchRows - batch.rowsScanned;
    const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
    const candidates = selectToolPayloadCandidates(sql, sessionId, messageCursor, remainingRows);
    const scanned = scanToolPayloadCandidates(sql, env, candidates);

    batch.lastScannedSessionId = sessionId;
    batch.sessionsScanned++;
    batch.rowsScanned += scanned.rowsScanned;
    batch.rowsUpdated += scanned.rowsUpdated;
    batch.originalToolMetadataBytes += scanned.originalToolMetadataBytes;
    batch.storedToolMetadataBytes += scanned.storedToolMetadataBytes;
    batch.lastCursor = scanned.lastCursor ?? batch.lastCursor;

    if (candidates.length >= remainingRows) {
      batch.hasMoreCandidates = true;
      break;
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
  if (batch.hasMoreCandidates) return batch.lastCursor;
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
    sessionsScanned: batch.sessionsScanned,
    rowsScanned: batch.rowsScanned,
    rowsUpdated: batch.rowsUpdated,
    originalToolMetadataBytes: batch.originalToolMetadataBytes,
    storedToolMetadataBytes: batch.storedToolMetadataBytes,
    cursor: shouldContinue ? publicToolPayloadCleanupCursor(continuationCursor) : null,
    exhaustedCandidates,
    recheckAt,
  };
}

async function recordToolPayloadCleanupTelemetry(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions,
  projectId: string,
  afterBytes: number,
  rowsUpdated: number
): Promise<void> {
  if (rowsUpdated <= 0) return;

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
      lastPurgeAt: measuredAt,
      lastPurgeReason: 'auto_tool_payload_cleanup',
      lastPurgeRows: rowsUpdated,
      lastPurgeDatabaseSizeBytes: afterBytes,
      lastError: null,
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
  return batch.rowsScanned > 0 || batch.rowsUpdated > 0 || exhaustedCandidates || shouldContinue;
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

  const batch = scanToolPayloadCleanupBatch(sql, env, config, plan);
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
  await recordToolPayloadCleanupTelemetry(
    sql,
    config,
    options,
    plan.projectId,
    afterBytes,
    batch.rowsUpdated
  );

  if (batch.rowsUpdated > 0 || exhaustedCandidates) {
    log.warn('completed', { ...result });
  }

  return shouldReturnToolPayloadCleanupResult(batch, exhaustedCandidates, shouldContinue)
    ? result
    : null;
}
