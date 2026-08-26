import { createModuleLogger, serializeError } from '../../lib/logger';
import { stripToolMetadataPayloadForStorage } from './tool-metadata-storage';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_archive');
const textEncoder = new TextEncoder();

export const TOOL_PAYLOAD_ARCHIVE_VERSION = 1;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX = 'project-data/tool-payloads';

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
};

type PreparedToolPayloadArchive = {
  key: string;
  body: string;
  contentBytes: number;
  strippedToolMetadata: string;
  strippedToolMetadataBytes: number;
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

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
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
    strippedToolMetadata,
    strippedToolMetadataBytes: utf8Bytes(strippedToolMetadata),
  };
}

async function writeArchiveObject(
  r2: R2Bucket,
  key: string,
  body: string,
  input: {
    projectId: string;
    sessionId: string;
    messageId: string;
    archivedAt: number;
    contentBytes: number;
  }
): Promise<void> {
  await r2.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      archivedAt: String(input.archivedAt),
      contentBytes: String(input.contentBytes),
    },
  });
}

function upsertArchiveRow(
  sql: SqlStorage,
  candidate: ToolPayloadArchiveCandidate,
  archivedAt: number,
  prepared: PreparedToolPayloadArchive
): void {
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
       archive_version
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       session_id = excluded.session_id,
       r2_key = excluded.r2_key,
       content_bytes = excluded.content_bytes,
       tool_metadata_bytes = excluded.tool_metadata_bytes,
       archived_at = excluded.archived_at,
       message_created_at = excluded.message_created_at,
       message_sequence = excluded.message_sequence,
       archive_version = excluded.archive_version`,
    candidate.messageId,
    candidate.sessionId,
    prepared.key,
    prepared.contentBytes,
    candidate.toolMetadataBytes,
    archivedAt,
    candidate.createdAt,
    candidate.sequence,
    TOOL_PAYLOAD_ARCHIVE_VERSION
  );
}

function updateToolMetadata(sql: SqlStorage, messageId: string, toolMetadata: string): void {
  sql.exec('UPDATE chat_messages SET tool_metadata = ? WHERE id = ?', toolMetadata, messageId);
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
  };
}

function failedArchiveUpdate(input: {
  toolMetadataBytesRead?: number;
  originalToolMetadataBytes?: number;
  retryableFailure: boolean;
  errorMessage: string;
}): ToolPayloadArchiveUpdateResult {
  return {
    rowsUpdated: 0,
    rowsFailed: 1,
    toolMetadataBytesRead: input.toolMetadataBytesRead ?? 0,
    originalToolMetadataBytes: input.originalToolMetadataBytes ?? 0,
    storedToolMetadataBytes: 0,
    retryableFailure: input.retryableFailure,
    errorMessage: input.errorMessage,
  };
}

export async function archiveToolPayloadCandidate(input: {
  sql: SqlStorage;
  env: Env;
  projectId: string;
  archivePrefix: string;
  candidate: ToolPayloadArchiveCandidate;
  toolMetadata: string;
  archivedAt: number;
}): Promise<ToolPayloadArchiveUpdateResult> {
  const toolMetadataBytesRead = utf8Bytes(input.toolMetadata);
  let prepared: PreparedToolPayloadArchive | null;
  try {
    prepared = prepareToolPayloadArchive(input);
  } catch (error) {
    return failedArchiveUpdate({
      toolMetadataBytesRead,
      originalToolMetadataBytes: input.candidate.toolMetadataBytes,
      retryableFailure: false,
      errorMessage: error instanceof Error ? error.message : String(error),
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
    });
  }

  try {
    await writeArchiveObject(r2, prepared.key, prepared.body, {
      projectId: input.projectId,
      sessionId: input.candidate.sessionId,
      messageId: input.candidate.messageId,
      archivedAt: input.archivedAt,
      contentBytes: prepared.contentBytes,
    });
    upsertArchiveRow(input.sql, input.candidate, input.archivedAt, prepared);
    updateToolMetadata(input.sql, input.candidate.messageId, prepared.strippedToolMetadata);
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
  };
}

export function selectArchivedToolPayloadRow(
  sql: SqlStorage,
  messageId: string,
  sessionId?: string | null
): ArchivedToolPayloadRow | null {
  const rows = sql
    .exec(
      `SELECT
         message_id,
         session_id,
         r2_key,
         content_bytes,
         tool_metadata_bytes,
         archived_at,
         message_created_at,
         message_sequence,
         archive_version
       FROM tool_payload_archives
       WHERE message_id = ?
         AND (? IS NULL OR session_id = ?)
       LIMIT 1`,
      messageId,
      sessionId ?? null,
      sessionId ?? null
    )
    .raw();
  const firstRow = rows.next();
  return firstRow.done ? null : parseArchivedToolPayloadRow(firstRow.value);
}

function parseArchivedToolPayloadRow(row: unknown[]): ArchivedToolPayloadRow {
  const messageId = row[0];
  const sessionId = row[1];
  const r2Key = row[2];
  const contentBytes = rawNumber(row[3]);
  const toolMetadataBytes = rawNumber(row[4]);
  const archivedAt = rawNumber(row[5]);
  const messageCreatedAt = rawNumber(row[6]);
  const messageSequence = rawNumber(row[7]);
  const archiveVersion = rawNumber(row[8]);
  if (
    typeof messageId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof r2Key !== 'string' ||
    contentBytes === null ||
    toolMetadataBytes === null ||
    archivedAt === null ||
    messageCreatedAt === null ||
    messageSequence === null ||
    archiveVersion === null
  ) {
    throw new Error('Invalid archived tool payload row');
  }
  return {
    messageId,
    sessionId,
    r2Key,
    contentBytes,
    toolMetadataBytes,
    archivedAt,
    messageCreatedAt,
    messageSequence,
    archiveVersion,
  };
}

async function readArchiveContent(
  env: Env,
  row: ArchivedToolPayloadRow
): Promise<{ content: unknown[]; reason?: never } | { content: null; reason: string }> {
  const r2 = env.PROJECT_DATA_ARCHIVE_R2;
  if (!r2) return { content: null, reason: 'PROJECT_DATA_ARCHIVE_R2 binding is not configured' };

  try {
    const object = await r2.get(row.r2Key);
    if (!object) return { content: null, reason: 'archived R2 object is missing' };
    const text = await object.text();
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { content: null, reason: 'archived R2 object is malformed' };
    }
    const toolMetadata = (parsed as Record<string, unknown>).toolMetadata;
    if (!toolMetadata || typeof toolMetadata !== 'object' || Array.isArray(toolMetadata)) {
      return { content: null, reason: 'archived tool metadata is malformed' };
    }
    const content = (toolMetadata as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return { content: null, reason: 'archived tool payload content is missing' };
    }
    return { content };
  } catch (error) {
    log.warn('archive_read_failed', {
      sessionId: row.sessionId,
      messageId: row.messageId,
      ...serializeError(error),
    });
    return {
      content: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildArchivedUnavailableContent(row: ArchivedToolPayloadRow, reason: string): unknown[] {
  return [
    {
      type: 'text',
      text:
        'Tool output was archived to private storage but is temporarily unavailable. ' +
        `Reason: ${reason}. Message: ${row.messageId}.`,
    },
  ];
}

export async function readArchivedMessageToolContent(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  messageId: string
): Promise<MessageToolContentResult | null> {
  const row = selectArchivedToolPayloadRow(sql, messageId, sessionId);
  if (!row) return null;

  const archive = await readArchiveContent(env, row);
  if (archive.content) {
    return {
      content: archive.content,
      source: 'archive',
      archived: {
        archivedAt: row.archivedAt,
        contentBytes: row.contentBytes,
      },
    };
  }

  return {
    content: buildArchivedUnavailableContent(row, archive.reason),
    source: 'archived_unavailable',
    archived: {
      archivedAt: row.archivedAt,
      contentBytes: row.contentBytes,
      reason: archive.reason,
    },
  };
}

function selectArchivedToolPayloadRows(
  sql: SqlStorage,
  query: ArchivedToolPayloadQuery
): { rows: ArchivedToolPayloadRow[]; hasMore: boolean } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.messageId) {
    conditions.push('message_id = ?');
    params.push(query.messageId);
  }
  if (query.sessionId) {
    conditions.push('session_id = ?');
    params.push(query.sessionId);
  }
  if (typeof query.startTime === 'number') {
    conditions.push('message_created_at >= ?');
    params.push(query.startTime);
  }
  if (typeof query.endTime === 'number') {
    conditions.push('message_created_at <= ?');
    params.push(query.endTime);
  }

  const where = conditions.length > 0 ? conditions.join(' AND ') : '1 = 1';
  const rows = sql
    .exec(
      `SELECT
         message_id,
         session_id,
         r2_key,
         content_bytes,
         tool_metadata_bytes,
         archived_at,
         message_created_at,
         message_sequence,
         archive_version
       FROM tool_payload_archives
       WHERE ${where}
       ORDER BY message_created_at ASC, message_sequence ASC, message_id ASC
       LIMIT ?`,
      ...params,
      query.limit + 1
    )
    .raw();

  const parsed: ArchivedToolPayloadRow[] = [];
  for (const row of rows) {
    parsed.push(parseArchivedToolPayloadRow(row));
  }
  return {
    rows: parsed.slice(0, query.limit),
    hasMore: parsed.length > query.limit,
  };
}

export async function listArchivedToolPayloads(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  query: ArchivedToolPayloadQuery
): Promise<ArchivedToolPayloadListResult> {
  const selected = selectArchivedToolPayloadRows(sql, query);
  const payloads: ArchivedToolPayloadItem[] = [];
  for (const row of selected.rows) {
    const archive = await readArchiveContent(env, row);
    payloads.push({
      messageId: row.messageId,
      sessionId: row.sessionId,
      messageCreatedAt: row.messageCreatedAt,
      messageSequence: row.messageSequence,
      archivedAt: row.archivedAt,
      contentBytes: row.contentBytes,
      toolMetadataBytes: row.toolMetadataBytes,
      archiveVersion: row.archiveVersion,
      available: Boolean(archive.content),
      content: archive.content,
      ...(archive.reason ? { unavailableReason: archive.reason } : {}),
    });
  }

  return {
    projectId,
    payloads,
    count: payloads.length,
    hasMore: selected.hasMore,
  };
}
