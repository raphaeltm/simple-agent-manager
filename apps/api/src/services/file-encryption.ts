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
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importKey(keyBase64: string, usages: string[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    true, // extractable — needed for DEK export
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
  return {
    'x-enc-wrapped-dek': metadata.wrappedDek,
    'x-enc-dek-iv': metadata.dekIv,
    'x-enc-data-iv': metadata.dataIv,
    'x-enc-algo': metadata.algo,
    'x-enc-key-version': metadata.keyVersion,
  };
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

  if (!wrappedDek || !dekIv || !dataIv || !algo || !keyVersion) {
    throw new Error('Missing encryption metadata in R2 object custom metadata');
  }

  return { wrappedDek, dekIv, dataIv, algo: algo as 'AES-256-GCM', keyVersion };
}
