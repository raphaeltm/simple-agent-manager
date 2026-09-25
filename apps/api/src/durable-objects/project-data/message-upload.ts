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
      'SELECT data FROM message_upload_parts WHERE session_id = ? AND message_id = ? AND field = ? AND part = ? AND abandoned_at IS NULL',
      input.sessionId,
      input.messageId,
      input.field,
      input.part
    )
    .toArray()[0];
  if (existing) {
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
  const sessionBytes = sql.exec(
    'SELECT SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM message_upload_parts WHERE session_id = ?',
    input.sessionId
  ).toArray()[0];
  if (Number(sessionBytes?.bytes ?? 0) + bytes > sessionLimit(env)) {
    throw new Error('Session upload staging exceeds size limit');
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
