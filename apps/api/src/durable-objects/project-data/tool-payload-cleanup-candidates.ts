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

export function selectToolPayloadCandidates(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor | null,
  cutoffCreatedAt: number,
  retryReadyAt: number,
  limit: number,
  maxMetadataBytes: number,
  allowOversizedFirst: boolean
): ToolPayloadCandidate[] {
  const cursorSessionId = cursor?.sessionId ?? null;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorSequence = cursor?.sequence ?? null;
  const cursorMessageId = cursor?.messageId ?? null;
  const rows = sql
    .exec(
      `WITH limited AS (
         SELECT
           id,
           session_id,
           created_at,
           COALESCE(sequence, 0) AS sequence,
           length(CAST(tool_metadata AS BLOB)) AS tool_metadata_bytes
         FROM chat_messages
         WHERE role = 'tool'
           AND tool_metadata IS NOT NULL
           AND instr(tool_metadata, ?) > 0
           AND created_at < ?
           AND (
             ? IS NULL
             OR session_id > ?
             OR (
               session_id = ?
               AND (
                 created_at > ?
                 OR (created_at = ? AND COALESCE(sequence, 0) > ?)
                 OR (created_at = ? AND COALESCE(sequence, 0) = ? AND id > ?)
               )
             )
           )
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
           ) AS cumulative_tool_metadata_bytes
         FROM limited
       )
       SELECT id, session_id, created_at, sequence, tool_metadata_bytes
       FROM bounded
       WHERE cumulative_tool_metadata_bytes <= ?
          OR (? = 1 AND row_number = 1)
       ORDER BY session_id ASC, created_at ASC, sequence ASC, id ASC`,
      TOOL_PAYLOAD_CONTENT_KEY_NEEDLE,
      cutoffCreatedAt,
      cursorSessionId,
      cursorSessionId ?? '',
      cursorSessionId ?? '',
      cursorCreatedAt ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorMessageId ?? '',
      retryReadyAt,
      limit,
      maxMetadataBytes,
      allowOversizedFirst ? 1 : 0
    )
    .raw();
  return parseToolPayloadCandidateRows(rows);
}

export function hasToolPayloadCandidatesAfter(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor | null,
  cutoffCreatedAt: number,
  retryReadyAt: number
): boolean {
  const cursorSessionId = cursor?.sessionId ?? null;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorSequence = cursor?.sequence ?? null;
  const cursorMessageId = cursor?.messageId ?? null;
  const rows = sql
    .exec(
      `SELECT id
       FROM chat_messages
       WHERE role = 'tool'
         AND tool_metadata IS NOT NULL
         AND instr(tool_metadata, ?) > 0
         AND created_at < ?
         AND (
           ? IS NULL
           OR session_id > ?
           OR (
             session_id = ?
             AND (
               created_at > ?
               OR (created_at = ? AND COALESCE(sequence, 0) > ?)
               OR (created_at = ? AND COALESCE(sequence, 0) = ? AND id > ?)
             )
           )
         )
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
       LIMIT ?`,
      TOOL_PAYLOAD_CONTENT_KEY_NEEDLE,
      cutoffCreatedAt,
      cursorSessionId,
      cursorSessionId ?? '',
      cursorSessionId ?? '',
      cursorCreatedAt ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorMessageId ?? '',
      retryReadyAt,
      1
    )
    .raw();
  for (const row of rows) {
    if (typeof row[0] === 'string') return true;
  }
  return false;
}

function parseToolPayloadCandidateRows(rows: IterableIterator<unknown[]>): ToolPayloadCandidate[] {
  const candidates: ToolPayloadCandidate[] = [];
  for (const row of rows) {
    const id = row[0];
    const sessionId = row[1];
    const createdAt = rawNumber(row[2]);
    const sequence = rawNumber(row[3]);
    const toolMetadataBytes = rawNumber(row[4]);
    if (
      typeof id === 'string' &&
      typeof sessionId === 'string' &&
      createdAt !== null &&
      sequence !== null &&
      toolMetadataBytes !== null &&
      toolMetadataBytes > 0
    ) {
      candidates.push({ sessionId, createdAt, sequence, messageId: id, toolMetadataBytes });
    }
  }
  return candidates;
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

function failedBudgetUpdate(candidate: ToolPayloadCandidate): ToolPayloadCandidateUpdate {
  return {
    rowsUpdated: 0,
    rowsFailed: 1,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: candidate.toolMetadataBytes,
    storedToolMetadataBytes: 0,
    retryableFailure: false,
    errorMessage: `tool_metadata row ${candidate.messageId} exceeded the cleanup per-row byte budget`,
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
  const nextAttemptAt = update.cleanupAttemptStatus === 'retryable_failure'
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
  if (candidate.toolMetadataBytes > context.maxRowBytes) return failedBudgetUpdate(candidate);
  if (candidate.toolMetadataBytes > maxReadBytes) return failedBudgetUpdate(candidate);

  const toolMetadata = readBoundedToolMetadata(context.sql, candidate.messageId, maxReadBytes);
  if (toolMetadata === null) return emptyCandidateUpdate();

  return archiveToolPayloadCandidate({
    sql: context.sql,
    env: context.env,
    projectId: context.projectId,
    archivePrefix: context.archivePrefix,
    archiveWriteTimeoutMs: context.archiveWriteTimeoutMs,
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
