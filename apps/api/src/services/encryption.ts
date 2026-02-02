/**
 * AES-256-GCM encryption service for storing sensitive data like API tokens.
 * Uses Web Crypto API (native to Cloudflare Workers).
 */

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

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  return {
    ciphertext: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  };
}

/**
 * Decrypt a ciphertext string using AES-256-GCM.
 * Returns the original plaintext.
 * Logs decryption failures for security monitoring.
 */
export async function decrypt(
  ciphertext: string,
  iv: string,
  keyBase64: string
): Promise<string> {
  try {
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
  } catch (error) {
    // Log decryption failures for security monitoring
    // This could indicate key rotation issues, data corruption, or tampering
    console.error('Decryption failed:', {
      event: 'decryption_failure',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'unknown error',
      // Don't log sensitive data like ciphertext or IV
    });
    throw error;
  }
}

/**
 * Generate a new 256-bit encryption key (for setup scripts).
 * Returns the key as a base64-encoded string.
 */
export function generateEncryptionKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return bufferToBase64(key.buffer);
}
