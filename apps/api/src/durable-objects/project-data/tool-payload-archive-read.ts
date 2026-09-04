import { createModuleLogger, serializeError } from '../../lib/logger';
import type {
  ArchivedToolPayloadItem,
  ArchivedToolPayloadListResult,
  ArchivedToolPayloadQuery,
  ArchivedToolPayloadRow,
  MessageToolContentResult,
} from './tool-payload-archive';
import {
  parseToolPayloadArchiveObjectText,
  readToolPayloadArchiveObjectBytesWithTimeout,
  reserveToolPayloadArchiveOperations,
  TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION,
  type ToolPayloadArchiveOperationBudget,
} from './tool-payload-archive-r2';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_archive_read');
const DEFAULT_TOOL_PAYLOAD_ARCHIVE_RETRIEVAL_MAX_METADATA_BYTES = 1_900_000;

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
         archive_version,
         archive_body_bytes,
         archive_body_sha256,
         root_object_bytes,
         root_object_sha256,
         verified_object_count,
         source_tool_metadata_sha256
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
  const archiveBodyBytes = row[9] === null ? null : rawNumber(row[9]);
  const archiveBodySha256 = row[10];
  const rootObjectBytes = row[11] === null ? null : rawNumber(row[11]);
  const rootObjectSha256 = row[12];
  const verifiedObjectCount = row[13] === null ? null : rawNumber(row[13]);
  const sourceToolMetadataSha256 = row[14];
  if (
    typeof messageId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof r2Key !== 'string' ||
    contentBytes === null ||
    toolMetadataBytes === null ||
    archivedAt === null ||
    messageCreatedAt === null ||
    messageSequence === null ||
    archiveVersion === null ||
    (archiveBodySha256 !== null && typeof archiveBodySha256 !== 'string') ||
    (rootObjectSha256 !== null && typeof rootObjectSha256 !== 'string') ||
    (sourceToolMetadataSha256 !== null && typeof sourceToolMetadataSha256 !== 'string')
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
    archiveBodyBytes,
    archiveBodySha256,
    rootObjectBytes,
    rootObjectSha256,
    verifiedObjectCount,
    sourceToolMetadataSha256,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readArchiveContent(
  env: Env,
  row: ArchivedToolPayloadRow,
  projectId: string,
  verificationBudget?: {
    operationBudget: ToolPayloadArchiveOperationBudget;
    timeoutMs: number;
    deadlineMs: number;
    nowMs: () => number;
  }
): Promise<{ content: unknown[]; reason?: never } | { content: null; reason: string }> {
  const r2 = env.PROJECT_DATA_ARCHIVE_R2;
  if (!r2) return { content: null, reason: 'PROJECT_DATA_ARCHIVE_R2 binding is not configured' };

  try {
    const rootBytes = verificationBudget
      ? await (async () => {
          reserveToolPayloadArchiveOperations(verificationBudget.operationBudget, 2);
          return readToolPayloadArchiveObjectBytesWithTimeout(
            r2,
            row.r2Key,
            verificationBudget.timeoutMs,
            verificationBudget.deadlineMs,
            verificationBudget.nowMs
          );
        })()
      : await (async () => {
          const object = await r2.get(row.r2Key);
          if (!object) throw new Error('archived R2 object is missing');
          return new Uint8Array(await object.arrayBuffer());
        })();
    if (row.archiveVersion >= TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION) {
      if (
        row.rootObjectBytes === null ||
        row.rootObjectSha256 === null ||
        row.archiveBodyBytes === null ||
        row.archiveBodySha256 === null ||
        row.verifiedObjectCount === null
      ) {
        return { content: null, reason: 'verified archive proof is missing' };
      }
      if (rootBytes.byteLength !== row.rootObjectBytes) {
        return { content: null, reason: 'archived R2 root byte verification failed' };
      }
      if ((await sha256Hex(rootBytes)) !== row.rootObjectSha256) {
        return { content: null, reason: 'archived R2 root SHA-256 verification failed' };
      }
    }
    const text = new TextDecoder().decode(rootBytes);
    const maxMetadataBytes = parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES,
      DEFAULT_TOOL_PAYLOAD_ARCHIVE_RETRIEVAL_MAX_METADATA_BYTES
    );
    const parsed = await parseToolPayloadArchiveObjectText(r2, text, {
      toolMetadataBytes: row.toolMetadataBytes,
      maxMetadataBytes,
      expectedIdentity: {
        projectId,
        sessionId: row.sessionId,
        messageId: row.messageId,
        messageCreatedAt: row.messageCreatedAt,
        messageSequence: row.messageSequence,
      },
      ...(verificationBudget ? { verificationBudget } : {}),
    });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { content: null, reason: 'archived R2 object is malformed' };
    }
    const archiveRecord = parsed as Record<string, unknown>;
    if (
      archiveRecord.projectId !== projectId ||
      archiveRecord.sessionId !== row.sessionId ||
      archiveRecord.messageId !== row.messageId ||
      archiveRecord.messageCreatedAt !== row.messageCreatedAt ||
      archiveRecord.messageSequence !== row.messageSequence
    ) {
      return { content: null, reason: 'archived tool payload identity does not match archive row' };
    }
    const toolMetadata = archiveRecord.toolMetadata;
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
  projectId: string,
  sessionId: string,
  messageId: string,
  verificationBudget?: {
    operationBudget: ToolPayloadArchiveOperationBudget;
    timeoutMs: number;
    deadlineMs: number;
    nowMs: () => number;
  }
): Promise<MessageToolContentResult | null> {
  const row = selectArchivedToolPayloadRow(sql, messageId, sessionId);
  if (!row) return null;

  const archive = await readArchiveContent(env, row, projectId, verificationBudget);
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
         archive_version,
         archive_body_bytes,
         archive_body_sha256,
         root_object_bytes,
         root_object_sha256,
         verified_object_count,
         source_tool_metadata_sha256
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
    const archive = await readArchiveContent(env, row, projectId);
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
