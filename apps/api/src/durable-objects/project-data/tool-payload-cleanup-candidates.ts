import { stripToolMetadataPayloadForStorage } from './tool-metadata-storage';
import type { Env } from './types';

const textEncoder = new TextEncoder();

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
  errorMessages: string[];
};

type ToolPayloadCandidateUpdate = {
  rowsUpdated: number;
  rowsFailed: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  errorMessage: string | null;
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
  sessionId: string,
  cursor: ToolPayloadCleanupCursor | null,
  limit: number,
  maxMetadataBytes: number,
  allowOversizedFirst: boolean
): ToolPayloadCandidate[] {
  const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
  const cursorCreatedAt = messageCursor?.createdAt ?? null;
  const cursorSequence = messageCursor?.sequence ?? null;
  const cursorMessageId = messageCursor?.messageId ?? null;
  const rows = sql
    .exec(
      `WITH limited AS (
         SELECT
           id,
           created_at,
           COALESCE(sequence, 0) AS sequence,
           length(CAST(tool_metadata AS BLOB)) AS tool_metadata_bytes
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
         LIMIT ?
       ),
       bounded AS (
         SELECT
           id,
           created_at,
           sequence,
           tool_metadata_bytes,
           ROW_NUMBER() OVER (ORDER BY created_at ASC, sequence ASC, id ASC) AS row_number,
           SUM(tool_metadata_bytes) OVER (
             ORDER BY created_at ASC, sequence ASC, id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_tool_metadata_bytes
         FROM limited
       )
       SELECT id, created_at, sequence, tool_metadata_bytes
       FROM bounded
       WHERE cumulative_tool_metadata_bytes <= ?
          OR (? = 1 AND row_number = 1)
       ORDER BY created_at ASC, sequence ASC, id ASC`,
      sessionId,
      cursorCreatedAt,
      cursorCreatedAt ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorCreatedAt ?? 0,
      cursorSequence ?? 0,
      cursorMessageId ?? '',
      limit,
      maxMetadataBytes,
      allowOversizedFirst ? 1 : 0
    )
    .raw();
  return parseToolPayloadCandidateRows(sessionId, rows);
}

export function hasToolPayloadCandidatesAfter(
  sql: SqlStorage,
  sessionId: string,
  cursor: ToolPayloadCleanupCursor | null
): boolean {
  const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
  const cursorCreatedAt = messageCursor?.createdAt ?? null;
  const cursorSequence = messageCursor?.sequence ?? null;
  const cursorMessageId = messageCursor?.messageId ?? null;
  const rows = sql
    .exec(
      `SELECT id
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
      1
    )
    .raw();
  let found = false;
  for (const row of rows) {
    found = found || typeof row[0] === 'string';
  }
  return found;
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
    const toolMetadataBytes = rawNumber(row[3]);
    if (
      typeof id === 'string' &&
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
  let toolMetadata: string | null = null;
  for (const row of rows) {
    if (typeof row[0] === 'string') toolMetadata = row[0];
  }
  return toolMetadata;
}

function updateToolMetadata(sql: SqlStorage, messageId: string, toolMetadata: string | null): void {
  sql.exec('UPDATE chat_messages SET tool_metadata = ? WHERE id = ?', toolMetadata, messageId);
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function buildFailClosedToolMetadata(
  candidate: ToolPayloadCandidate,
  reason: 'oversized_legacy_payload' | 'poison_legacy_payload'
): string {
  return JSON.stringify({
    storageSafetyTruncated: true,
    contentTruncated: true,
    storageSafetyCleanupReason: reason,
    originalSizeBytes: candidate.toolMetadataBytes,
  });
}

function failClosedToolMetadataCandidate(
  sql: SqlStorage,
  candidate: ToolPayloadCandidate,
  reason: 'oversized_legacy_payload' | 'poison_legacy_payload'
): ToolPayloadCandidateUpdate {
  const value = buildFailClosedToolMetadata(candidate, reason);
  updateToolMetadata(sql, candidate.messageId, value);
  return {
    rowsUpdated: 1,
    rowsFailed: reason === 'poison_legacy_payload' ? 1 : 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: candidate.toolMetadataBytes,
    storedToolMetadataBytes: utf8Bytes(value),
    errorMessage: null,
  };
}

function processToolPayloadCandidate(
  sql: SqlStorage,
  env: Env,
  candidate: ToolPayloadCandidate,
  remainingReadBytes: number
): ToolPayloadCandidateUpdate {
  try {
    if (candidate.toolMetadataBytes > remainingReadBytes) {
      return failClosedToolMetadataCandidate(sql, candidate, 'oversized_legacy_payload');
    }

    const toolMetadata = readBoundedToolMetadata(sql, candidate.messageId, remainingReadBytes);
    if (toolMetadata === null) return emptyCandidateUpdate();

    const stripped = stripToolMetadataPayloadForStorage(toolMetadata, env);
    if (stripped.failed) {
      return failClosedToolMetadataCandidate(sql, candidate, 'poison_legacy_payload');
    }
    if (!stripped.stripped) {
      return {
        rowsUpdated: 0,
        rowsFailed: 0,
        toolMetadataBytesRead: stripped.originalBytes,
        originalToolMetadataBytes: 0,
        storedToolMetadataBytes: 0,
        errorMessage: null,
      };
    }

    updateToolMetadata(sql, candidate.messageId, stripped.value);
    return {
      rowsUpdated: 1,
      rowsFailed: 0,
      toolMetadataBytesRead: stripped.originalBytes,
      originalToolMetadataBytes: stripped.originalBytes,
      storedToolMetadataBytes: stripped.storedBytes,
      errorMessage: null,
    };
  } catch (error) {
    return failClosedAfterError(sql, candidate, error);
  }
}

function emptyCandidateUpdate(): ToolPayloadCandidateUpdate {
  return {
    rowsUpdated: 0,
    rowsFailed: 0,
    toolMetadataBytesRead: 0,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    errorMessage: null,
  };
}

function failClosedAfterError(
  sql: SqlStorage,
  candidate: ToolPayloadCandidate,
  error: unknown
): ToolPayloadCandidateUpdate {
  try {
    const failClosed = failClosedToolMetadataCandidate(sql, candidate, 'poison_legacy_payload');
    return {
      ...failClosed,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } catch (failClosedError) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const failClosedMessage =
      failClosedError instanceof Error ? failClosedError.message : String(failClosedError);
    return {
      rowsUpdated: 0,
      rowsFailed: 1,
      toolMetadataBytesRead: 0,
      originalToolMetadataBytes: 0,
      storedToolMetadataBytes: 0,
      errorMessage: `${originalMessage}; fail-closed update failed: ${failClosedMessage}`,
    };
  }
}

export function scanToolPayloadCandidates(
  sql: SqlStorage,
  env: Env,
  batchBytes: number,
  candidates: ToolPayloadCandidate[]
): ToolPayloadCandidateScanResult {
  const result = createEmptyCandidateScanResult();
  for (const candidate of candidates) {
    result.lastCursor = candidate;
    result.toolMetadataBytesScanned += candidate.toolMetadataBytes;
    const remainingReadBytes = Math.max(batchBytes - result.toolMetadataBytesRead, 0);
    const updated = processToolPayloadCandidate(sql, env, candidate, remainingReadBytes);
    result.rowsUpdated += updated.rowsUpdated;
    result.rowsFailed += updated.rowsFailed;
    result.toolMetadataBytesRead += updated.toolMetadataBytesRead;
    result.originalToolMetadataBytes += updated.originalToolMetadataBytes;
    result.storedToolMetadataBytes += updated.storedToolMetadataBytes;
    if (updated.errorMessage) result.errorMessages.push(updated.errorMessage);
  }
  result.rowsScanned = candidates.length;
  return result;
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
    errorMessages: [],
  };
}
