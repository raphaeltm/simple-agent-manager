const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION = 2;

const TOOL_PAYLOAD_ARCHIVE_RETRIEVAL_OVERHEAD_BYTES = 64 * 1024;

export type PreparedToolPayloadArchive = {
  key: string;
  body: string;
  contentBytes: number;
  archiveVersion: number;
  strippedToolMetadata: string;
  strippedToolMetadataBytes: number;
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

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

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

async function writeArchiveObjectWithTimeout(
  r2: R2Bucket,
  key: string,
  body: string | Uint8Array,
  timeoutMs: number,
  customMetadata: Record<string, string>
): Promise<void> {
  const write = r2.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata,
  });
  // If the timeout wins, keep the original payload in SQLite and let the
  // deterministic key be overwritten by a later retry. Attach a catch so a
  // late rejection from the underlying put is not unhandled after the timeout.
  write.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`R2 archive write exceeded ${timeoutMs}ms timeout`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
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
  }
): Promise<PreparedToolPayloadArchive> {
  const bodyBytes = utf8Bytes(prepared.body);
  const baseMetadata = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    archivedAt: String(input.archivedAt),
    contentBytes: String(input.contentBytes),
  };
  if (bodyBytes <= input.chunkBytes) {
    await writeArchiveObjectWithTimeout(r2, prepared.key, prepared.body, timeoutMs, baseMetadata);
    return prepared;
  }

  const chunks = chunkUtf8String(prepared.body, input.chunkBytes);
  const chunkKeys = chunks.map((_chunk, index) => buildChunkKey(prepared.key, index));
  for (const [index, chunk] of chunks.entries()) {
    const chunkKey = chunkKeys[index];
    if (!chunkKey) throw new Error('archive chunk key was not generated');
    await writeArchiveObjectWithTimeout(r2, chunkKey, chunk, timeoutMs, {
      ...baseMetadata,
      archiveChunkIndex: String(index),
      archiveChunkCount: String(chunks.length),
    });
  }

  const manifest: ArchivedToolPayloadManifest = {
    version: TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION,
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    messageCreatedAt: input.messageCreatedAt,
    messageSequence: input.messageSequence,
    archivedAt: input.archivedAt,
    contentBytes: input.contentBytes,
    toolMetadataBytes: input.toolMetadataBytes,
    chunks: chunkKeys,
  };
  await writeArchiveObjectWithTimeout(r2, prepared.key, JSON.stringify(manifest), timeoutMs, {
    ...baseMetadata,
    archiveChunkCount: String(chunks.length),
  });
  return {
    ...prepared,
    archiveVersion: TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION,
  };
}

export async function parseToolPayloadArchiveObjectText(
  r2: R2Bucket,
  text: string,
  input: {
    toolMetadataBytes: number;
    maxMetadataBytes: number;
  }
): Promise<unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  if (record.version !== TOOL_PAYLOAD_CHUNKED_ARCHIVE_VERSION) return parsed;

  const chunks = record.chunks;
  if (!Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === 'string')) {
    throw new Error('archived chunk manifest is malformed');
  }
  if (input.toolMetadataBytes > input.maxMetadataBytes) {
    throw new Error('archived tool payload exceeds configured retrieval byte limit');
  }

  const maxArchiveBodyBytes =
    input.toolMetadataBytes + TOOL_PAYLOAD_ARCHIVE_RETRIEVAL_OVERHEAD_BYTES;
  const bodyChunks: Uint8Array[] = [];
  let bodyBytes = 0;
  for (const key of chunks) {
    const chunk = await r2.get(key as string);
    if (!chunk) throw new Error('archived R2 chunk is missing');
    const chunkBytes = new Uint8Array(await chunk.arrayBuffer());
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
  return JSON.parse(textDecoder.decode(body)) as unknown;
}
