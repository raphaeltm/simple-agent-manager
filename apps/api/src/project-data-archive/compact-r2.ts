import { withTimeout } from '../durable-objects/project-data/tool-payload-archive-primitives';
import type { ProjectDataArchiveChunk } from './contract';
import { sha256Hex } from './hashing';

export const COMPACT_ARCHIVE_FORMAT = 'r2-gzip-v1';
export const LEGACY_ARCHIVE_FORMAT = 'sqlite-v1';
// The canonical row byte budget excludes JSON field names, IDs and the chunk envelope.
export const COMPACT_ARCHIVE_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const COMPACT_ARCHIVE_CHUNK_BYTES = 2 * 1024 * 1024;
export const COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS = 10_000;
export function compactArchiveTimeout(value?: string): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS;
}
function timed<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return withTimeout(promise, Math.max(1, deadline - Date.now()), 'Compact archive R2 deadline exceeded');
}
export type CompactChunkRef = { key: string; bytes: number; bodyBytes: number; bodySha256: string };
export type CompactChunkIdentity = Pick<ProjectDataArchiveChunk,
  'projectId' | 'sessionId' | 'migrationId' | 'targetOwnerName' | 'targetGeneration' | 'ordinal'>;

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, deadline: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await timed(reader.read(), deadline);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Compact archive exceeds object byte limit');
      parts.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function assertChunk(value: unknown): asserts value is ProjectDataArchiveChunk {
  if (!value || typeof value !== 'object') throw new Error('Invalid compact archive envelope');
  const v = value as Record<string, unknown>;
  for (const key of ['projectId', 'sessionId', 'migrationId', 'sourceOwnerName', 'targetOwnerName', 'sha256']) {
    if (typeof v[key] !== 'string' || !v[key]) throw new Error('Invalid compact archive header');
  }
  for (const key of ['targetGeneration', 'ordinal', 'rowCount', 'byteCount']) {
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0) throw new Error('Invalid compact archive counter');
  }
  if (typeof v.hasMore !== 'boolean' || v.cursor !== null && typeof v.cursor !== 'string' ||
    !Array.isArray(v.rows) || !Array.isArray(v.rowIds)) throw new Error('Invalid compact archive rows');
  for (const row of v.rows) {
    if (!row || typeof row !== 'object') throw new Error('Invalid compact archive row');
    for (const key of ['id', 'session_id', 'role', 'content']) {
      if (typeof row[key] !== 'string') throw new Error('Invalid compact archive row text');
    }
    if (!Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.sequence) ||
      row.tool_metadata !== null && typeof row.tool_metadata !== 'string' ||
      row.origin !== null && typeof row.origin !== 'string') throw new Error('Invalid compact archive row fields');
  }
}
function responseBody(value: BodyInit): ReadableStream<Uint8Array> {
  const body = new Response(value).body;
  if (!body) throw new Error('Compact archive body unavailable');
  return body;
}

function assertIdentity(chunk: ProjectDataArchiveChunk, expected: CompactChunkIdentity): void {
  assertChunk(chunk);
  for (const field of ['projectId', 'sessionId', 'migrationId', 'targetOwnerName', 'targetGeneration', 'ordinal'] as const) {
    if (chunk[field] !== expected[field]) throw new Error(`Compact archive identity mismatch: ${field}`);
  }
  if (chunk.tableName !== 'chat_messages' || !Array.isArray(chunk.rows) ||
      !Array.isArray(chunk.rowIds) || chunk.rows.length !== chunk.rowCount ||
      chunk.rowIds.length !== chunk.rowCount || new Set(chunk.rowIds).size !== chunk.rowIds.length) throw new Error('Invalid compact archive inventory');
  for (const [i, row] of chunk.rows.entries()) {
    if (row.session_id !== expected.sessionId || row.id !== chunk.rowIds[i]) {
      throw new Error('Compact archive row identity mismatch');
    }
  }
}

export async function readCompactChunk(
  r2: R2Bucket,
  ref: CompactChunkRef,
  expected: CompactChunkIdentity,
  timeoutMs = COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS
): Promise<ProjectDataArchiveChunk> {
  const deadline = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > COMPACT_ARCHIVE_MAX_OBJECT_BYTES ||
      !Number.isSafeInteger(ref.bodyBytes) || ref.bodyBytes < 0 || ref.bodyBytes > COMPACT_ARCHIVE_MAX_OBJECT_BYTES) {
    throw new Error('Invalid compact archive object size');
  }
  const object = await timed(r2.get(ref.key), deadline);
  if (!object || object.size !== ref.bytes) throw new Error('Compact archive missing or size mismatch');
  const compressed = await readBounded(object.body, ref.bytes, deadline);
  const body = await readBounded(
    responseBody(compressed).pipeThrough(new DecompressionStream('gzip')),
    ref.bodyBytes, deadline
  );
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
  if (body.byteLength !== ref.bodyBytes || await sha256Hex(text) !== ref.bodySha256) {
    throw new Error('Compact archive body hash mismatch');
  }
  const chunk: unknown = JSON.parse(text);
  assertChunk(chunk);
  assertIdentity(chunk, expected);
  return chunk;
}

export async function writeCompactChunk(
  r2: R2Bucket,
  prefix: string,
  chunk: ProjectDataArchiveChunk,
  timeoutMs = COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS
): Promise<CompactChunkRef> {
  const deadline = Date.now() + timeoutMs;
  assertIdentity(chunk, chunk);
  const text = JSON.stringify(chunk);
  const bodyBytes = new TextEncoder().encode(text).byteLength;
  if (bodyBytes > COMPACT_ARCHIVE_MAX_OBJECT_BYTES) throw new Error('Compact archive exceeds object byte limit');
  const key = `${prefix}/${encodeURIComponent(chunk.projectId)}/${encodeURIComponent(chunk.sessionId)}/${encodeURIComponent(chunk.migrationId)}/raw/${chunk.ordinal}.json.gz`;
  const compressed = await readBounded(
    responseBody(text).pipeThrough(new CompressionStream('gzip')),
    COMPACT_ARCHIVE_MAX_OBJECT_BYTES, deadline
  );
  const ref = { key, bytes: compressed.byteLength, bodyBytes, bodySha256: await sha256Hex(text) };
  const existing = await timed(r2.get(key), deadline);
  if (!existing) {
    // Immutable publication: concurrent retries may only win creation, never overwrite.
    await timed(r2.put(key, compressed, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/gzip' },
    }), deadline);
  } else {
    // Compression implementations may emit different gzip headers for the same input.
    ref.bytes = existing.size;
  }
  await readCompactChunk(r2, ref, chunk, Math.max(1, deadline - Date.now()));
  return ref;
}
