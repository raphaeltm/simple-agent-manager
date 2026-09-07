/**
 * Encryption behavioral tests for the deployment secrets feature.
 *
 * Verifies properties required for write-only secret storage:
 *   - Round-trip fidelity (encrypt → decrypt recovers original value)
 *   - Ciphertext diversity (different plaintexts produce different ciphertexts)
 *   - IV nonce uniqueness (same plaintext produces a distinct IV on every call)
 *
 * These properties are load-bearing for the deployment secrets write-only API:
 * PUT /api/projects/:projectId/environments/:envId/secrets/:name encrypts the
 * caller-supplied value with AES-256-GCM before storing it in D1.  IV uniqueness
 * prevents a chosen-plaintext attacker from detecting when the same secret value
 * is stored twice.
 */
import { describe, expect, it } from 'vitest';

import { encrypt, generateEncryptionKey } from '../../../src/services/encryption';

describe('deployment secrets — encryption behavioral properties', () => {
  describe('ciphertext diversity', () => {
    it('produces different ciphertexts for different plaintexts under the same key', async () => {
      const key = generateEncryptionKey();
      const { ciphertext: ct1 } = await encrypt('postgres://prod/db', key);
      const { ciphertext: ct2 } = await encrypt('postgres://staging/db', key);
      expect(ct1).not.toBe(ct2);
    });

    it('encodes non-empty ciphertext for any non-empty plaintext', async () => {
      const key = generateEncryptionKey();
      const { ciphertext } = await encrypt('my-secret-value', key);
      // AES-256-GCM ciphertext is base64-encoded and non-empty
      expect(ciphertext.length).toBeGreaterThan(0);
      // Should be valid base64 (no whitespace or invalid chars)
      expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe('IV nonce uniqueness', () => {
    it('generates a different IV on every encrypt call for the same plaintext', async () => {
      const key = generateEncryptionKey();
      const plaintext = 'reused-secret-value';
      const { iv: iv1 } = await encrypt(plaintext, key);
      const { iv: iv2 } = await encrypt(plaintext, key);
      expect(iv1).not.toBe(iv2);
    });

    it('generates different IVs across 10 consecutive calls', async () => {
      const key = generateEncryptionKey();
      const plaintext = 'repeated-secret';
      const ivs = await Promise.all(
        Array.from({ length: 10 }, () => encrypt(plaintext, key).then((r) => r.iv)),
      );
      const unique = new Set(ivs);
      // All 10 IVs should be distinct (probability of collision is negligible for 96-bit random IVs)
      expect(unique.size).toBe(10);
    });

    it('returns a 12-byte (96-bit) GCM IV encoded as base64', async () => {
      const key = generateEncryptionKey();
      const { iv } = await encrypt('test-secret', key);
      // Decode base64 and verify the byte length
      const decoded = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(12);
    });
  });

  describe('round-trip fidelity for secret values', () => {
    it('preserves a secret containing special characters', async () => {
      const key = generateEncryptionKey();
      // Connection strings often contain slashes, colons, @, and query params
      const plaintext = 'postgres://user:p@ssw0rd!@host:5432/mydb?sslmode=require&application_name=sam';
      const { ciphertext, iv } = await encrypt(plaintext, key);
      const { decrypt } = await import('../../../src/services/encryption');
      const result = await decrypt(ciphertext, iv, key);
      expect(result).toBe(plaintext);
    });

    it('preserves a secret that looks like a JSON object', async () => {
      const key = generateEncryptionKey();
      const plaintext = '{"api_key":"sk-ant-abc123","org_id":"org-456"}';
      const { ciphertext, iv } = await encrypt(plaintext, key);
      const { decrypt } = await import('../../../src/services/encryption');
      const result = await decrypt(ciphertext, iv, key);
      expect(result).toBe(plaintext);
    });
  });
});
