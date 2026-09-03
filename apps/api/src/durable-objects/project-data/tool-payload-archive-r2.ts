const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION = 2;
export const TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION = 3;

const TOOL_PAYLOAD_ARCHIVE_RETRIEVAL_OVERHEAD_BYTES = 64 * 1024;

export type PreparedToolPayloadArchive = {
  key: string;
  body: string;
  contentBytes: number;
  archiveVersion: number;
  strippedToolMetadata: string;
  strippedToolMetadataBytes: number;
  verification?: {
    archiveBodyBytes: number;
    archiveBodySha256: string;
    objectCount: number;
    rootObjectBytes: number;
    rootObjectSha256: string;
  };
};

export type ToolPayloadArchiveOperationBudget = {
  used: number;
  max: number;
};

type ArchivedToolPayloadManifest = {
  version: typeof TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION;
  projectId: string;
  sessionId: string;
  messageId: string;
  messageCreatedAt: number;
  messageSequence: number;
  archivedAt: number;
  contentBytes: number;
  toolMetadataBytes: number;
  chunks: string[];
};

type ArchivedVerifiedToolPayloadManifest = Omit<
  ArchivedToolPayloadManifest,
  'version' | 'chunks'
> & {
  version: typeof TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION;
  archiveBodyBytes: number;
  archiveBodySha256: string;
  chunks: Array<{
    key: string;
    bytes: number;
    sha256: string;
  }>;
};

type ArchiveObjectProof = {
  bytes: number;
  sha256: string;
};

function chunkUtf8String(value: string, chunkBytes: number): Uint8Array[] {
  const bytes = textEncoder.encode(value);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    chunks.push(bytes.slice(offset, offset + chunkBytes));
  }
  return chunks;
}

function buildChunkKey(key: string, index: number): string {
  return `${key}.chunk-${index}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  operation.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function remainingOperationTimeout(
  timeoutMs: number,
  deadlineMs: number,
  nowMs: () => number
): number {
  const remaining = deadlineMs - nowMs();
  if (remaining <= 0) throw new Error('R2 archive operation exceeded cleanup wall-time deadline');
  return Math.min(timeoutMs, remaining);
}

function reserveArchiveOperations(budget: ToolPayloadArchiveOperationBudget, count: number): void {
  if (budget.used + count > budget.max) {
    throw new Error(
      `R2 archive operation budget exceeded: ${budget.used + count} required, ${budget.max} allowed`
    );
  }
  budget.used += count;
}

function contentAddressedArchiveKey(key: string, archiveBodySha256: string): string {
  return key.endsWith('.json')
    ? `${key.slice(0, -'.json'.length)}.${archiveBodySha256}.json`
    : `${key}.${archiveBodySha256}`;
}

async function writeArchiveObjectWithTimeout(
  r2: R2Bucket,
  key: string,
  body: string | Uint8Array,
  timeoutMs: number,
  deadlineMs: number,
  nowMs: () => number,
  customMetadata: Record<string, string>
): Promise<void> {
  const operationTimeoutMs = remainingOperationTimeout(timeoutMs, deadlineMs, nowMs);
  const write = r2.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata,
  });
  // If the timeout wins, keep the original payload in SQLite and let the
  // immutable content-addressed key finish after a retry. Every writer for
  // this key writes byte-identical content, so a late completion cannot
  // invalidate a newer verification proof.
  write.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`R2 archive write exceeded ${operationTimeoutMs}ms timeout`));
        }, operationTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function readArchiveObjectBytesWithTimeout(
  r2: R2Bucket,
  key: string,
  timeoutMs: number,
  deadlineMs: number,
  nowMs: () => number
): Promise<Uint8Array> {
  const getTimeoutMs = remainingOperationTimeout(timeoutMs, deadlineMs, nowMs);
  const object = await withTimeout(
    r2.get(key),
    getTimeoutMs,
    `R2 archive verification read exceeded ${getTimeoutMs}ms timeout`
  );
  if (!object) throw new Error(`R2 archive verification read was missing for ${key}`);
  const bodyTimeoutMs = remainingOperationTimeout(timeoutMs, deadlineMs, nowMs);
  const buffer = await withTimeout(
    object.arrayBuffer(),
    bodyTimeoutMs,
    `R2 archive verification body read exceeded ${bodyTimeoutMs}ms timeout`
  );
  return new Uint8Array(buffer);
}

async function writeAndVerifyArchiveObject(
  r2: R2Bucket,
  key: string,
  body: string | Uint8Array,
  timeoutMs: number,
  deadlineMs: number,
  nowMs: () => number,
  customMetadata: Record<string, string>
): Promise<ArchiveObjectProof> {
  const expected = typeof body === 'string' ? textEncoder.encode(body) : body;
  const expectedSha256 = await sha256(expected);
  await writeArchiveObjectWithTimeout(r2, key, body, timeoutMs, deadlineMs, nowMs, {
    ...customMetadata,
    archiveBytes: String(expected.byteLength),
    archiveSha256: expectedSha256,
    archiveVerificationVersion: String(TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION),
  });
  const actual = await readArchiveObjectBytesWithTimeout(r2, key, timeoutMs, deadlineMs, nowMs);
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(
      `R2 archive verification byte mismatch for ${key}: expected ${expected.byteLength}, got ${actual.byteLength}`
    );
  }
  const actualSha256 = await sha256(actual);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`R2 archive verification SHA-256 mismatch for ${key}`);
  }
  return { bytes: actual.byteLength, sha256: actualSha256 };
}

export async function writeToolPayloadArchiveObject(
  r2: R2Bucket,
  prepared: PreparedToolPayloadArchive,
  timeoutMs: number,
  input: {
    projectId: string;
    sessionId: string;
    messageId: string;
    messageCreatedAt: number;
    messageSequence: number;
    archivedAt: number;
    contentBytes: number;
    toolMetadataBytes: number;
    chunkBytes: number;
    deadlineMs: number;
    nowMs: () => number;
    operationBudget: ToolPayloadArchiveOperationBudget;
  }
): Promise<PreparedToolPayloadArchive> {
  const archiveBody = textEncoder.encode(prepared.body);
  const bodyBytes = archiveBody.byteLength;
  const archiveBodySha256 = await sha256(archiveBody);
  const immutableKey = contentAddressedArchiveKey(prepared.key, archiveBodySha256);
  const baseMetadata = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    archivedAt: String(input.archivedAt),
    contentBytes: String(input.contentBytes),
  };
  if (bodyBytes <= input.chunkBytes) {
    reserveArchiveOperations(input.operationBudget, 3);
    const proof = await writeAndVerifyArchiveObject(
      r2,
      immutableKey,
      prepared.body,
      timeoutMs,
      input.deadlineMs,
      input.nowMs,
      baseMetadata
    );
    return {
      ...prepared,
      key: immutableKey,
      archiveVersion: TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION,
      verification: {
        archiveBodyBytes: proof.bytes,
        archiveBodySha256: proof.sha256,
        objectCount: 1,
        rootObjectBytes: proof.bytes,
        rootObjectSha256: proof.sha256,
      },
    };
  }

  const chunks = chunkUtf8String(prepared.body, input.chunkBytes);
  const chunkKeys = chunks.map((_chunk, index) => buildChunkKey(immutableKey, index));
  reserveArchiveOperations(input.operationBudget, (chunks.length + 1) * 3);
  const chunkProofs: ArchiveObjectProof[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const chunkKey = chunkKeys[index];
    if (!chunkKey) throw new Error('archive chunk key was not generated');
    chunkProofs.push(
      await writeAndVerifyArchiveObject(
        r2,
        chunkKey,
        chunk,
        timeoutMs,
        input.deadlineMs,
        input.nowMs,
        {
          ...baseMetadata,
          archiveChunkIndex: String(index),
          archiveChunkCount: String(chunks.length),
        }
      )
    );
  }

  const manifest: ArchivedVerifiedToolPayloadManifest = {
    version: TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION,
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    messageCreatedAt: input.messageCreatedAt,
    messageSequence: input.messageSequence,
    archivedAt: input.archivedAt,
    contentBytes: input.contentBytes,
    toolMetadataBytes: input.toolMetadataBytes,
    archiveBodyBytes: bodyBytes,
    archiveBodySha256,
    chunks: chunkKeys.map((key, index) => {
      const proof = chunkProofs[index];
      if (!proof) throw new Error('archive chunk proof was not generated');
      return { key, bytes: proof.bytes, sha256: proof.sha256 };
    }),
  };
  const manifestProof = await writeAndVerifyArchiveObject(
    r2,
    immutableKey,
    JSON.stringify(manifest),
    timeoutMs,
    input.deadlineMs,
    input.nowMs,
    {
      ...baseMetadata,
      archiveChunkCount: String(chunks.length),
      archiveBodySha256: manifest.archiveBodySha256,
    }
  );
  return {
    ...prepared,
    key: immutableKey,
    archiveVersion: TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION,
    verification: {
      archiveBodyBytes: manifest.archiveBodyBytes,
      archiveBodySha256: manifest.archiveBodySha256,
      objectCount: chunks.length + 1,
      rootObjectBytes: manifestProof.bytes,
      rootObjectSha256: manifestProof.sha256,
    },
  };
}

export async function parseToolPayloadArchiveObjectText(
  r2: R2Bucket,
  text: string,
  input: {
    toolMetadataBytes: number;
    maxMetadataBytes: number;
    expectedIdentity?: {
      projectId: string;
      sessionId: string;
      messageId: string;
      messageCreatedAt: number;
      messageSequence: number;
    };
  }
): Promise<unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION &&
    record.version !== TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION
  ) {
    return parsed;
  }

  const chunks = record.chunks;
  if (!Array.isArray(chunks)) {
    throw new Error('archived chunk manifest is malformed');
  }
  const verified = record.version === TOOL_PAYLOAD_VERIFIED_ARCHIVE_VERSION;
  if (verified && input.expectedIdentity) {
    const expected = input.expectedIdentity;
    if (
      record.projectId !== expected.projectId ||
      record.sessionId !== expected.sessionId ||
      record.messageId !== expected.messageId ||
      record.messageCreatedAt !== expected.messageCreatedAt ||
      record.messageSequence !== expected.messageSequence
    ) {
      throw new Error('archived verified manifest identity does not match archive row');
    }
  }
  const chunkProofs = verified
    ? chunks.map((chunk) => {
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
          throw new Error('archived verified chunk manifest is malformed');
        }
        const item = chunk as Record<string, unknown>;
        if (
          typeof item.key !== 'string' ||
          typeof item.bytes !== 'number' ||
          !Number.isSafeInteger(item.bytes) ||
          item.bytes < 0 ||
          typeof item.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.sha256)
        ) {
          throw new Error('archived verified chunk manifest is malformed');
        }
        return { key: item.key, bytes: item.bytes, sha256: item.sha256 };
      })
    : null;
  const chunkKeys = chunkProofs
    ? chunkProofs.map((chunk) => chunk.key)
    : chunks.map((chunk) => {
        if (typeof chunk !== 'string') throw new Error('archived chunk manifest is malformed');
        return chunk;
      });
  if (input.toolMetadataBytes > input.maxMetadataBytes) {
    throw new Error('archived tool payload exceeds configured retrieval byte limit');
  }

  const maxArchiveBodyBytes =
    input.toolMetadataBytes + TOOL_PAYLOAD_ARCHIVE_RETRIEVAL_OVERHEAD_BYTES;
  const bodyChunks: Uint8Array[] = [];
  let bodyBytes = 0;
  for (const [index, key] of chunkKeys.entries()) {
    const chunk = await r2.get(key);
    if (!chunk) throw new Error('archived R2 chunk is missing');
    const chunkBytes = new Uint8Array(await chunk.arrayBuffer());
    const proof = chunkProofs?.[index];
    if (proof) {
      if (chunkBytes.byteLength !== proof.bytes) {
        throw new Error('archived R2 chunk byte verification failed');
      }
      if ((await sha256(chunkBytes)) !== proof.sha256) {
        throw new Error('archived R2 chunk SHA-256 verification failed');
      }
    }
    bodyBytes += chunkBytes.byteLength;
    if (bodyBytes > maxArchiveBodyBytes) {
      throw new Error('archived chunk manifest exceeded configured retrieval bound');
    }
    bodyChunks.push(chunkBytes);
  }
  const body = new Uint8Array(bodyBytes);
  let offset = 0;
  for (const chunkBytes of bodyChunks) {
    body.set(chunkBytes, offset);
    offset += chunkBytes.byteLength;
  }
  if (verified) {
    if (
      typeof record.archiveBodyBytes !== 'number' ||
      !Number.isSafeInteger(record.archiveBodyBytes) ||
      record.archiveBodyBytes !== body.byteLength ||
      typeof record.archiveBodySha256 !== 'string' ||
      (await sha256(body)) !== record.archiveBodySha256
    ) {
      throw new Error('archived tool payload body verification failed');
    }
  }
  return JSON.parse(textDecoder.decode(body)) as unknown;
}
