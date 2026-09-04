import {
  archiveToolPayloadCandidate,
  readArchivedMessageToolContent,
  selectArchivedToolPayloadRow,
} from './tool-payload-archive';
import type { ToolPayloadArchiveOperationBudget } from './tool-payload-archive-r2';
import {
  clearToolPayloadCleanupAttempt,
  recordToolPayloadCleanupAttempt,
  type ToolPayloadCleanupAttemptStatus,
} from './tool-payload-cleanup-attempts';
import type { Env } from './types';

const TOOL_PAYLOAD_CONTENT_KEY_NEEDLE = '"content"';

export type ToolPayloadCleanupCursor = {
  rowId: number;
  sessionId: string;
  createdAt: number;
  sequence: number;
  messageId: string;
};

export type ToolPayloadCandidate = ToolPayloadCleanupCursor & {
  toolMetadataBytes: number;
  approvedToolMetadataSha256?: string;
  projectedReclaimableBytes?: number;
};

export type ToolPayloadCandidateSelection = {
  candidates: ToolPayloadCandidate[];
  hasMore: boolean;
  nextCursor: ToolPayloadCleanupCursor | null;
};

export type ToolPayloadCandidateScanResult = {
  rowsScanned: number;
  rowsUpdated: number;
  approvedRowsCompleted: number;
  approvedBytesCompleted: number;
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
  archiveOperations: number;
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
  archiveOperationBudget: ToolPayloadArchiveOperationBudget;
  deadlineMs: number;
  nowMs: () => number;
  transactionSync?: <T>(callback: () => T) => T;
  maxRowBytes: number;
  archivedAt: number;
};

type ToolPayloadCandidateScanInput = Omit<
  ToolPayloadCandidateProcessingContext,
  'archiveOperationBudget' | 'deadlineMs' | 'nowMs'
> & {
  batchBytes: number;
  candidates: ToolPayloadCandidate[];
  initialCursor: ToolPayloadCleanupCursor | null;
  deadlineMs: number;
  archiveMaxOperations: number;
  nowMs?: () => number;
  operationBudget?: ToolPayloadArchiveOperationBudget;
  requireApprovedTargets?: boolean;
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
    clause: `AND ${prefix}rowid > ?`,
    params: [cursor.rowId],
  };
}

export function selectToolPayloadCandidates(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor | null,
  cutoffCreatedAt: number,
  retryReadyAt: number,
  limit: number,
  maxMetadataBytes: number,
  allowOversizedFirst: boolean,
  physicalLimit = limit
): ToolPayloadCandidateSelection {
  const rows = sql
    .exec(
      `WITH raw_window AS MATERIALIZED (
         SELECT
           rowid AS physical_rowid,
           id,
           session_id,
           created_at,
           sequence,
           role,
           length(CAST(tool_metadata AS BLOB)) AS tool_metadata_bytes,
           CASE WHEN tool_metadata IS NOT NULL AND instr(tool_metadata, ?) > 0 THEN 1 ELSE 0 END AS has_content
         FROM chat_messages
         WHERE rowid > ?
         ORDER BY rowid ASC
         LIMIT ?
       )
       SELECT
         raw.physical_rowid,
         raw.id,
         raw.session_id,
         raw.created_at,
         raw.sequence,
         raw.role,
         raw.tool_metadata_bytes,
         raw.has_content,
         CASE WHEN archived.message_id IS NULL THEN 0 ELSE 1 END AS archived,
         attempt.status,
         attempt.next_attempt_at
       FROM raw_window raw
       LEFT JOIN tool_payload_archives archived ON archived.message_id = raw.id
       LEFT JOIN tool_payload_cleanup_attempts attempt ON attempt.message_id = raw.id
       ORDER BY raw.physical_rowid ASC`,
      TOOL_PAYLOAD_CONTENT_KEY_NEEDLE,
      cursor?.rowId ?? 0,
      physicalLimit + 1
    )
    .raw();
  const candidates: ToolPayloadCandidate[] = [];
  let nextCursor: ToolPayloadCleanupCursor | null = cursor;
  let cumulativeBytes = 0;
  let physicalRows = 0;
  let hasMore = false;
  for (const row of rows) {
    if (physicalRows >= physicalLimit) {
      hasMore = true;
      break;
    }
    const rowId = rawNumber(row[0]);
    const messageId = row[1];
    const sessionId = row[2];
    const createdAt = rawNumber(row[3]);
    const sequence = rawNumber(row[4]);
    const role = row[5];
    const toolMetadataBytes = rawNumber(row[6]) ?? 0;
    const hasContent = rawNumber(row[7]) === 1;
    const archived = rawNumber(row[8]) === 1;
    const attemptStatus = typeof row[9] === 'string' ? row[9] : null;
    const nextAttemptAt = rawNumber(row[10]);
    if (
      rowId === null ||
      typeof messageId !== 'string' ||
      typeof sessionId !== 'string' ||
      createdAt === null
    ) {
      continue;
    }
    physicalRows++;
    const currentCursor: ToolPayloadCleanupCursor = {
      rowId,
      sessionId,
      createdAt,
      sequence: sequence ?? -1,
      messageId,
    };
    const eligible =
      role === 'tool' &&
      sequence !== null &&
      toolMetadataBytes > 0 &&
      hasContent &&
      createdAt < cutoffCreatedAt &&
      !archived &&
      attemptStatus !== 'no_reclaimable_payload' &&
      attemptStatus !== 'invalid_metadata' &&
      attemptStatus !== 'oversized' &&
      !(
        attemptStatus === 'retryable_failure' &&
        nextAttemptAt !== null &&
        nextAttemptAt > retryReadyAt
      );
    if (!eligible) {
      nextCursor = currentCursor;
      continue;
    }
    if (candidates.length >= limit) {
      hasMore = true;
      break;
    }
    const nextBytes = cumulativeBytes + toolMetadataBytes;
    if (nextBytes > maxMetadataBytes && !(allowOversizedFirst && candidates.length === 0)) {
      hasMore = true;
      break;
    }
    candidates.push({ ...currentCursor, toolMetadataBytes });
    cumulativeBytes = nextBytes;
    nextCursor = currentCursor;
  }
  return { candidates, hasMore, nextCursor };
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

function readBoundedToolMetadata(
  sql: SqlStorage,
  candidate: ToolPayloadCandidate,
  maxMetadataBytes: number
): string | null {
  const rows = sql
    .exec(
      `SELECT tool_metadata
       FROM chat_messages
       WHERE id = ?
         AND session_id = ?
         AND created_at = ?
         AND sequence = ?
         AND role = 'tool'
         AND tool_metadata IS NOT NULL
         AND length(CAST(tool_metadata AS BLOB)) <= ?
       LIMIT 1`,
      candidate.messageId,
      candidate.sessionId,
      candidate.createdAt,
      candidate.sequence,
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

function hasArchivedToolPayloadMarker(toolMetadata: string): boolean {
  try {
    const parsed: unknown = JSON.parse(toolMetadata);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const archive = record.toolPayloadArchive;
    return (
      record.toolPayloadArchived === true &&
      !Array.isArray(record.content) &&
      Boolean(
        archive &&
        typeof archive === 'object' &&
        !Array.isArray(archive) &&
        (archive as Record<string, unknown>).status === 'archived'
      )
    );
  } catch {
    return false;
  }
}

async function hasMatchingVerifiedApprovedArchive(
  context: ToolPayloadCandidateProcessingContext,
  candidate: ToolPayloadCandidate
): Promise<boolean> {
  if (!candidate.approvedToolMetadataSha256) return false;
  const archived = selectArchivedToolPayloadRow(
    context.sql,
    candidate.messageId,
    candidate.sessionId
  );
  if (
    archived?.sourceToolMetadataSha256 !== candidate.approvedToolMetadataSha256 ||
    archived.messageCreatedAt !== candidate.createdAt ||
    archived.messageSequence !== candidate.sequence ||
    archived.toolMetadataBytes !== candidate.toolMetadataBytes
  ) {
    return false;
  }
  const verified = await readArchivedMessageToolContent(
    context.sql,
    context.env,
    context.projectId,
    candidate.sessionId,
    candidate.messageId,
    {
      operationBudget: context.archiveOperationBudget,
      timeoutMs: context.archiveWriteTimeoutMs,
      deadlineMs: context.deadlineMs,
      nowMs: context.nowMs,
    }
  );
  return verified?.source === 'archive';
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
  if (candidate.toolMetadataBytes > context.maxRowBytes) {
    return failedBudgetUpdate(candidate, 'row');
  }
  if (candidate.toolMetadataBytes > maxReadBytes) return failedBudgetUpdate(candidate, 'batch');

  const toolMetadata = readBoundedToolMetadata(
    context.sql,
    candidate,
    Math.min(maxReadBytes, context.archiveMaxMetadataBytes)
  );
  if (toolMetadata === null) {
    if (!candidate.approvedToolMetadataSha256) return emptyCandidateUpdate();
    if (await hasMatchingVerifiedApprovedArchive(context, candidate)) {
      return { ...emptyCandidateUpdate(), cleanupAttemptStatus: 'archived' };
    }
    return {
      ...emptyCandidateUpdate(),
      rowsFailed: 1,
      retryableFailure: true,
      errorMessage:
        'approved tool payload source is missing and no matching verified archive exists',
      cleanupAttemptStatus: 'retryable_failure',
    };
  }
  if (candidate.approvedToolMetadataSha256) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(toolMetadata));
    const actual = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    if (actual !== candidate.approvedToolMetadataSha256) {
      if (
        hasArchivedToolPayloadMarker(toolMetadata) &&
        (await hasMatchingVerifiedApprovedArchive(context, candidate))
      ) {
        return { ...emptyCandidateUpdate(), cleanupAttemptStatus: 'archived' };
      }
      return {
        ...emptyCandidateUpdate(),
        rowsFailed: 1,
        retryableFailure: true,
        errorMessage: 'approved tool payload source SHA-256 changed after preflight',
        cleanupAttemptStatus: 'retryable_failure',
      };
    }
  }

  return archiveToolPayloadCandidate({
    sql: context.sql,
    env: context.env,
    projectId: context.projectId,
    archivePrefix: context.archivePrefix,
    archiveWriteTimeoutMs: context.archiveWriteTimeoutMs,
    archiveChunkBytes: context.archiveChunkBytes,
    deadlineMs: context.deadlineMs,
    nowMs: context.nowMs,
    operationBudget: context.archiveOperationBudget,
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
    approvedRowsCompleted: 0,
    approvedBytesCompleted: 0,
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
    archiveOperations: 0,
  };
}

export async function scanToolPayloadCandidates(
  input: ToolPayloadCandidateScanInput
): Promise<ToolPayloadCandidateScanResult> {
  const result = createEmptyCandidateScanResult();
  const nowMs = input.nowMs ?? Date.now;
  const archiveOperationBudget: ToolPayloadArchiveOperationBudget = input.operationBudget ?? {
    used: 0,
    max: input.archiveMaxOperations,
  };
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
    archiveOperationBudget,
    deadlineMs: input.deadlineMs,
    nowMs,
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

    if (updated.retryableFailure || (input.requireApprovedTargets && updated.rowsFailed > 0)) {
      result.retryableFailure = true;
      result.retryCursor = previousCursor;
      break;
    }

    result.approvedRowsCompleted++;
    result.approvedBytesCompleted += candidate.projectedReclaimableBytes ?? 0;
    previousCursor = candidate;

    if (nowMs() >= input.deadlineMs) {
      result.pausedForWallTime = true;
      result.retryCursor = candidate;
      break;
    }
  }

  result.archiveOperations = archiveOperationBudget.used;

  return result;
}
