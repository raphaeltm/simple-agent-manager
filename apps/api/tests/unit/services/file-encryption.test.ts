import { describe, expect, it } from 'vitest';

import {
  decryptFile,
  encryptFile,
  encryptFileStream,
  metadataToR2CustomMetadata,
  r2CustomMetadataToMetadata,
} from '../../../src/services/file-encryption';

// Generate a realistic 256-bit AES key as base64
function generateTestKey(): string {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return btoa(String.fromCharCode(...key));
}

describe('file-encryption', () => {
  describe('encryptFile / decryptFile round-trip', () => {
    it('encrypts and decrypts a small file correctly', async () => {
      const kek = generateTestKey();
      const plaintext = new TextEncoder().encode('Hello, world!');

      const { ciphertext, metadata } = await encryptFile(plaintext.buffer, kek);

      // Ciphertext should differ from plaintext
      expect(ciphertext.byteLength).toBeGreaterThan(0);
      const ctBytes = new Uint8Array(ciphertext);
      expect(ctBytes).not.toEqual(plaintext);

      // Metadata should be populated
      expect(metadata.algo).toBe('AES-256-GCM');
      expect(metadata.keyVersion).toBe('1');
      expect(metadata.wrappedDek).toBeTruthy();
      expect(metadata.dekIv).toBeTruthy();
      expect(metadata.dataIv).toBeTruthy();

      // Decrypt should recover original plaintext
      const decrypted = await decryptFile(ciphertext, metadata, kek);
      const decryptedText = new TextDecoder().decode(decrypted);
      expect(decryptedText).toBe('Hello, world!');
    });

    it('encrypts and decrypts a realistic-size file (1MB)', { timeout: 30_000 }, async () => {
      const kek = generateTestKey();
      // Generate 1MB of pseudo-random data (crypto.getRandomValues limited to 64KB)
      const originalData = new Uint8Array(1024 * 1024);
      for (let offset = 0; offset < originalData.length; offset += 65536) {
        const chunk = Math.min(65536, originalData.length - offset);
        crypto.getRandomValues(originalData.subarray(offset, offset + chunk));
      }

      const { ciphertext, metadata } = await encryptFile(originalData.buffer, kek);
      const decrypted = await decryptFile(ciphertext, metadata, kek);

      // Round-trip integrity: decrypted data must match original exactly
      expect(new Uint8Array(decrypted)).toEqual(originalData);
    });

    it('encrypts and decrypts an empty file', async () => {
      const kek = generateTestKey();
      const emptyData = new ArrayBuffer(0);

      const { ciphertext, metadata } = await encryptFile(emptyData, kek);
      const decrypted = await decryptFile(ciphertext, metadata, kek);

      expect(decrypted.byteLength).toBe(0);
    });

    it('uses different DEKs for each encryption call', async () => {
      const kek = generateTestKey();
      const data = new TextEncoder().encode('same data').buffer;

      const result1 = await encryptFile(data, kek);
      const result2 = await encryptFile(data, kek);

      // Wrapped DEKs should differ (different random DEK each time)
      expect(result1.metadata.wrappedDek).not.toBe(result2.metadata.wrappedDek);
      // Data IVs should differ
      expect(result1.metadata.dataIv).not.toBe(result2.metadata.dataIv);
    });

    it('fails to decrypt with wrong KEK', async () => {
      const kek1 = generateTestKey();
      const kek2 = generateTestKey();
      const data = new TextEncoder().encode('secret').buffer;

      const { ciphertext, metadata } = await encryptFile(data, kek1);

      await expect(decryptFile(ciphertext, metadata, kek2)).rejects.toThrow();
    });

    it('fails to decrypt with tampered ciphertext', async () => {
      const kek = generateTestKey();
      const data = new TextEncoder().encode('sensitive data').buffer;

      const { ciphertext, metadata } = await encryptFile(data, kek);

      // Tamper with the ciphertext
      const tampered = new Uint8Array(ciphertext);
      tampered[0] ^= 0xff;

      await expect(decryptFile(tampered.buffer, metadata, kek)).rejects.toThrow();
    });

    it('fails to decrypt with tampered metadata', async () => {
      const kek = generateTestKey();
      const data = new TextEncoder().encode('critical data').buffer;

      const { ciphertext, metadata } = await encryptFile(data, kek);

      // Tamper with DEK IV
      const tamperedMetadata = { ...metadata, dekIv: generateTestKey() };

      await expect(decryptFile(ciphertext, tamperedMetadata, kek)).rejects.toThrow();
    });
  });

  describe('chunked streaming encryption', () => {
    it('round-trips a file spanning multiple authenticated chunks', async () => {
      const kek = generateTestKey();
      const original = new TextEncoder().encode('chunked file content');
      const { ciphertext, completion, metadata } = await encryptFileStream(
        new Blob([original]),
        kek,
        5
      );
      const [encrypted] = await Promise.all([
        new Response(ciphertext).arrayBuffer(),
        completion,
      ]);

      expect(metadata).toMatchObject({
        format: 'chunked-v1',
        chunkSize: 5,
        plaintextSize: original.byteLength,
      });
      expect(encrypted.byteLength).toBe(original.byteLength + Math.ceil(original.length / 5) * 16);
      const decrypted = await decryptFile(encrypted, metadata, kek);
      expect(new Uint8Array(decrypted)).toEqual(original);
    });

    it('round-trips an empty streamed file as one authenticated chunk', async () => {
      const kek = generateTestKey();
      const { ciphertext, completion, metadata } = await encryptFileStream(new Blob(), kek, 1024);
      const [encrypted] = await Promise.all([
        new Response(ciphertext).arrayBuffer(),
        completion,
      ]);

      expect(encrypted.byteLength).toBe(16);
      await expect(decryptFile(encrypted, metadata, kek)).resolves.toHaveProperty(
        'byteLength',
        0
      );
    });

    it('rejects chunked ciphertext whose length contradicts metadata', async () => {
      const kek = generateTestKey();
      const { ciphertext, completion, metadata } = await encryptFileStream(
        new Blob(['content']),
        kek,
        4
      );
      const [encrypted] = await Promise.all([
        new Response(ciphertext).arrayBuffer(),
        completion,
      ]);

      await expect(decryptFile(encrypted.slice(0, -1), metadata, kek)).rejects.toThrow(
        'length does not match'
      );
    });
  });

  describe('metadata serialization', () => {
    it('round-trips metadata through R2 custom metadata format', async () => {
      const kek = generateTestKey();
      const data = new TextEncoder().encode('test').buffer;

      const { metadata } = await encryptFile(data, kek);

      // Serialize to R2 format
      const r2Meta = metadataToR2CustomMetadata(metadata);
      expect(r2Meta['x-enc-wrapped-dek']).toBe(metadata.wrappedDek);
      expect(r2Meta['x-enc-algo']).toBe('AES-256-GCM');

      // Deserialize back
      const recovered = r2CustomMetadataToMetadata(r2Meta);
      expect(recovered).toEqual(metadata);
    });

    it('throws on missing metadata fields', () => {
      expect(() => r2CustomMetadataToMetadata({})).toThrow('Missing encryption metadata');
      expect(() =>
        r2CustomMetadataToMetadata({ 'x-enc-wrapped-dek': 'abc' })
      ).toThrow('Missing encryption metadata');
    });

    it('round-trips chunked format metadata', async () => {
      const kek = generateTestKey();
      const { ciphertext, completion, metadata } = await encryptFileStream(
        new Blob(['content']),
        kek,
        4
      );
      await Promise.all([new Response(ciphertext).arrayBuffer(), completion]);

      expect(r2CustomMetadataToMetadata(metadataToR2CustomMetadata(metadata))).toEqual(metadata);
    });
  });
});
