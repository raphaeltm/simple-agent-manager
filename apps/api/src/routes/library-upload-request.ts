import { getMultipartBoundary, MultipartParser } from '@remix-run/multipart-parser';

import type { Env } from '../env';
import { releaseArrayBuffer } from '../lib/release-array-buffer';
import { errors } from '../middleware/error';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import { getUploadMaxBytes } from '../services/file-library-config';

let uploadInProgress = false;
const TEXT_FIELDS = new Set(['filename', 'mimeType', 'description', 'tags', 'directory']);

interface MultipartUpload {
  data: ArrayBuffer;
  filename: string;
  mimeType: string;
  description?: string;
  tags?: string;
  directory?: string;
}

/** No queued body buffers: protect both write routes through encryption and R2 completion. */
export async function withLibraryUpload<T>(
  request: Request,
  env: Env,
  operation: (upload: MultipartUpload) => Promise<T>
): Promise<T> {
  if (uploadInProgress) {
    void request.body?.cancel().catch(() => {});
    throw errors.tooManyRequests('Another library upload is in progress. Please retry shortly.');
  }
  uploadInProgress = true;
  try {
    // Resolve together: one cached settings snapshot, not a query per limit or part.
    const settings = await resolveAdminSettingDetailsMany(env, [
      'library.multipartFileMaxBytes',
      'library.multipartOverheadMaxBytes',
      'library.multipartMaxParts',
      'library.multipartMaxHeaderBytes',
      'library.multipartReadTimeoutMs',
    ]);
    const [fileMax = 0, overhead = 0, maxParts = 0, maxHeaderBytes = 0, readTimeoutMs = 0] =
      settings.map((s) => Number(s.value));
    if (
      [fileMax, overhead, maxParts, maxHeaderBytes, readTimeoutMs].some(
        (value) => !Number.isSafeInteger(value) || value <= 0
      )
    ) {
      throw errors.internal('Library upload settings are unavailable');
    }
    const maxFileBytes = Math.min(getUploadMaxBytes(env), fileMax);
    const upload = await parseUpload(request, {
      maxFileBytes,
      maxBodyBytes: maxFileBytes + overhead,
      maxTextBytes: overhead,
      maxParts: maxParts,
      maxHeaderBytes: maxHeaderBytes,
      readTimeoutMs: readTimeoutMs,
    });
    try {
      return await operation(upload);
    } finally {
      releaseArrayBuffer(upload.data);
    }
  } catch (error) {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    throw error;
  } finally {
    uploadInProgress = false;
  }
}

interface MultipartLimits {
  maxFileBytes: number;
  maxBodyBytes: number;
  maxTextBytes: number;
  maxParts: number;
  maxHeaderBytes: number;
  readTimeoutMs: number;
}

/** Parse incrementally without Hono's full-body cache or native formData materialization. */
async function parseUpload(request: Request, limits: MultipartLimits): Promise<MultipartUpload> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw errors.badRequest('Invalid Content-Length');
  }
  if (declared !== null && Number(declared) > limits.maxBodyBytes) {
    void request.body?.cancel().catch(() => {});
    throw errors.badRequest(
      `Multipart request exceeds maximum size of ${limits.maxBodyBytes} bytes`
    );
  }
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'multipart/form-data'
  ) {
    throw errors.badRequest('Expected multipart/form-data');
  }
  let parser: MultipartParser;
  try {
    const boundary = getMultipartBoundary(request.headers.get('content-type') ?? '');
    if (!boundary || !request.body) throw new Error('Missing multipart body or boundary');
    parser = new MultipartParser(boundary, {
      maxFileSize: limits.maxFileBytes,
      maxHeaderSize: limits.maxHeaderBytes,
      maxParts: limits.maxParts,
      maxTotalSize: limits.maxBodyBytes,
    });
  } catch {
    void request.body?.cancel().catch(() => {});
    throw errors.badRequest('Failed to parse multipart form data');
  }
  if (!request.body) throw errors.badRequest('Missing multipart body');
  // Workers incoming bodies support BYOB: limit each ingress allocation as well as
  // parser allocations. Non-byte-stream adapters must supply equally bounded chunks.
  const parserChunkBytes = 64 * 1024;
  let reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  let read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  let ownsIngress = false;
  try {
    const byob = request.body.getReader({ mode: 'byob' });
    reader = byob;
    ownsIngress = true;
    read = () => byob.read(new Uint8Array(parserChunkBytes));
  } catch {
    const standard = request.body.getReader();
    reader = standard;
    read = () => standard.read();
  }
  const fields: Record<string, string> = Object.create(null);
  let file: { data: ArrayBuffer; filename: string; mimeType: string } | undefined;
  let received = 0;
  let metadataBytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    // Cancellation closes any outstanding read; no repeated Promise.race reactions accumulate.
    void reader.cancel().catch(() => {});
  }, limits.readTimeoutMs);
  // Fixed parser chunks bound retained content arrays independently of ingress chunk count.
  // This allocation granularity bounds parser bookkeeping to 802 buffers at the default wire cap.
  let pending = new Uint8Array(parserChunkBytes);
  const parserBuffers: ArrayBuffer[] = [pending.buffer];
  let pendingBytes = 0;
  const consume = (bytes: Uint8Array) => {
    for (const part of parser.write(bytes)) {
      if (part.name === 'file' && part.isFile) {
        if (file) throw errors.badRequest('Only one file is allowed');
        file = {
          data: part.arrayBuffer,
          filename: part.filename || 'unnamed',
          mimeType: part.mediaType || 'application/octet-stream',
        };
      } else {
        metadataBytes += part.size;
        if (metadataBytes > limits.maxTextBytes)
          throw errors.badRequest('Multipart metadata is too large');
        if (part.name && TEXT_FIELDS.has(part.name)) {
          if (!part.isText) throw errors.badRequest('Multipart metadata must be text');
          fields[part.name] = part.text;
        }
      }
      // Release parser chunks before crypto allocates ciphertext alongside plaintext.
      part.content.length = 0;
    }
  };
  try {
    for (;;) {
      const chunk = await read();
      try {
        if (timedOut) throw errors.badRequest('Multipart upload timed out');
        if (chunk.done) break;
        if (chunk.value.byteLength > parserChunkBytes) {
          throw errors.badRequest('Multipart input requires bounded byte-stream reads');
        }
        received += chunk.value.byteLength;
        if (received > limits.maxBodyBytes) {
          throw errors.badRequest(
            `Multipart request exceeds maximum size of ${limits.maxBodyBytes} bytes`
          );
        }
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const count = Math.min(pending.length - pendingBytes, chunk.value.byteLength - offset);
          pending.set(chunk.value.subarray(offset, offset + count), pendingBytes);
          pendingBytes += count;
          offset += count;
          if (pendingBytes === pending.length) {
            consume(pending);
            pending = new Uint8Array(parserChunkBytes);
            parserBuffers.push(pending.buffer);
            pendingBytes = 0;
          }
        }
      } finally {
        // A BYOB read transfers the provided allocation to us. Free it once copied;
        // tiny ingress reads must not accumulate stale backing storage until GC.
        if (ownsIngress && chunk.value) releaseArrayBuffer(chunk.value.buffer);
      }
    }
    if (pendingBytes > 0) consume(pending.subarray(0, pendingBytes));
    parser.finish();
    if (declared !== null && received !== Number(declared)) {
      throw errors.badRequest('Content-Length does not match multipart request size');
    }
    if (!file) throw errors.badRequest('Missing "file" field in multipart form data');
    return {
      ...file,
      filename: fields['filename'] || file.filename,
      mimeType: fields['mimeType'] || file.mimeType,
      description: fields['description'],
      tags: fields['tags'],
      directory: fields['directory'],
    };
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (file) releaseArrayBuffer(file.data);
    if (error instanceof Error && 'statusCode' in error) throw error;
    throw errors.badRequest('Invalid or oversized multipart form data');
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    // Deterministically release our parser buffers, rather than relying on GC to run
    // before unchanged Web Crypto allocates a file-sized ciphertext. No parser view
    // is used after finish/error; the returned plaintext is a separate ArrayBuffer.
    for (const buffer of parserBuffers) releaseArrayBuffer(buffer);
  }
}
