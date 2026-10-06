import { createHash } from 'node:crypto';

import { PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES, type ProjectDataArchiveChunk } from './contract';
import { sha256Hex } from './hashing';

export const COMPACT_ARCHIVE_FORMAT = 'r2-gzip-v1';
export const LEGACY_ARCHIVE_FORMAT = 'sqlite-v1';
// The canonical row byte budget excludes JSON field names, IDs and the chunk envelope.
export const COMPACT_ARCHIVE_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const ARCHIVE_IMMUTABLE_JSON_MAX_OBJECT_BYTES = PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES;
export const COMPACT_ARCHIVE_CHUNK_BYTES = 2 * 1024 * 1024;
export const COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS = 10_000;
export function compactArchiveTimeout(value?: string): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS;
}
export class CompactArchiveTimeoutError extends Error {
  constructor(readonly stage: string) {
    super(`Compact archive R2 deadline exceeded (${stage})`);
    this.name = 'CompactArchiveTimeoutError';
  }
}

export function isCompactArchiveTimeoutError(error: unknown): boolean {
  return (
    error instanceof CompactArchiveTimeoutError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'CompactArchiveTimeoutError')
  );
}

async function timed<T>(promise: Promise<T>, deadline: number, stage: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void promise.catch(() => undefined);
    throw new CompactArchiveTimeoutError(stage);
  }
  void promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CompactArchiveTimeoutError(stage)), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type PendingR2Operation = { stage: string; promise: Promise<unknown> };
const pendingR2Operations = new WeakMap<R2Bucket, Map<string, PendingR2Operation>>();

/**
 * Keep one provider operation in flight per bucket/key. A deadline may release
 * the request, but a retry in the same isolate waits for the original provider
 * promise to settle before issuing another GET/HEAD/PUT for that immutable key.
 * A Worker reset cancels the original request and clears this isolate state.
 */
async function timedR2<T>(
  r2: R2Bucket,
  key: string,
  deadline: number,
  stage: string,
  start: () => Promise<T>
): Promise<T> {
  let operations = pendingR2Operations.get(r2);
  if (!operations) {
    operations = new Map();
    pendingR2Operations.set(r2, operations);
  }
  const pending = operations.get(key);
  if (pending) {
    if (pending.stage === stage) {
      // GET results carry a single-use body stream. Wait for the provider call,
      // then fetch an independent body for the joining reader.
      if (stage === 'get') {
        await timed(pending.promise, deadline, stage);
        return timedR2(r2, key, deadline, stage, start);
      }
      return timed(pending.promise as Promise<T>, deadline, stage);
    }
    await timed(pending.promise, deadline, `${stage}_pending`);
    return timedR2(r2, key, deadline, stage, start);
  }
  const promise = start();
  operations.set(key, { stage, promise });
  void promise
    .finally(() => {
      if (operations?.get(key)?.promise === promise) operations.delete(key);
    })
    .catch(() => undefined);
  return timed(promise, deadline, stage);
}
export type CompactChunkRef = { key: string; bytes: number; bodyBytes: number; bodySha256: string };
export type CompactChunkIdentity = Pick<
  ProjectDataArchiveChunk,
  'projectId' | 'sessionId' | 'migrationId' | 'targetOwnerName' | 'targetGeneration' | 'ordinal'
>;

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  deadline: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await timed(reader.read(), deadline, 'stream_read');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Compact archive exceeds object byte limit');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * Decode a compact object without first collecting a second full compressed or
 * decompressed byte buffer. JSON.parse still needs one bounded UTF-8 string, but
 * compressed bytes are released as the decompressor consumes them and the body
 * hash is updated incrementally.
 */
async function readCompressedText(
  stream: ReadableStream<Uint8Array>,
  expectedCompressedBytes: number,
  expectedBodyBytes: number,
  expectedBodySha256: string,
  deadline: number
): Promise<string> {
  let compressedBytes = 0;
  const sourceReader = stream.getReader();
  let sourceReleased = false;
  const releaseSource = () => {
    if (sourceReleased) return;
    sourceReleased = true;
    sourceReader.releaseLock();
  };
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await sourceReader.read();
        if (done) {
          if (compressedBytes !== expectedCompressedBytes) {
            throw new Error('Compact archive compressed size mismatch');
          }
          controller.close();
          releaseSource();
          return;
        }
        compressedBytes += value.byteLength;
        if (compressedBytes > expectedCompressedBytes) {
          throw new Error('Compact archive compressed size mismatch');
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await sourceReader.cancel(error).catch(() => undefined);
        releaseSource();
      }
    },
    async cancel(reason) {
      await sourceReader.cancel(reason).catch(() => undefined);
      releaseSource();
    },
  });
  const reader = counted.pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const hash = createHash('sha256');
  const parts: string[] = [];
  let bodyBytes = 0;
  try {
    for (;;) {
      const { done, value } = await timed(reader.read(), deadline, 'decompress_read');
      if (done) break;
      bodyBytes += value.byteLength;
      if (bodyBytes > expectedBodyBytes) {
        throw new Error('Compact archive exceeds object byte limit');
      }
      hash.update(value);
      const decoded = decoder.decode(value, { stream: true });
      if (decoded) parts.push(decoded);
    }
    const final = decoder.decode();
    if (final) parts.push(final);
  } catch (error) {
    await sourceReader.cancel(error).catch(() => undefined);
    releaseSource();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (bodyBytes !== expectedBodyBytes || hash.digest('hex') !== expectedBodySha256) {
    throw new Error('Compact archive body hash mismatch');
  }
  return parts.join('');
}

function assertChunk(value: unknown): asserts value is ProjectDataArchiveChunk {
  if (!value || typeof value !== 'object') throw new Error('Invalid compact archive envelope');
  const v = value as Record<string, unknown>;
  for (const key of [
    'projectId',
    'sessionId',
    'migrationId',
    'sourceOwnerName',
    'targetOwnerName',
    'sha256',
  ]) {
    if (typeof v[key] !== 'string' || !v[key]) throw new Error('Invalid compact archive header');
  }
  for (const key of ['targetGeneration', 'ordinal', 'rowCount', 'byteCount']) {
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0)
      throw new Error('Invalid compact archive counter');
  }
  if (
    typeof v.hasMore !== 'boolean' ||
    (v.cursor !== null && typeof v.cursor !== 'string') ||
    !Array.isArray(v.rows) ||
    !Array.isArray(v.rowIds)
  )
    throw new Error('Invalid compact archive rows');
  for (const row of v.rows) assertRawRow(row);
}
function assertRawRow(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Invalid compact archive row');
  const row = value as Record<string, unknown>;
  for (const key of ['id', 'session_id', 'role', 'content']) {
    if (typeof row[key] !== 'string') throw new Error('Invalid compact archive row text');
  }
  if (
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.sequence) ||
    (row.tool_metadata !== null && typeof row.tool_metadata !== 'string') ||
    (row.origin !== null && typeof row.origin !== 'string')
  )
    throw new Error('Invalid compact archive row fields');
}
function responseBody(value: BodyInit): ReadableStream<Uint8Array> {
  const body = new Response(value).body;
  if (!body) throw new Error('Compact archive body unavailable');
  return body;
}

function assertIdentity(chunk: ProjectDataArchiveChunk, expected: CompactChunkIdentity): void {
  assertChunk(chunk);
  for (const field of [
    'projectId',
    'sessionId',
    'migrationId',
    'targetOwnerName',
    'targetGeneration',
    'ordinal',
  ] as const) {
    if (chunk[field] !== expected[field])
      throw new Error(`Compact archive identity mismatch: ${field}`);
  }
  if (
    chunk.tableName !== 'chat_messages' ||
    !Array.isArray(chunk.rows) ||
    !Array.isArray(chunk.rowIds) ||
    chunk.rows.length !== chunk.rowCount ||
    chunk.rowIds.length !== chunk.rowCount ||
    new Set(chunk.rowIds).size !== chunk.rowIds.length
  )
    throw new Error('Invalid compact archive inventory');
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
  if (
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 0 ||
    ref.bytes > COMPACT_ARCHIVE_MAX_OBJECT_BYTES ||
    !Number.isSafeInteger(ref.bodyBytes) ||
    ref.bodyBytes < 0 ||
    ref.bodyBytes > COMPACT_ARCHIVE_MAX_OBJECT_BYTES
  ) {
    throw new Error('Invalid compact archive object size');
  }
  const object = await timedR2(r2, ref.key, deadline, 'get', () => r2.get(ref.key));
  if (object?.size !== ref.bytes) throw new Error('Compact archive missing or size mismatch');
  const text = await readCompressedText(
    object.body,
    ref.bytes,
    ref.bodyBytes,
    ref.bodySha256,
    deadline
  );
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
  if (bodyBytes > COMPACT_ARCHIVE_MAX_OBJECT_BYTES)
    throw new Error('Compact archive exceeds object byte limit');
  const key = `${prefix}/${encodeURIComponent(chunk.projectId)}/${encodeURIComponent(chunk.sessionId)}/${encodeURIComponent(chunk.migrationId)}/raw/${chunk.ordinal}.json.gz`;
  const compressed = await readBounded(
    responseBody(text).pipeThrough(new CompressionStream('gzip')),
    COMPACT_ARCHIVE_MAX_OBJECT_BYTES,
    deadline
  );
  const ref = { key, bytes: compressed.byteLength, bodyBytes, bodySha256: await sha256Hex(text) };
  const existing = await timedR2(r2, key, deadline, 'head', () => r2.head(key));
  if (!existing) {
    // Immutable publication: concurrent retries may only win creation, never overwrite.
    await timedR2(r2, key, deadline, 'put', () =>
      r2.put(key, compressed, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: { archiveBodySha256: ref.bodySha256 },
      })
    );
  } else {
    // Compression implementations may emit different gzip headers for the same input.
    ref.bytes = existing.size;
    const storedBodySha256 = existing.customMetadata?.archiveBodySha256;
    if (storedBodySha256 && storedBodySha256 !== ref.bodySha256) {
      throw new Error('Compact archive immutable object conflicts with retry payload');
    }
    // Objects written before body hashes were added to HEAD metadata still need
    // one compatibility read on retry. New objects never repeat decompression.
    if (!storedBodySha256) {
      await readCompactChunk(r2, ref, chunk, Math.max(1, deadline - Date.now()));
    }
  }
  // The target commit immediately performs the authoritative GET/decompress/hash
  // verification before it records a durable receipt. Re-reading here doubled
  // every fresh copy without adding a durable boundary.
  return ref;
}

export async function writeImmutableJson(
  r2: R2Bucket,
  key: string,
  value: unknown,
  timeoutMs = COMPACT_ARCHIVE_DEFAULT_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > ARCHIVE_IMMUTABLE_JSON_MAX_OBJECT_BYTES) {
    throw new Error('ProjectData archive JSON exceeds object byte limit');
  }
  const bodySha256 = await sha256Hex(text);
  const verifyExisting = async (head: R2Object): Promise<void> => {
    if (head.size !== bytes.byteLength) {
      throw new Error(`ProjectData archive immutable R2 object conflict at ${key}`);
    }
    const storedSha256 = head.customMetadata?.archiveBodySha256;
    if (storedSha256) {
      if (storedSha256 !== bodySha256) {
        throw new Error(`ProjectData archive immutable R2 object conflict at ${key}`);
      }
      return;
    }
    const existing = await timedR2(r2, key, deadline, 'get', () => r2.get(key));
    if (!existing || existing.size !== bytes.byteLength) {
      throw new Error(`ProjectData archive immutable R2 object conflict at ${key}`);
    }
    const existingBytes = await readBounded(
      existing.body,
      ARCHIVE_IMMUTABLE_JSON_MAX_OBJECT_BYTES,
      deadline
    );
    if (
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(existingBytes) !== text
    ) {
      throw new Error(`ProjectData archive immutable R2 object conflict at ${key}`);
    }
  };

  const existing = await timedR2(r2, key, deadline, 'head', () => r2.head(key));
  if (existing) {
    await verifyExisting(existing);
    return;
  }
  const created = await timedR2(r2, key, deadline, 'put', () =>
    r2.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { archiveBodySha256: bodySha256 },
    })
  );
  if (!created) {
    const raced = await timedR2(r2, key, deadline, 'head', () => r2.head(key));
    if (!raced) throw new Error(`ProjectData archive immutable R2 object missing at ${key}`);
    await verifyExisting(raced);
  }
}
