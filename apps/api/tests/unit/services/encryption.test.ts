import { describe, expect, it } from 'vitest';

import { decrypt, encrypt, generateEncryptionKey } from '../../../src/services/encryption';

describe('encryption service', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('encrypts and decrypts a short string', async () => {
      const key = generateEncryptionKey();
      const plaintext = 'hello world';
      const { ciphertext, iv } = await encrypt(plaintext, key);
      const result = await decrypt(ciphertext, iv, key);
      expect(result).toBe(plaintext);
    });

    it('handles empty plaintext', async () => {
      const key = generateEncryptionKey();
      const { ciphertext, iv } = await encrypt('', key);
      const result = await decrypt(ciphertext, iv, key);
      expect(result).toBe('');
    });
  });

  describe('bufferToBase64 stack overflow prevention', () => {
    it('handles large buffers (200KB) without stack overflow', async () => {
      const key = generateEncryptionKey();
      // 200KB plaintext — would overflow the stack with spread-based String.fromCharCode
      const largePlaintext = 'A'.repeat(200_000);
      const { ciphertext, iv } = await encrypt(largePlaintext, key);
      const result = await decrypt(ciphertext, iv, key);
      expect(result).toBe(largePlaintext);
    });

    it('handles 1MB buffers without stack overflow', async () => {
      const key = generateEncryptionKey();
      const largePlaintext = 'B'.repeat(1_000_000);
      const { ciphertext, iv } = await encrypt(largePlaintext, key);
      const result = await decrypt(ciphertext, iv, key);
      expect(result).toBe(largePlaintext);
    });
  });

  describe('generateEncryptionKey', () => {
    it('returns a base64 string', () => {
      const key = generateEncryptionKey();
      // Should be valid base64 that decodes to 32 bytes (256 bits)
      const decoded = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(32);
    });

    it('generates unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });
  });
});
