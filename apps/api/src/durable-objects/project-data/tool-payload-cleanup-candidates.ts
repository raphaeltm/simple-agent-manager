import { archiveToolPayloadCandidate } from './tool-payload-archive';
import {
  clearToolPayloadCleanupAttempt,
  recordToolPayloadCleanupAttempt,
  type ToolPayloadCleanupAttemptStatus,
} from './tool-payload-cleanup-attempts';
import type { Env } from './types';

const TOOL_PAYLOAD_CONTENT_KEY_NEEDLE = '"content"';

export type ToolPayloadCleanupCursor = {
  sessionId: string;
  createdAt: number;
  sequence: number;
  messageId: string;
};

export type ToolPayloadCandidate = ToolPayloadCleanupCursor & {
  toolMetadataBytes: number;
};

export type ToolPayloadCandidateSelection = {
  candidates: ToolPayloadCandidate[];
  hasMore: boolean;
};

type ToolPayloadCandidateSelectionRow = {
  id: string;
  sessionId: string;
  createdAt: number;
  sequence: number;
  toolMetadataBytes: number;
  rowNumber: number;
  cumulativeToolMetadataBytes: number;
  totalLimitedRows: number;
};

export type ToolPayloadCandidateScanResult = {
  rowsScanned: number;
  rowsUpdated: number;
  rowsFailed: number;
  toolMetadataBytesScanned: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  lastCursor: ToolPayloadCleanupCursor | null;
  retryCursor: ToolPayloadCleanupCursor | null;
  pausedForWallTime: boolean;
  retryableFailure: boolean;
  errorMessages: string[];
};

type ToolPayloadCandidateUpdate = {
  rowsUpdated: number;
  rowsFailed: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  retryableFailure: boolean;
  errorMessage: string | null;
  cleanupAttemptStatus: ToolPayloadCleanupAttemptStatus | 'archived' | null;
};

type ToolPayloadCandidateProcessingContext = {
  sql: SqlStorage;
  env: Env;
  projectId: string;
  archivePrefix: string;
  archiveRetryDelayMs: number;
  archiveWriteTimeoutMs: number;
  archiveChunkBytes: number;
  archiveMaxMetadataBytes: number;
  transactionSync?: <T>(callback: () => T) => T;
  maxRowBytes: number;
  archivedAt: number;
};

type ToolPayloadCandidateScanInput = ToolPayloadCandidateProcessingContext & {
  batchBytes: number;
  candidates: ToolPayloadCandidate[];
  initialCursor: ToolPayloadCleanupCursor | null;
  deadlineMs: number;
  nowMs?: () => number;
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

function messageCursorFilter(
  cursor: ToolPayloadCleanupCursor | null,
  columnPrefix = ''
): { clause: string; params: Array<number | string> } {
  if (!cursor) return { clause: '', params: [] };
  const prefix = columnPrefix ? `${columnPrefix}.` : '';
  return {
    clause: `AND (${prefix}session_id, ${prefix}created_at, ${prefix}sequence, ${prefix}id) > (?, ?, ?, ?)`,
    params: [cursor.sessionId, cursor.createdAt, cursor.sequence, cursor.messageId],
  };
}

export function selectToolPayloadCandidates(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor | null,
  cutoffCreatedAt: number,
  retryReadyAt: number,
  limit: number,
  maxMetadataBytes: number,
  allowOversizedFirst: boolean
): ToolPayloadCandidateSelection {
  const cursorFilter = messageCursorFilter(cursor);
  const whereClause = cursorFilter.clause;
  const limitedRowLimit = limit + 1;
  const rows = sql
    .exec(
      `WITH limited AS (
         SELECT
           id,
           session_id,
           created_at,
           sequence,
           length(CAST(tool_metadata AS BLOB)) AS tool_metadata_bytes
         FROM chat_messages
         WHERE role = 'tool'
           AND tool_metadata IS NOT NULL
           AND instr(tool_metadata, ?) > 0
           AND created_at < ?
           AND sequence IS NOT NULL
           ${whereClause}
           AND NOT EXISTS (
             SELECT 1
             FROM tool_payload_archives archived
             WHERE archived.message_id = chat_messages.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM tool_payload_cleanup_attempts attempt
             WHERE attempt.message_id = chat_messages.id
               AND (
                 attempt.status IN ('no_reclaimable_payload', 'invalid_metadata', 'oversized')
                 OR (
                   attempt.status = 'retryable_failure'
                   AND attempt.next_attempt_at IS NOT NULL
                   AND attempt.next_attempt_at > ?
                 )
               )
           )
         ORDER BY session_id ASC, created_at ASC, sequence ASC, id ASC
         LIMIT ?
       ),
       bounded AS (
         SELECT
           id,
           session_id,
           created_at,
           sequence,
           tool_metadata_bytes,
           ROW_NUMBER() OVER (
             ORDER BY session_id ASC, created_at ASC, sequence ASC, id ASC
           ) AS row_number,
           SUM(tool_metadata_bytes) OVER (
             ORDER BY session_id ASC, created_at ASC, sequence ASC, id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_tool_metadata_bytes,
           COUNT(*) OVER () AS total_limited_rows
         FROM limited
       )
       SELECT
         id,
         session_id,
         created_at,
         sequence,
         tool_metadata_bytes,
         row_number,
         cumulative_tool_metadata_bytes,
         total_limited_rows
       FROM bounded
       ORDER BY session_id ASC, created_at ASC, sequence ASC, id ASC`,
      TOOL_PAYLOAD_CONTENT_KEY_NEEDLE,
      cutoffCreatedAt,
      ...cursorFilter.params,
      retryReadyAt,
      limitedRowLimit
    )
    .raw();
  const selection = parseToolPayloadCandidateRows(
    rows,
    limit,
    maxMetadataBytes,
    allowOversizedFirst
  );
  return {
    candidates: selection.candidates,
    hasMore: selection.totalLimitedRows > selection.candidates.length,
  };
}

export type RearchivableOversizedCleanupResult = {
  rowsChanged: number;
  hasMore: boolean;
};

export function clearRearchivableOversizedToolPayloadCleanupAttempts(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor | null,
  cutoffCreatedAt: number,
  archiveMaxMetadataBytes: number,
  limit: number
): RearchivableOversizedCleanupResult {
  if (!Number.isSafeInteger(limit) || limit <= 0) return { rowsChanged: 0, hasMore: false };
  const cursorFilter = messageCursorFilter(cursor, 'm');
  const whereClause = cursorFilter.clause;
  sql.exec(
    `DELETE FROM tool_payload_cleanup_attempts
     WHERE message_id IN (
       SELECT attempt.message_id
       FROM tool_payload_cleanup_attempts attempt
       JOIN chat_messages m ON m.id = attempt.message_id
       WHERE attempt.status = 'oversized'
         AND m.role = 'tool'
         AND m.tool_metadata IS NOT NULL
         AND instr(m.tool_metadata, ?) > 0
         AND m.created_at < ?
         AND m.sequence IS NOT NULL
         AND length(CAST(m.tool_metadata AS BLOB)) <= ?
         ${whereClause}
         AND NOT EXISTS (
           SELECT 1
           FROM tool_payload_archives archived
           WHERE archived.message_id = m.id
         )
       ORDER BY m.session_id ASC, m.created_at ASC, m.sequence ASC, m.id ASC
       LIMIT ?
     )`,
    TOOL_PAYLOAD_CONTENT_KEY_NEEDLE,
    cutoffCreatedAt,
    archiveMaxMetadataBytes,
    ...cursorFilter.params,
    limit
  );
  const row = sql.exec('SELECT changes()').raw().next().value;
  const rowsChanged = row ? (rawNumber(row[0]) ?? 0) : 0;
  return { rowsChanged, hasMore: rowsChanged >= limit };
}

function parseToolPayloadCandidateRows(
  rows: IterableIterator<unknown[]>,
  limit: number,
  maxMetadataBytes: number,
  allowOversizedFirst: boolean
): { candidates: ToolPayloadCandidate[]; totalLimitedRows: number } {
  const candidates: ToolPayloadCandidate[] = [];
  let totalLimitedRows = 0;
  for (const row of rows) {
    const parsed = parseToolPayloadCandidateSelectionRow(row);
    if (!parsed) continue;
    totalLimitedRows = Math.max(totalLimitedRows, parsed.totalLimitedRows);
    const withinRowLimit = parsed.rowNumber <= limit;
    const withinByteLimit = parsed.cumulativeToolMetadataBytes <= maxMetadataBytes;
    const oversizedFirstAllowed = allowOversizedFirst && parsed.rowNumber === 1;
    if (withinRowLimit && (withinByteLimit || oversizedFirstAllowed)) {
      candidates.push({
        sessionId: parsed.sessionId,
        createdAt: parsed.createdAt,
        sequence: parsed.sequence,
        messageId: parsed.id,
        toolMetadataBytes: parsed.toolMetadataBytes,
      });
    }
  }
  return { candidates, totalLimitedRows };
}

function parseToolPayloadCandidateSelectionRow(
  row: unknown[]
): ToolPayloadCandidateSelectionRow | null {
  const id = row[0];
  const sessionId = row[1];
  const createdAt = rawNumber(row[2]);
  const sequence = rawNumber(row[3]);
  const toolMetadataBytes = rawNumber(row[4]);
  const rowNumber = rawNumber(row[5]);
  const cumulativeToolMetadataBytes = rawNumber(row[6]);
  const totalLimitedRows = rawNumber(row[7]);
  if (
    typeof id !== 'string' ||
    typeof sessionId !== 'string' ||
    createdAt === null ||
    sequence === null ||
    toolMetadataBytes === null ||
    toolMetadataBytes <= 0 ||
    rowNumber === null ||
    rowNumber <= 0 ||
    cumulativeToolMetadataBytes === null ||
    cumulativeToolMetadataBytes <= 0 ||
    totalLimitedRows === null ||
    totalLimitedRows <= 0
  ) {
    return null;
  }
  return {
    id,
    sessionId,
    createdAt,
    sequence,
    toolMetadataBytes,
    rowNumber,
    cumulativeToolMetadataBytes,
    totalLimitedRows,
  };
}

function readBoundedToolMetadata(
  sql: SqlStorage,
  messageId: string,
  maxMetadataBytes: number
): string | null {
  const rows = sql
    .exec(
      `SELECT tool_metadata
       FROM chat_messages
       WHERE id = ?
         AND tool_metadata IS NOT NULL
         AND length(CAST(tool_metadata AS BLOB)) <= ?
       LIMIT 1`,
      messageId,
      maxMetadataBytes
    )
    .raw();
  for (const row of rows) {
    if (typeof row[0] === 'string') return row[0];
  }
  return null;
}

function emptyCandidateUpdate(): ToolPayloadCandidateUpdate {
  return {
    rowsUpdated: 0,
    rowsFailed: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    retryableFailure: false,
    errorMessage: null,
    cleanupAttemptStatus: 'no_reclaimable_payload',
  };
}

function failedBudgetUpdate(
  candidate: ToolPayloadCandidate,
  reason: 'row' | 'batch' | 'archive'
): ToolPayloadCandidateUpdate {
  const description =
    reason === 'archive'
      ? 'archive metadata byte budget'
      : reason === 'batch'
        ? 'cleanup batch byte budget'
        : 'cleanup per-row byte budget';
  return {
    rowsUpdated: 0,
    rowsFailed: 1,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: candidate.toolMetadataBytes,
    storedToolMetadataBytes: 0,
    retryableFailure: false,
    errorMessage: `tool_metadata row ${candidate.messageId} exceeded the ${description}`,
    cleanupAttemptStatus: 'oversized',
  };
}

function recordToolPayloadCleanupDisposition(
  context: ToolPayloadCandidateProcessingContext,
  candidate: ToolPayloadCandidate,
  update: ToolPayloadCandidateUpdate
): void {
  if (update.cleanupAttemptStatus === null) return;
  if (update.cleanupAttemptStatus === 'archived') {
    clearToolPayloadCleanupAttempt(context.sql, candidate.messageId);
    return;
  }
  const nextAttemptAt =
    update.cleanupAttemptStatus === 'retryable_failure'
      ? context.archivedAt + context.archiveRetryDelayMs
      : null;
  recordToolPayloadCleanupAttempt(
    context.sql,
    candidate,
    update.cleanupAttemptStatus,
    context.archivedAt,
    update.errorMessage,
    nextAttemptAt
  );
}

async function processToolPayloadCandidate(
  context: ToolPayloadCandidateProcessingContext,
  candidate: ToolPayloadCandidate,
  maxReadBytes: number
): Promise<ToolPayloadCandidateUpdate> {
  if (candidate.toolMetadataBytes > context.archiveMaxMetadataBytes) {
    return failedBudgetUpdate(candidate, 'archive');
  }
  if (
    candidate.toolMetadataBytes > context.maxRowBytes &&
    candidate.toolMetadataBytes > context.archiveMaxMetadataBytes
  ) {
    return failedBudgetUpdate(candidate, 'row');
  }
  if (candidate.toolMetadataBytes > maxReadBytes) return failedBudgetUpdate(candidate, 'batch');

  const toolMetadata = readBoundedToolMetadata(
    context.sql,
    candidate.messageId,
    Math.min(maxReadBytes, context.archiveMaxMetadataBytes)
  );
  if (toolMetadata === null) return emptyCandidateUpdate();

  return archiveToolPayloadCandidate({
    sql: context.sql,
    env: context.env,
    projectId: context.projectId,
    archivePrefix: context.archivePrefix,
    archiveWriteTimeoutMs: context.archiveWriteTimeoutMs,
    archiveChunkBytes: context.archiveChunkBytes,
    ...(context.transactionSync ? { transactionSync: context.transactionSync } : {}),
    candidate,
    toolMetadata,
    archivedAt: context.archivedAt,
  });
}

function createEmptyCandidateScanResult(): ToolPayloadCandidateScanResult {
  return {
    rowsScanned: 0,
    rowsUpdated: 0,
    rowsFailed: 0,
    toolMetadataBytesScanned: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    lastCursor: null,
    retryCursor: null,
    pausedForWallTime: false,
    retryableFailure: false,
    errorMessages: [],
  };
}

export async function scanToolPayloadCandidates(
  input: ToolPayloadCandidateScanInput
): Promise<ToolPayloadCandidateScanResult> {
  const result = createEmptyCandidateScanResult();
  const nowMs = input.nowMs ?? Date.now;
  let previousCursor = input.initialCursor;
  const processingContext: ToolPayloadCandidateProcessingContext = {
    sql: input.sql,
    env: input.env,
    projectId: input.projectId,
    archivePrefix: input.archivePrefix,
    archiveRetryDelayMs: input.archiveRetryDelayMs,
    archiveWriteTimeoutMs: input.archiveWriteTimeoutMs,
    archiveChunkBytes: input.archiveChunkBytes,
    archiveMaxMetadataBytes: input.archiveMaxMetadataBytes,
    ...(input.transactionSync ? { transactionSync: input.transactionSync } : {}),
    maxRowBytes: input.maxRowBytes,
    archivedAt: input.archivedAt,
  };

  for (const candidate of input.candidates) {
    if (result.rowsScanned > 0 && nowMs() >= input.deadlineMs) {
      result.pausedForWallTime = true;
      result.retryCursor = previousCursor;
      break;
    }

    const remainingReadBytes = Math.max(input.batchBytes - result.toolMetadataBytesRead, 0);
    const maxReadBytes =
      result.rowsScanned === 0 && candidate.toolMetadataBytes > remainingReadBytes
        ? candidate.toolMetadataBytes
        : remainingReadBytes;

    const updated = await processToolPayloadCandidate(processingContext, candidate, maxReadBytes);
    recordToolPayloadCleanupDisposition(processingContext, candidate, updated);

    result.rowsScanned++;
    result.lastCursor = candidate;
    result.toolMetadataBytesScanned += candidate.toolMetadataBytes;
    result.rowsUpdated += updated.rowsUpdated;
    result.rowsFailed += updated.rowsFailed;
    result.toolMetadataBytesRead += updated.toolMetadataBytesRead;
    result.originalToolMetadataBytes += updated.originalToolMetadataBytes;
    result.storedToolMetadataBytes += updated.storedToolMetadataBytes;
    if (updated.errorMessage) result.errorMessages.push(updated.errorMessage);

    if (updated.retryableFailure) {
      result.retryableFailure = true;
      result.retryCursor = previousCursor;
      break;
    }

    previousCursor = candidate;

    if (nowMs() >= input.deadlineMs) {
      result.pausedForWallTime = true;
      result.retryCursor = candidate;
      break;
    }
  }

  return result;
}
