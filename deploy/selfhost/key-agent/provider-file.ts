/**
 * Baseline provider: the KEK is 32 random bytes in a root-only file on the box. It protects the
 * bucket and any copy of it (the KEK is never in the bucket, and backups leave it out), not the
 * box itself: root on the box can read the file.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { type KeyProvider, KeyProviderError, requireSetting } from './provider.ts';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function readKek(path: string): Buffer {
  let text: string;
  try {
    const stat = statSync(path);
    if ((stat.mode & 0o077) !== 0) {
      throw new KeyProviderError(
        'config',
        `${path} is readable by group or others; chmod 600 it`
      );
    }
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error instanceof KeyProviderError) throw error;
    throw new KeyProviderError('config', `cannot read the key file ${path}`);
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64') !== text) {
    throw new KeyProviderError('config', `${path} must hold 32 bytes, base64`);
  }
  return key;
}

/** A new KEK file's content (base64 of 32 random bytes). */
export function generateFileKek(): string {
  return randomBytes(32).toString('base64');
}

export function createFileProvider(env: Readonly<Record<string, string | undefined>>): KeyProvider {
  const path = requireSetting(env, 'SAM_KEY_FILE');
  const kek = readKek(path);
  // Fingerprint, not the key: a SHA-256 of a uniformly random 256-bit key reveals nothing usable.
  const keyRef = `sha256:${createHash('sha256').update('sam-file-kek\0').update(kek).digest('hex').slice(0, 32)}`;
  return {
    name: 'file',
    keyRef,
    bindsContext: true,
    async wrap(dataKey, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      cipher.setAAD(context);
      const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return new Uint8Array(Buffer.concat([Buffer.of(VERSION), iv, body, cipher.getAuthTag()]));
    },
    async unwrap(wrapped, context) {
      const blob = Buffer.from(wrapped);
      if (blob.length < 1 + IV_BYTES + TAG_BYTES + 1 || blob[0] !== VERSION) {
        throw new KeyProviderError('invalid', 'file: wrapped key has an unknown layout');
      }
      const iv = blob.subarray(1, 1 + IV_BYTES);
      const tag = blob.subarray(blob.length - TAG_BYTES);
      const body = blob.subarray(1 + IV_BYTES, blob.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', kek, iv);
        decipher.setAAD(context);
        decipher.setAuthTag(tag);
        return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
      } catch {
        throw new KeyProviderError('invalid', 'file: wrapped key does not verify under this key');
      }
    },
  };
}
