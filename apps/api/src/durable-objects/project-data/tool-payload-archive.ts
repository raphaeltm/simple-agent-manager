import { createModuleLogger, serializeError } from '../../lib/logger';
import { stripToolMetadataPayloadForStorage } from './tool-metadata-storage';
import {
  type PreparedToolPayloadArchive,
  type ToolPayloadArchiveOperationBudget,
  writeToolPayloadArchiveObject,
} from './tool-payload-archive-r2';
import type { ToolPayloadCleanupAttemptStatus } from './tool-payload-cleanup-attempts';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_archive');
const textEncoder = new TextEncoder();

export const TOOL_PAYLOAD_ARCHIVE_VERSION = 1;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX = 'project-data/tool-payloads';
export {
  TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION,
  TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION,
} from './tool-payload-archive-r2';
export {
  listArchivedToolPayloads,
  readArchivedMessageToolContent,
  selectArchivedToolPayloadRow,
} from './tool-payload-archive-read';

export type ArchivedToolPayloadRow = {
  messageId: string;
  sessionId: string;
  r2Key: string;
  contentBytes: number;
  toolMetadataBytes: number;
  archivedAt: number;
  messageCreatedAt: number;
  messageSequence: number;
  archiveVersion: number;
  archiveBodyBytes: number | null;
  archiveBodySha256: string | null;
  rootObjectBytes: number | null;
  rootObjectSha256: string | null;
  verifiedObjectCount: number | null;
  sourceToolMetadataSha256: string | null;
};

export type MessageToolContentResult = {
  content: unknown[];
  source: 'inline' | 'archive' | 'archived_unavailable';
  archived?: {
    archivedAt: number;
    contentBytes: number;
    reason?: string;
  };
};

export type ArchivedToolPayloadQuery = {
  messageId?: string;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  limit: number;
};

export type ArchivedToolPayloadItem = {
  messageId: string;
  sessionId: string;
  messageCreatedAt: number;
  messageSequence: number;
  archivedAt: number;
  contentBytes: number;
  toolMetadataBytes: number;
  archiveVersion: number;
  available: boolean;
  content: unknown[] | null;
  unavailableReason?: string;
};

export type ArchivedToolPayloadListResult = {
  projectId: string;
  payloads: ArchivedToolPayloadItem[];
  count: number;
  hasMore: boolean;
};

export type ToolPayloadArchiveCandidate = {
  sessionId: string;
  createdAt: number;
  sequence: number;
  messageId: string;
  toolMetadataBytes: number;
};

export type ToolPayloadArchiveUpdateResult = {
  rowsUpdated: number;
  rowsFailed: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  retryableFailure: boolean;
  errorMessage: string | null;
  cleanupAttemptStatus: ToolPayloadCleanupAttemptStatus | 'archived' | null;
};

type ArchivedToolPayloadObject = {
  version: typeof TOOL_PAYLOAD_ARCHIVE_VERSION;
  projectId: string;
  sessionId: string;
  messageId: string;
  messageCreatedAt: number;
  messageSequence: number;
  archivedAt: number;
  contentBytes: number;
  toolMetadataBytes: number;
  toolMetadata: Record<string, unknown>;
};

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stripBoundarySlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function normalizeArchivePrefix(prefix: string): string {
  const trimmed = stripBoundarySlashes(prefix.trim());
  return trimmed || DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX;
}

function encodeR2KeySegment(value: string): string {
  return encodeURIComponent(value);
}

export function buildToolPayloadArchiveKey(input: {
  prefix: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  messageCreatedAt: number;
  messageSequence: number;
}): string {
  const prefix = normalizeArchivePrefix(input.prefix);
  return [
    prefix,
    encodeR2KeySegment(input.projectId),
    encodeR2KeySegment(input.sessionId),
    `${input.messageCreatedAt}-${input.messageSequence}-${encodeR2KeySegment(input.messageId)}.json`,
  ].join('/');
}

function extractToolPayloadContent(toolMetadata: string): {
  parsed: Record<string, unknown>;
  content: unknown[];
  contentBytes: number;
} | null {
  const parsed = JSON.parse(toolMetadata) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool_metadata must be a JSON object before it can be archived');
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.content) || record.content.length === 0) return null;
  const contentJson = JSON.stringify(record.content);
  return {
    parsed: record,
    content: record.content,
    contentBytes: utf8Bytes(contentJson),
  };
}

export function projectToolPayloadArchiveRelief(input: {
  env: Env;
  toolMetadata: string;
  archivedAt: number;
}): { contentBytes: number; storedToolMetadataBytes: number; reclaimableBytes: number } | null {
  let payload: ReturnType<typeof extractToolPayloadContent>;
  try {
    payload = extractToolPayloadContent(input.toolMetadata);
  } catch {
    return null;
  }
  if (!payload) return null;
  const stripped = stripToolMetadataPayloadForStorage(input.toolMetadata, input.env);
  if (stripped.failed || !stripped.stripped || typeof stripped.value !== 'string') return null;
  const storedToolMetadataBytes = utf8Bytes(
    addArchiveMarker(stripped.value, input.archivedAt, payload.contentBytes)
  );
  const originalToolMetadataBytes = utf8Bytes(input.toolMetadata);
  const reclaimableBytes = Math.max(originalToolMetadataBytes - storedToolMetadataBytes, 0);
  if (reclaimableBytes === 0) return null;
  return { contentBytes: payload.contentBytes, storedToolMetadataBytes, reclaimableBytes };
}

function addArchiveMarker(
  strippedToolMetadata: string,
  archivedAt: number,
  contentBytes: number
): string {
  const parsed = JSON.parse(strippedToolMetadata) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return strippedToolMetadata;
  }
  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    toolPayloadArchived: true,
    toolPayloadArchive: {
      status: 'archived',
      archivedAt,
      contentBytes,
      version: TOOL_PAYLOAD_ARCHIVE_VERSION,
    },
  });
}

function prepareToolPayloadArchive(input: {
  env: Env;
  projectId: string;
  archivePrefix: string;
  candidate: ToolPayloadArchiveCandidate;
  toolMetadata: string;
  archivedAt: number;
}): PreparedToolPayloadArchive | null {
  const payload = extractToolPayloadContent(input.toolMetadata);
  if (!payload) return null;

  const stripped = stripToolMetadataPayloadForStorage(input.toolMetadata, input.env);
  if (stripped.failed) {
    throw new Error('tool_metadata content could not be stripped after archive preparation');
  }
  if (!stripped.stripped || typeof stripped.value !== 'string') return null;

  const strippedToolMetadata = addArchiveMarker(
    stripped.value,
    input.archivedAt,
    payload.contentBytes
  );
  const bodyObject: ArchivedToolPayloadObject = {
    version: TOOL_PAYLOAD_ARCHIVE_VERSION,
    projectId: input.projectId,
    sessionId: input.candidate.sessionId,
    messageId: input.candidate.messageId,
    messageCreatedAt: input.candidate.createdAt,
    messageSequence: input.candidate.sequence,
    archivedAt: input.archivedAt,
    contentBytes: payload.contentBytes,
    toolMetadataBytes: utf8Bytes(input.toolMetadata),
    toolMetadata: payload.parsed,
  };

  return {
    key: buildToolPayloadArchiveKey({
      prefix: input.archivePrefix,
      projectId: input.projectId,
      sessionId: input.candidate.sessionId,
      messageId: input.candidate.messageId,
      messageCreatedAt: input.candidate.createdAt,
      messageSequence: input.candidate.sequence,
    }),
    body: JSON.stringify(bodyObject),
    contentBytes: payload.contentBytes,
    archiveVersion: TOOL_PAYLOAD_ARCHIVE_VERSION,
    strippedToolMetadata,
    strippedToolMetadataBytes: utf8Bytes(strippedToolMetadata),
  };
}

function upsertArchiveRow(
  sql: SqlStorage,
  candidate: ToolPayloadArchiveCandidate,
  archivedAt: number,
  prepared: PreparedToolPayloadArchive,
  sourceToolMetadataSha256: string
): void {
  const verification = prepared.verification;
  if (!verification) throw new Error('verified archive proof is required for bookkeeping');
  sql.exec(
    `INSERT INTO tool_payload_archives (
       message_id,
       session_id,
       r2_key,
       content_bytes,
       tool_metadata_bytes,
       archived_at,
       message_created_at,
       message_sequence,
       archive_version,
       archive_body_bytes,
       archive_body_sha256,
       root_object_bytes,
       root_object_sha256,
       verified_object_count,
       source_tool_metadata_sha256
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       session_id = excluded.session_id,
       r2_key = excluded.r2_key,
       content_bytes = excluded.content_bytes,
       tool_metadata_bytes = excluded.tool_metadata_bytes,
       archived_at = excluded.archived_at,
       message_created_at = excluded.message_created_at,
       message_sequence = excluded.message_sequence,
       archive_version = excluded.archive_version,
       archive_body_bytes = excluded.archive_body_bytes,
       archive_body_sha256 = excluded.archive_body_sha256,
       root_object_bytes = excluded.root_object_bytes,
       root_object_sha256 = excluded.root_object_sha256,
       verified_object_count = excluded.verified_object_count,
       source_tool_metadata_sha256 = excluded.source_tool_metadata_sha256`,
    candidate.messageId,
    candidate.sessionId,
    prepared.key,
    prepared.contentBytes,
    candidate.toolMetadataBytes,
    archivedAt,
    candidate.createdAt,
    candidate.sequence,
    prepared.archiveVersion,
    verification.archiveBodyBytes,
    verification.archiveBodySha256,
    verification.rootObjectBytes,
    verification.rootObjectSha256,
    verification.objectCount,
    sourceToolMetadataSha256
  );
}

function updateToolMetadata(
  sql: SqlStorage,
  candidate: ToolPayloadArchiveCandidate,
  originalToolMetadata: string,
  strippedToolMetadata: string
): void {
  const update = sql.exec(
    `UPDATE chat_messages
     SET tool_metadata = ?
     WHERE id = ?
       AND session_id = ?
       AND created_at = ?
       AND sequence = ?
       AND role = 'tool'
       AND tool_metadata = ?`,
    strippedToolMetadata,
    candidate.messageId,
    candidate.sessionId,
    candidate.createdAt,
    candidate.sequence,
    originalToolMetadata
  );
  if (update.rowsWritten !== 1) {
    throw new Error('tool_metadata source changed after archive verification');
  }
}

function emptyArchiveUpdate(toolMetadataBytesRead: number): ToolPayloadArchiveUpdateResult {
  return {
    rowsUpdated: 0,
    rowsFailed: 0,
    toolMetadataBytesRead,
    originalToolMetadataBytes: 0,
    storedToolMetadataBytes: 0,
    retryableFailure: false,
    errorMessage: null,
    cleanupAttemptStatus: 'no_reclaimable_payload',
  };
}

function failedArchiveUpdate(input: {
  toolMetadataBytesRead?: number;
  originalToolMetadataBytes?: number;
  retryableFailure: boolean;
  errorMessage: string;
  cleanupAttemptStatus: ToolPayloadCleanupAttemptStatus;
}): ToolPayloadArchiveUpdateResult {
  return {
    rowsUpdated: 0,
    rowsFailed: 1,
    toolMetadataBytesRead: input.toolMetadataBytesRead ?? 0,
    originalToolMetadataBytes: input.originalToolMetadataBytes ?? 0,
    storedToolMetadataBytes: 0,
    retryableFailure: input.retryableFailure,
    errorMessage: input.errorMessage,
    cleanupAttemptStatus: input.cleanupAttemptStatus,
  };
}

function writeArchiveBookkeeping(input: {
  sql: SqlStorage;
  transactionSync?: <T>(callback: () => T) => T;
  candidate: ToolPayloadArchiveCandidate;
  archivedAt: number;
  prepared: PreparedToolPayloadArchive;
  originalToolMetadata: string;
  sourceToolMetadataSha256: string;
}): void {
  const transactionSync = input.transactionSync ?? (<T>(callback: () => T): T => callback());
  transactionSync(() => {
    updateToolMetadata(
      input.sql,
      input.candidate,
      input.originalToolMetadata,
      input.prepared.strippedToolMetadata
    );
    upsertArchiveRow(
      input.sql,
      input.candidate,
      input.archivedAt,
      input.prepared,
      input.sourceToolMetadataSha256
    );
  });
}

export async function archiveToolPayloadCandidate(input: {
  sql: SqlStorage;
  env: Env;
  projectId: string;
  archivePrefix: string;
  archiveWriteTimeoutMs: number;
  archiveChunkBytes: number;
  deadlineMs: number;
  nowMs: () => number;
  operationBudget: ToolPayloadArchiveOperationBudget;
  transactionSync?: <T>(callback: () => T) => T;
  candidate: ToolPayloadArchiveCandidate;
  toolMetadata: string;
  archivedAt: number;
}): Promise<ToolPayloadArchiveUpdateResult> {
  const toolMetadataBytesRead = utf8Bytes(input.toolMetadata);
  const sourceToolMetadataSha256 = await sha256Hex(textEncoder.encode(input.toolMetadata));
  let prepared: PreparedToolPayloadArchive | null;
  try {
    prepared = prepareToolPayloadArchive(input);
  } catch (error) {
    return failedArchiveUpdate({
      toolMetadataBytesRead,
      originalToolMetadataBytes: input.candidate.toolMetadataBytes,
      retryableFailure: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      cleanupAttemptStatus: 'invalid_metadata',
    });
  }

  if (!prepared) return emptyArchiveUpdate(toolMetadataBytesRead);

  const r2 = input.env.PROJECT_DATA_ARCHIVE_R2;
  if (!r2) {
    return failedArchiveUpdate({
      toolMetadataBytesRead,
      originalToolMetadataBytes: input.candidate.toolMetadataBytes,
      retryableFailure: true,
      errorMessage: 'PROJECT_DATA_ARCHIVE_R2 binding is not configured',
      cleanupAttemptStatus: 'retryable_failure',
    });
  }

  try {
    prepared = await writeToolPayloadArchiveObject(r2, prepared, input.archiveWriteTimeoutMs, {
      projectId: input.projectId,
      sessionId: input.candidate.sessionId,
      messageId: input.candidate.messageId,
      messageCreatedAt: input.candidate.createdAt,
      messageSequence: input.candidate.sequence,
      archivedAt: input.archivedAt,
      contentBytes: prepared.contentBytes,
      toolMetadataBytes: input.candidate.toolMetadataBytes,
      chunkBytes: input.archiveChunkBytes,
      deadlineMs: input.deadlineMs,
      nowMs: input.nowMs,
      operationBudget: input.operationBudget,
    });
    if (!prepared.verification) {
      throw new Error('R2 archive verification proof is missing after write');
    }
    if (input.nowMs() >= input.deadlineMs) {
      throw new Error('cleanup wall-time deadline elapsed before archive bookkeeping');
    }
    log.info('archive_verified_before_strip', {
      projectId: input.projectId,
      sessionId: input.candidate.sessionId,
      messageId: input.candidate.messageId,
      r2Key: prepared.key,
      archiveVersion: prepared.archiveVersion,
      archiveBodyBytes: prepared.verification.archiveBodyBytes,
      archiveBodySha256: prepared.verification.archiveBodySha256,
      rootObjectBytes: prepared.verification.rootObjectBytes,
      rootObjectSha256: prepared.verification.rootObjectSha256,
      verifiedObjectCount: prepared.verification.objectCount,
    });
    writeArchiveBookkeeping({
      sql: input.sql,
      ...(input.transactionSync ? { transactionSync: input.transactionSync } : {}),
      candidate: input.candidate,
      archivedAt: input.archivedAt,
      prepared,
      originalToolMetadata: input.toolMetadata,
      sourceToolMetadataSha256,
    });
  } catch (error) {
    log.warn('archive_write_failed_closed', {
      projectId: input.projectId,
      sessionId: input.candidate.sessionId,
      messageId: input.candidate.messageId,
      ...serializeError(error),
    });
    return failedArchiveUpdate({
      toolMetadataBytesRead,
      originalToolMetadataBytes: input.candidate.toolMetadataBytes,
      retryableFailure: true,
      errorMessage: error instanceof Error ? error.message : String(error),
      cleanupAttemptStatus: 'retryable_failure',
    });
  }

  return {
    rowsUpdated: 1,
    rowsFailed: 0,
    toolMetadataBytesRead,
    originalToolMetadataBytes: input.candidate.toolMetadataBytes,
    storedToolMetadataBytes: prepared.strippedToolMetadataBytes,
    retryableFailure: false,
    errorMessage: null,
    cleanupAttemptStatus: 'archived',
  };
}
