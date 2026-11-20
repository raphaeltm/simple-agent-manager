/**
 * The file key's friction, kept small: one clear notice when the key is created, a command that
 * says where it is, and one that checks an operator's copy against it. Neither prints the key.
 *
 *   pnpm selfhost:secrets key-file                 where the key is, its fingerprint, mode
 *   pnpm selfhost:secrets verify-key-copy <path>   does this copy match the box's key?
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { KEY_AGENT_DIR } from './key-service.js';

export function keyFilePath(stateDir: string): string {
  return join(stateDir, KEY_AGENT_DIR, 'kek');
}

/** The lines printed once, when the deploy creates the file key (key-service.ts). */
export function keyFileNotice(path: string): string[] {
  return [
    '------------------------------------------------------------------------------------------',
    `KEY FILE CREATED: ${path}`,
    'Store a copy of this file OFF this box now (a password manager, or offline media).',
    'Backups leave it out on purpose. Without it, this install cannot be recovered from a backup',
    'alone: the platform keys (ENCRYPTION_KEY, which protects every stored credential, and the',
    'signing keys) and your secrets.env values are sealed with it.',
    'Check your copy at any time: pnpm selfhost:secrets verify-key-copy <path to the copy>',
    '------------------------------------------------------------------------------------------',
  ];
}

function keyBytes(path: string): Buffer {
  const text = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64') !== text) {
    throw new Error(`${path} is not a key file (32 bytes, base64)`);
  }
  return key;
}

/** Same fingerprint the file provider records as its keyRef (provider-file.ts). */
function fingerprint(key: Buffer): string {
  return `sha256:${createHash('sha256').update('sam-file-kek\0').update(key).digest('hex').slice(0, 32)}`;
}

export function describeKeyFile(stateDir: string): string[] {
  const path = keyFilePath(stateDir);
  if (!existsSync(path)) {
    return [
      `no key file at ${path} (this box does not use the file provider, or has not sealed yet)`,
    ];
  }
  const mode = (statSync(path).mode & 0o777).toString(8).padStart(3, '0');
  return [
    `key file:    ${path}`,
    `fingerprint: ${fingerprint(keyBytes(path))} (the keyRef in its bundles)`,
    `mode:        ${mode}${mode === '600' ? '' : ' (should be 600)'}`,
    'Not in backups. Keep a copy off this box; check it with: pnpm selfhost:secrets verify-key-copy <path>',
  ];
}

/** True when the copy holds the same key. Compares in constant time; prints nothing secret. */
export function verifyKeyCopy(
  stateDir: string,
  copyPath: string
): { ok: boolean; message: string } {
  const path = keyFilePath(stateDir);
  if (!existsSync(path)) return { ok: false, message: `no key file at ${path} to compare with` };
  let copy: Buffer;
  try {
    copy = keyBytes(copyPath);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const box = keyBytes(path);
  const ok = timingSafeEqual(copy, box);
  copy.fill(0);
  box.fill(0);
  return ok
    ? { ok, message: `${copyPath} matches the box's key file (${path})` }
    : { ok, message: `${copyPath} does NOT match the box's key file (${path})` };
}
