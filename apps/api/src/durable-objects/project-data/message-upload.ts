import type { Env } from './types';

export type MessageUploadPart = {
  sessionId: string;
  messageId: string;
  field: 'content' | 'toolMetadata';
  part: number;
  data: string;
};

export type MessageUploadCommit = {
  sessionId: string;
  messageId: string;
  role: string;
  timestamp: string;
  origin: string | null;
  sequence: number;
  contentParts: number;
  metadataParts: number;
  contentSha256: string;
  metadataSha256: string;
};

const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PARTS = 256;
const DEFAULT_MAX_SESSION_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STAGED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STAGED_PARTS = 4096;
const DEFAULT_MAX_INVENTORY_LIMIT = 100;

function uploadLimit(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_UPLOAD_BYTES || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

function partLimit(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_UPLOAD_PARTS || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PARTS;
}

function sessionLimit(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_UPLOAD_SESSION_BYTES || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SESSION_BYTES;
}

function stagedLimit(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_UPLOAD_STAGED_BYTES || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STAGED_BYTES;
}

function stagedPartLimit(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_UPLOAD_STAGED_PARTS || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STAGED_PARTS;
}

export function resolveMessageUploadInventoryLimit(env: Env): number {
  const parsed = Number.parseInt(env.MAX_MESSAGE_UPLOAD_INVENTORY_LIMIT || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INVENTORY_LIMIT;
}

function committedMessage(
  sql: SqlStorage,
  input: { messageId: string; sessionId: string }
): Record<string, unknown> | null {
  const row = sql
    .exec(
      'SELECT session_id, role, content, tool_metadata, sequence, created_at, origin FROM chat_messages WHERE id = ?',
      input.messageId
    )
    .toArray()[0];
  if (!row) return null;
  if (row.session_id !== input.sessionId)
    throw new Error('Message upload ID belongs to another session');
  return row;
}

export function storeMessageUploadPart(sql: SqlStorage, env: Env, input: MessageUploadPart): void {
  if (committedMessage(sql, input)) return;
  const session = sql
    .exec('SELECT status FROM chat_sessions WHERE id = ?', input.sessionId)
    .toArray()[0];
  if (!session || session.status === 'stopped')
    throw new Error('Message upload session is unavailable');
  if (!Number.isSafeInteger(input.part) || input.part < 0 || input.part >= partLimit(env)) {
    throw new Error('Invalid message upload part index');
  }
  const bytes = new TextEncoder().encode(input.data).byteLength;
  if (bytes === 0 || bytes > uploadLimit(env)) throw new Error('Invalid message upload part size');
  const existing = sql
    .exec(
      'SELECT data, abandoned_at FROM message_upload_parts WHERE session_id = ? AND message_id = ? AND field = ? AND part = ?',
      input.sessionId,
      input.messageId,
      input.field,
      input.part
    )
    .toArray()[0];
  if (existing) {
    if (existing.abandoned_at !== null) {
      throw new Error('Message upload is abandoned in quarantine');
    }
    if (existing.data !== input.data) throw new Error('Conflicting message upload part');
    return;
  }
  const total = sql
    .exec(
      'SELECT SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM message_upload_parts WHERE session_id = ? AND message_id = ? AND abandoned_at IS NULL',
      input.sessionId,
      input.messageId
    )
    .toArray()[0];
  if (Number(total?.bytes ?? 0) + bytes > uploadLimit(env)) {
    throw new Error('Message upload exceeds logical size limit');
  }
  const sessionBytes = sql
    .exec(
      'SELECT SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM message_upload_parts WHERE session_id = ?',
      input.sessionId
    )
    .toArray()[0];
  if (Number(sessionBytes?.bytes ?? 0) + bytes > sessionLimit(env)) {
    throw new Error('Session upload staging exceeds size limit');
  }
  const stagedBytes = sql
    .exec('SELECT SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM message_upload_parts')
    .toArray()[0];
  if (Number(stagedBytes?.bytes ?? 0) + bytes > stagedLimit(env)) {
    throw new Error('Project upload quarantine exceeds size limit');
  }
  const stagedParts = sql.exec('SELECT COUNT(*) AS count FROM message_upload_parts').toArray()[0];
  if (Number(stagedParts?.count ?? 0) >= stagedPartLimit(env)) {
    throw new Error('Project upload quarantine exceeds part limit');
  }
  sql.exec(
    'INSERT INTO message_upload_parts (session_id, message_id, field, part, data) VALUES (?, ?, ?, ?, ?)',
    input.sessionId,
    input.messageId,
    input.field,
    input.part,
    input.data
  );
}

function readField(
  sql: SqlStorage,
  input: MessageUploadCommit,
  field: MessageUploadPart['field'],
  expected: number,
  maxParts: number
): string {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > maxParts) {
    throw new Error('Invalid message upload part count');
  }
  const parts = sql
    .exec(
      'SELECT part, data FROM message_upload_parts WHERE session_id = ? AND message_id = ? AND field = ? AND abandoned_at IS NULL ORDER BY part ASC',
      input.sessionId,
      input.messageId,
      field
    )
    .toArray();
  if (parts.length !== expected || parts.some((part, index) => part.part !== index)) {
    throw new Error('Message upload is incomplete');
  }
  return parts.map((part) => String(part.data)).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function assembleMessageUpload(
  sql: SqlStorage,
  env: Env,
  input: MessageUploadCommit
): Promise<{ content: string; toolMetadata: string | null } | null> {
  const committed = committedMessage(sql, input);
  if (committed) {
    if (
      committed.role !== input.role ||
      committed.sequence !== input.sequence ||
      committed.created_at !== Date.parse(input.timestamp) ||
      committed.origin !== input.origin ||
      (await sha256(String(committed.content))) !== input.contentSha256 ||
      (await sha256(committed.tool_metadata === null ? '' : String(committed.tool_metadata))) !==
        input.metadataSha256
    ) {
      throw new Error('Message upload conflicts with existing message');
    }
    return null;
  }
  if (input.contentParts < 1) throw new Error('Message upload has no content');
  const content = readField(sql, input, 'content', input.contentParts, partLimit(env));
  const metadata = readField(sql, input, 'toolMetadata', input.metadataParts, partLimit(env));
  if (new TextEncoder().encode(content + metadata).byteLength > uploadLimit(env)) {
    throw new Error('Message upload exceeds logical size limit');
  }
  if (
    (await sha256(content)) !== input.contentSha256 ||
    (await sha256(metadata)) !== input.metadataSha256
  ) {
    throw new Error('Message upload digest mismatch');
  }
  if (metadata) JSON.parse(metadata);
  return { content, toolMetadata: metadata || null };
}

export function clearMessageUpload(sql: SqlStorage, input: MessageUploadCommit): void {
  sql.exec(
    'DELETE FROM message_upload_parts WHERE session_id = ? AND message_id = ? AND abandoned_at IS NULL',
    input.sessionId,
    input.messageId
  );
}

/** Internal-only readback for interrupted uploads; never reports a partial message as persisted. */
export async function readMessageUploadQuarantine(
  sql: SqlStorage,
  sessionId: string,
  messageId: string
): Promise<{
  status: 'pending' | 'abandoned';
  createdAt: number;
  abandonedAt: number | null;
  fields: Array<{ field: string; part: number; data: string; sha256: string }>;
} | null> {
  const rows = sql
    .exec(
      'SELECT field, part, data, created_at, abandoned_at FROM message_upload_parts WHERE session_id = ? AND message_id = ? ORDER BY field, part',
      sessionId,
      messageId
    )
    .toArray();
  const first = rows[0];
  if (!first) return null;
  return {
    status: first.abandoned_at === null ? 'pending' : 'abandoned',
    createdAt: Number(first.created_at),
    abandonedAt: first.abandoned_at === null ? null : Number(first.abandoned_at),
    fields: await Promise.all(
      rows.map(async (row) => ({
        field: String(row.field),
        part: Number(row.part),
        data: String(row.data),
        sha256: await sha256(String(row.data)),
      }))
    ),
  };
}

export type MessageUploadInventoryCursor = {
  createdAt: number;
  sessionId: string;
  messageId: string;
};

/** Bounded operator inventory; every record is reachable by its total-order key. */
export function listMessageUploadQuarantine(
  sql: SqlStorage,
  env: Env,
  limit: number,
  after: MessageUploadInventoryCursor | null
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > resolveMessageUploadInventoryLimit(env)
  ) {
    throw new Error('Invalid message upload inventory limit');
  }
  const rows = sql
    .exec(
      `SELECT * FROM (
         SELECT session_id, message_id, MIN(created_at) AS created_at,
                MAX(abandoned_at) AS abandoned_at, COUNT(*) AS parts,
                SUM(LENGTH(CAST(data AS BLOB))) AS bytes
         FROM message_upload_parts GROUP BY session_id, message_id
       ) AS inventory
       WHERE (? = 0 OR (created_at, session_id, message_id) > (?, ?, ?))
       ORDER BY created_at ASC, session_id ASC, message_id ASC LIMIT ?`,
      after ? 1 : 0,
      after?.createdAt ?? 0,
      after?.sessionId ?? '',
      after?.messageId ?? '',
      limit + 1
    )
    .toArray();
  const uploads = rows.slice(0, limit).map((row) => ({
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    status: row.abandoned_at === null ? 'pending' : 'abandoned',
    createdAt: Number(row.created_at),
    abandonedAt: row.abandoned_at === null ? null : Number(row.abandoned_at),
    parts: Number(row.parts),
    bytes: Number(row.bytes),
  }));
  const last = uploads.at(-1);
  return {
    uploads,
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt, sessionId: last.sessionId, messageId: last.messageId }
        : null,
  };
}
