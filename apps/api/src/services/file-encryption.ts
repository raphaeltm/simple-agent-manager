/**
 * File encryption service using envelope encryption (AES-256-GCM).
 *
 * Each file gets a fresh Data Encryption Key (DEK). The DEK encrypts the file
 * data, then the DEK itself is wrapped (encrypted) by the platform Key
 * Encryption Key (KEK = ENCRYPTION_KEY). This allows future key rotation of
 * the KEK without re-encrypting every file.
 *
 * Uses Web Crypto API (native to Cloudflare Workers).
 */

import type { FileEncryptionMetadata } from '@simple-agent-manager/shared';

import { log } from '../lib/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importKey(keyBase64: string, usages: string[], extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    extractable,
    usages
  ) as Promise<CryptoKey>;
}

async function importKek(keyBase64: string, usages: string[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    false,
    usages
  ) as Promise<CryptoKey>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_KEY_VERSION = '1';
const GCM_AUTH_TAG_BYTES = 16;
const MAX_GCM_CHUNK_INDEX = 0xffff_ffff;

export type EncryptableFileData = ArrayBuffer | Blob;
export interface StreamEncryptionResult {
  ciphertext: ReadableStream<Uint8Array>;
  completion: Promise<void>;
  metadata: FileEncryptionMetadata;
}

function byteLength(data: EncryptableFileData): number {
  return data instanceof ArrayBuffer ? data.byteLength : data.size;
}

function chunkIv(baseIv: Uint8Array, chunkIndex: number): Uint8Array {
  const iv = baseIv.slice();
  const view = new DataView(iv.buffer);
  view.setUint32(8, view.getUint32(8, false) ^ chunkIndex, false);
  return iv;
}

async function wrapDek(
  dek: CryptoKey,
  kekBase64: string
): Promise<{ wrappedDek: ArrayBuffer; dekIv: Uint8Array }> {
  const dekRaw = (await crypto.subtle.exportKey('raw', dek)) as ArrayBuffer;
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await importKek(kekBase64, ['encrypt']);
  const wrappedDek = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: dekIv },
    kek,
    dekRaw
  );
  return { wrappedDek, dekIv };
}

function fixedLengthCiphertext(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number
): { readable: ReadableStream<Uint8Array>; completion: Promise<void> } {
  if (typeof FixedLengthStream === 'undefined') {
    return { readable: source, completion: Promise.resolve() };
  }
  const fixed = new FixedLengthStream(expectedBytes);
  return { readable: fixed.readable, completion: source.pipeTo(fixed.writable) };
}

/**
 * Encrypt file data using envelope encryption.
 *
 * 1. Generate a random 256-bit DEK
 * 2. Encrypt file data with DEK (AES-256-GCM)
 * 3. Wrap (encrypt) the DEK with the platform KEK
 * 4. Return ciphertext + metadata needed for decryption
 *
 * @param keyVersion — KEK version identifier (configurable via LIBRARY_KEY_VERSION env var)
 */
export async function encryptFile(
  data: ArrayBuffer,
  kekBase64: string,
  keyVersion: string = DEFAULT_KEY_VERSION
): Promise<{ ciphertext: ArrayBuffer; metadata: FileEncryptionMetadata }> {
  // 1. Generate random DEK
  const dek = (await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can wrap it
    ['encrypt']
  )) as CryptoKey;

  // 2. Encrypt file data with DEK
  const dataIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: dataIv },
    dek,
    data
  );

  // 3. Export DEK raw bytes, then wrap with KEK
  const dekRaw = (await crypto.subtle.exportKey('raw', dek)) as ArrayBuffer;
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await importKek(kekBase64, ['encrypt']);
  const wrappedDek = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: dekIv },
    kek,
    dekRaw
  );

  return {
    ciphertext,
    metadata: {
      wrappedDek: bufferToBase64(wrappedDek),
      dekIv: bufferToBase64(dekIv.buffer),
      dataIv: bufferToBase64(dataIv.buffer),
      algo: 'AES-256-GCM',
      keyVersion,
    },
  };
}

/**
 * Encrypt file data as independently authenticated chunks and expose ciphertext as a stream.
 * Blob slices and ArrayBuffer views keep plaintext allocation bounded to one configured chunk.
 */
export async function encryptFileStream(
  data: EncryptableFileData,
  kekBase64: string,
  chunkSize: number,
  keyVersion: string = DEFAULT_KEY_VERSION
): Promise<StreamEncryptionResult> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('Encryption chunk size must be a positive safe integer');
  }

  const plaintextSize = byteLength(data);
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new Error('File size must be a non-negative safe integer');
  }
  const chunkCount = Math.max(1, Math.ceil(plaintextSize / chunkSize));
  if (chunkCount - 1 > MAX_GCM_CHUNK_INDEX) {
    throw new Error('File requires too many encryption chunks');
  }

  const dek = (await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  )) as CryptoKey;
  const baseIv = crypto.getRandomValues(new Uint8Array(12));
  const { wrappedDek, dekIv } = await wrapDek(dek, kekBase64);
  let chunkIndex = 0;

  const ciphertextSource = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunkIndex >= chunkCount) {
        controller.close();
        return;
      }

      try {
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, plaintextSize);
        const plaintext =
          data instanceof ArrayBuffer
            ? new Uint8Array(data, start, end - start)
            : await data.slice(start, end).arrayBuffer();
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: chunkIv(baseIv, chunkIndex) },
          dek,
          plaintext
        );
        controller.enqueue(new Uint8Array(encrypted));
        chunkIndex += 1;
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const ciphertextBytes = plaintextSize + chunkCount * GCM_AUTH_TAG_BYTES;
  if (!Number.isSafeInteger(ciphertextBytes)) {
    throw new Error('Encrypted file size exceeds the supported range');
  }
  const ciphertext = fixedLengthCiphertext(ciphertextSource, ciphertextBytes);

  return {
    ciphertext: ciphertext.readable,
    completion: ciphertext.completion,
    metadata: {
      wrappedDek: bufferToBase64(wrappedDek),
      dekIv: bufferToBase64(dekIv.buffer),
      dataIv: bufferToBase64(baseIv.buffer),
      algo: 'AES-256-GCM',
      keyVersion,
      format: 'chunked-v1',
      chunkSize,
      plaintextSize,
    },
  };
}

async function decryptChunkedFile(
  ciphertext: ArrayBuffer,
  metadata: FileEncryptionMetadata & { format: 'chunked-v1' },
  dek: CryptoKey
): Promise<ArrayBuffer> {
  const { chunkSize, plaintextSize } = metadata;
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    !Number.isSafeInteger(plaintextSize) ||
    plaintextSize < 0
  ) {
    throw new Error('Invalid chunked encryption metadata');
  }

  const chunkCount = Math.max(1, Math.ceil(plaintextSize / chunkSize));
  if (chunkCount - 1 > MAX_GCM_CHUNK_INDEX) {
    throw new Error('Encrypted file contains too many chunks');
  }
  const expectedCiphertextBytes = plaintextSize + chunkCount * GCM_AUTH_TAG_BYTES;
  if (ciphertext.byteLength !== expectedCiphertextBytes) {
    throw new Error('Chunked ciphertext length does not match encryption metadata');
  }

  const baseIv = new Uint8Array(base64ToBuffer(metadata.dataIv));
  const plaintext = new Uint8Array(plaintextSize);
  let ciphertextOffset = 0;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const plaintextOffset = chunkIndex * chunkSize;
    const plaintextChunkBytes = Math.min(chunkSize, plaintextSize - plaintextOffset);
    const ciphertextChunkBytes = plaintextChunkBytes + GCM_AUTH_TAG_BYTES;
    const encryptedChunk = ciphertext.slice(
      ciphertextOffset,
      ciphertextOffset + ciphertextChunkBytes
    );
    const decryptedChunk = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: chunkIv(baseIv, chunkIndex) },
      dek,
      encryptedChunk
    );
    if (decryptedChunk.byteLength !== plaintextChunkBytes) {
      throw new Error('Decrypted chunk length does not match encryption metadata');
    }
    plaintext.set(new Uint8Array(decryptedChunk), plaintextOffset);
    ciphertextOffset += ciphertextChunkBytes;
  }
  return plaintext.buffer;
}

/**
 * Decrypt file data using envelope encryption metadata.
 *
 * 1. Unwrap the DEK using the platform KEK
 * 2. Decrypt file data with the recovered DEK
 */
export async function decryptFile(
  ciphertext: ArrayBuffer,
  metadata: FileEncryptionMetadata,
  kekBase64: string
): Promise<ArrayBuffer> {
  try {
    // 1. Unwrap DEK
    const kek = await importKek(kekBase64, ['decrypt']);
    const dekRaw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(metadata.dekIv) },
      kek,
      base64ToBuffer(metadata.wrappedDek)
    );

    // 2. Import DEK and decrypt file data
    const dek = await importKey(bufferToBase64(dekRaw), ['decrypt']);
    if (metadata.format === 'chunked-v1') {
      return await decryptChunkedFile(ciphertext, metadata, dek);
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(metadata.dataIv) },
      dek,
      ciphertext
    );

    return plaintext;
  } catch (error) {
    log.error('file_decryption_failure', {
      error: error instanceof Error ? error.message : 'unknown error',
      keyVersion: metadata.keyVersion,
    });
    throw error;
  }
}

/**
 * Serialize encryption metadata to R2 custom metadata (string key-value pairs).
 */
export function metadataToR2CustomMetadata(
  metadata: FileEncryptionMetadata
): Record<string, string> {
  const customMetadata: Record<string, string> = {
    'x-enc-wrapped-dek': metadata.wrappedDek,
    'x-enc-dek-iv': metadata.dekIv,
    'x-enc-data-iv': metadata.dataIv,
    'x-enc-algo': metadata.algo,
    'x-enc-key-version': metadata.keyVersion,
  };
  if (metadata.format === 'chunked-v1') {
    customMetadata['x-enc-format'] = metadata.format;
    customMetadata['x-enc-chunk-size'] = String(metadata.chunkSize);
    customMetadata['x-enc-plaintext-size'] = String(metadata.plaintextSize);
  }
  return customMetadata;
}

/**
 * Deserialize R2 custom metadata back to encryption metadata.
 */
export function r2CustomMetadataToMetadata(
  custom: Record<string, string>
): FileEncryptionMetadata {
  const wrappedDek = custom['x-enc-wrapped-dek'];
  const dekIv = custom['x-enc-dek-iv'];
  const dataIv = custom['x-enc-data-iv'];
  const algo = custom['x-enc-algo'];
  const keyVersion = custom['x-enc-key-version'];
  const format = custom['x-enc-format'];

  if (!wrappedDek || !dekIv || !dataIv || !algo || !keyVersion) {
    throw new Error('Missing encryption metadata in R2 object custom metadata');
  }

  const base = { wrappedDek, dekIv, dataIv, algo: algo as 'AES-256-GCM', keyVersion };
  if (!format) return base;
  if (format !== 'chunked-v1') {
    throw new Error('Unsupported encryption format in R2 object custom metadata');
  }

  const chunkSize = Number(custom['x-enc-chunk-size']);
  const plaintextSize = Number(custom['x-enc-plaintext-size']);
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    !Number.isSafeInteger(plaintextSize) ||
    plaintextSize < 0
  ) {
    throw new Error('Invalid chunked encryption metadata in R2 object custom metadata');
  }
  return { ...base, format, chunkSize, plaintextSize };
}
