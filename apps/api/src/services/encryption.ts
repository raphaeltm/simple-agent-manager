/**
 * AES-256-GCM encryption service for storing sensitive data like API tokens.
 * Uses Web Crypto API (native to Cloudflare Workers).
 */

import { log } from '../lib/logger';
import { previousEncryptionKeyFor } from './encryption-key-fallback';

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Build string in chunks to avoid stack overflow from spreading large arrays
  // into String.fromCharCode (which pushes every byte as a function argument).
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
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

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns the ciphertext and IV (both base64-encoded).
 */
export async function encrypt(
  plaintext: string,
  keyBase64: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  return {
    ciphertext: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  };
}

async function decryptWith(ciphertext: string, iv: string, keyBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    key,
    base64ToBuffer(ciphertext)
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Decrypt a ciphertext string using AES-256-GCM.
 * Returns the original plaintext.
 * Logs decryption failures for security monitoring.
 *
 * During a self-hosted key rotation a previous key may be registered for `keyBase64`
 * (encryption-key-fallback.ts); it is tried only after the given key fails.
 */
export async function decrypt(ciphertext: string, iv: string, keyBase64: string): Promise<string> {
  try {
    return await decryptWith(ciphertext, iv, keyBase64);
  } catch (error) {
    const previous = previousEncryptionKeyFor(keyBase64);
    if (previous) {
      try {
        return await decryptWith(ciphertext, iv, previous);
      } catch {
        // reported below with the original error
      }
    }
    // Log decryption failures for security monitoring
    // This could indicate key rotation issues, data corruption, or tampering
    log.error('decryption_failure', {
      error: error instanceof Error ? error.message : 'unknown error',
      // Don't log sensitive data like ciphertext or IV
    });
    throw error;
  }
}

/** Decrypt with exactly this key: no rotation fallback, no failure log (key-rotation checks). */
export async function decryptWithKeyOnly(
  ciphertext: string,
  iv: string,
  keyBase64: string
): Promise<string> {
  return await decryptWith(ciphertext, iv, keyBase64);
}

/**
 * Generate a new 256-bit encryption key (for setup scripts).
 * Returns the key as a base64-encoded string.
 */
export function generateEncryptionKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return bufferToBase64(key.buffer);
}
