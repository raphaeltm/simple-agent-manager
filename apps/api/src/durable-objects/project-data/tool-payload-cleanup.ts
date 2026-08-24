import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import type {
  ProjectDataStorageStatus,
  ProjectDataStorageTelemetry,
  StorageSafetyConfig,
} from './storage-safety';
import { stripToolMetadataPayloadForStorage } from './tool-metadata-storage';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_cleanup');

const META_LAST_MEASURED_AT = 'storageSafetyLastMeasuredAt';
const META_LAST_STATUS = 'storageSafetyLastStatus';
const META_LAST_ERROR = 'storageSafetyLastError';
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

function readMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec('SELECT value FROM do_meta WHERE key = ?', key).toArray()[0];
  if (!isJsonRecord(row)) return null;
  const value = (row as Record<string, unknown>).value;
  return typeof value === 'string' ? value : null;
}

function readMetaNumber(sql: SqlStorage, key: string): number | null {
  const raw = readMeta(sql, key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function writeMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    `INSERT INTO do_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

function deleteMeta(sql: SqlStorage, key: string): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', key);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

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
  if (cursor && cursor.sessionId === sessionId) {
    const rows = sql
      .exec(
        `SELECT id, created_at, COALESCE(sequence, 0) AS sequence, tool_metadata
         FROM chat_messages
         WHERE session_id = ?
           AND role = 'tool'
           AND tool_metadata IS NOT NULL
           AND tool_metadata LIKE '%"content"%'
           AND (
             created_at > ?
             OR (created_at = ? AND COALESCE(sequence, 0) > ?)
             OR (created_at = ? AND COALESCE(sequence, 0) = ? AND id > ?)
           )
         ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC
         LIMIT ?`,
        sessionId,
        cursor.createdAt,
        cursor.createdAt,
        cursor.sequence,
        cursor.createdAt,
        cursor.sequence,
        cursor.messageId,
        limit
      )
      .raw();
    return parseToolPayloadCandidateRows(sessionId, rows);
  }

  const rows = sql
    .exec(
      `SELECT id, created_at, COALESCE(sequence, 0) AS sequence, tool_metadata
       FROM chat_messages
       WHERE session_id = ?
         AND role = 'tool'
         AND tool_metadata IS NOT NULL
         AND tool_metadata LIKE '%"content"%'
       ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC
       LIMIT ?`,
      sessionId,
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

export async function runProjectDataToolPayloadCleanup(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: ProjectDataToolPayloadCleanupOptions
): Promise<ProjectDataToolPayloadCleanupResult | null> {
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

  const cutoffUpdatedAt = now - config.toolPayloadCleanupMinSessionAgeMs;
  const batchRows = config.toolPayloadCleanupBatchRows;
  let cursor = pendingCursor;
  let sessionId = cursor
    ? isSessionExhaustedCursor(cursor)
      ? selectNextTerminalSessionId(sql, cutoffUpdatedAt, cursor.sessionId)
      : cursor.sessionId
    : selectNextTerminalSessionId(sql, cutoffUpdatedAt, '');
  let sessionsScanned = 0;
  let rowsScanned = 0;
  let rowsUpdated = 0;
  let originalToolMetadataBytes = 0;
  let storedToolMetadataBytes = 0;
  let lastCursor: ToolPayloadCleanupCursor | null = null;
  let lastScannedSessionId: string | null = null;
  let hasMoreCandidates = false;

  while (
    sessionId &&
    rowsScanned < batchRows &&
    sessionsScanned < config.toolPayloadCleanupMaxSessionsPerAlarm
  ) {
    const remainingRows = batchRows - rowsScanned;
    const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
    const candidates = selectToolPayloadCandidates(sql, sessionId, messageCursor, remainingRows);
    lastScannedSessionId = sessionId;
    sessionsScanned++;

    for (const candidate of candidates) {
      rowsScanned++;
      lastCursor = candidate;
      const stripped = stripToolMetadataPayloadForStorage(candidate.toolMetadata, env);
      if (!stripped.stripped) continue;

      updateToolMetadata(sql, candidate.messageId, stripped.value);
      rowsUpdated++;
      originalToolMetadataBytes += stripped.originalBytes;
      storedToolMetadataBytes += stripped.storedBytes;
    }

    if (candidates.length >= remainingRows) {
      hasMoreCandidates = true;
      break;
    }

    sessionId = selectNextTerminalSessionId(sql, cutoffUpdatedAt, sessionId);
    cursor = sessionId ? null : cursor;
  }

  const afterBytes = sql.databaseSize;
  const pausedForSessionScanBudget =
    afterBytes > targetBytes &&
    !hasMoreCandidates &&
    sessionId !== null &&
    sessionsScanned >= config.toolPayloadCleanupMaxSessionsPerAlarm &&
    lastScannedSessionId !== null;
  const continuationCursor = hasMoreCandidates
    ? lastCursor
    : pausedForSessionScanBudget && lastScannedSessionId
      ? buildSessionExhaustedCursor(lastScannedSessionId)
      : null;
  const shouldContinue = afterBytes > targetBytes && continuationCursor !== null;
  const recheckAt = shouldContinue ? now + config.toolPayloadCleanupRecheckMs : null;
  if (continuationCursor && recheckAt !== null) {
    writeToolPayloadCleanupCursor(sql, continuationCursor, recheckAt);
  } else {
    clearToolPayloadCleanupState(sql);
  }

  const exhaustedCandidates = afterBytes > targetBytes && !shouldContinue && sessionId === null;

  const result: ProjectDataToolPayloadCleanupResult = {
    projectId,
    beforeBytes,
    afterBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    batchRows,
    sessionsScanned,
    rowsScanned,
    rowsUpdated,
    originalToolMetadataBytes,
    storedToolMetadataBytes,
    cursor: shouldContinue ? publicToolPayloadCleanupCursor(continuationCursor) : null,
    exhaustedCandidates,
    recheckAt,
  };

  if (rowsUpdated > 0) {
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

  if (rowsUpdated > 0 || exhaustedCandidates) {
    log.warn('completed', { ...result });
  }

  return rowsScanned > 0 || rowsUpdated > 0 || exhaustedCandidates || shouldContinue
    ? result
    : null;
}
