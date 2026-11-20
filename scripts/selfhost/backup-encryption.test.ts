import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decryptBackupTree, encryptBackupTree, readBackupKey } from './backup-encryption.js';

const cleanup: string[] = [];
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
});
function fixture() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.tmp/backup-encryption-'));
  cleanup.push(root);
  const source = join(root, 'source');
  const encrypted = join(root, 'encrypted');
  const restored = join(root, 'restored');
  const key = join(root, 'key');
  mkdirSync(source);
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  writeFileSync(join(source, 'secrets.env'), 'PRIVATE_KEY=operator-test-fixture');
  return { root, source, encrypted, restored, key };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator encrypted backup trees', () => {
  it('authenticates and preserves owner execution for restored tools while keeping all files private', () => {
    const f = fixture();
    writeFileSync(join(f.source, 'celld'), 'operator binary', { mode: 0o755 });
    writeFileSync(join(f.source, 'other-execute-only'), 'private content', { mode: 0o655 });
    encryptBackupTree(f.source, f.encrypted, f.key);
    expect(statSync(join(f.encrypted, 'celld')).mode & 0o777).toBe(0o600);
    decryptBackupTree(f.encrypted, f.restored, f.key);
    expect(statSync(join(f.restored, 'celld')).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.restored, 'secrets.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.restored, 'other-execute-only')).mode & 0o777).toBe(0o600);
  });

  it('round trips binary archives larger than the chunk size, empty files and directories without storing plaintext', () => {
    const f = fixture();
    const archive = randomBytes(8 * 1024 * 1024 + 7);
    mkdirSync(join(f.source, 'objects'));
    mkdirSync(join(f.source, 'empty-directory'));
    writeFileSync(join(f.source, 'objects', 'archive.bin'), archive);
    writeFileSync(join(f.source, 'empty'), '');
    encryptBackupTree(f.source, f.encrypted, f.key);
    expect(
      readFileSync(join(f.encrypted, 'secrets.env')).includes(Buffer.from('operator-test-fixture'))
    ).toBe(false);
    expect(readFileSync(join(f.encrypted, 'objects', 'archive.bin')).equals(archive)).toBe(false);
    decryptBackupTree(f.encrypted, f.restored, f.key);
    expect(readFileSync(join(f.restored, 'objects', 'archive.bin')).equals(archive)).toBe(true);
    expect(readFileSync(join(f.restored, 'secrets.env'), 'utf8')).toBe(
      'PRIVATE_KEY=operator-test-fixture'
    );
    expect(readFileSync(join(f.restored, 'empty'))).toHaveLength(0);
    expect(statSync(join(f.restored, 'empty-directory')).isDirectory()).toBe(true);
    expect(statSync(f.restored).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.restored, 'secrets.env')).mode & 0o777).toBe(0o600);
  });

  it.each([
    'header',
    'ciphertext',
    'tag',
    'truncated',
    'missing',
    'extra',
    'renamed',
    'wrong-key',
    'manifest',
  ])('refuses %s and removes all incomplete plaintext', (corruption) => {
    const f = fixture();
    encryptBackupTree(f.source, f.encrypted, f.key);
    const path = join(f.encrypted, 'secrets.env');
    const bytes = readFileSync(path);
    if (corruption === 'missing') rmSync(path);
    else if (corruption === 'extra') writeFileSync(join(f.encrypted, 'extra'), bytes);
    else if (corruption === 'renamed') {
      rmSync(path);
      writeFileSync(join(f.encrypted, 'renamed'), bytes);
    } else if (corruption === 'wrong-key') writeFileSync(f.key, randomBytes(32));
    else if (corruption === 'truncated') writeFileSync(path, bytes.subarray(0, bytes.length - 1));
    else if (corruption === 'manifest')
      writeFileSync(join(f.encrypted, '.sam-backup-manifest'), bytes);
    else {
      const offset =
        corruption === 'header' ? 9 : corruption === 'ciphertext' ? 20 : bytes.length - 1;
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      writeFileSync(path, bytes);
    }
    expect(() => decryptBackupTree(f.encrypted, f.restored, f.key)).toThrow(
      'authentication failed'
    );
    expect(existsSync(f.restored)).toBe(false);
  });

  it('rejects valid ciphertext substituted from another snapshot under the same key', () => {
    const f = fixture();
    const second = join(f.root, 'second');
    encryptBackupTree(f.source, f.encrypted, f.key);
    encryptBackupTree(f.source, second, f.key);
    writeFileSync(join(f.encrypted, 'secrets.env'), readFileSync(join(second, 'secrets.env')));
    expect(() => decryptBackupTree(f.encrypted, f.restored, f.key)).toThrow(
      'authentication failed'
    );
    expect(existsSync(f.restored)).toBe(false);
  });

  it('refuses symlink inputs and keys, insecure keys, invalid lengths and keys inside the tree', () => {
    const f = fixture();
    chmodSync(f.key, 0o644);
    expect(() => readBackupKey(f.key)).toThrow();
    chmodSync(f.key, 0o600);
    writeFileSync(f.key, randomBytes(31));
    expect(() => readBackupKey(f.key)).toThrow('exactly 32');
    writeFileSync(f.key, randomBytes(32));
    symlinkSync(f.key, join(f.root, 'linked-key'));
    expect(() => readBackupKey(join(f.root, 'linked-key'))).toThrow('symlinks');
    symlinkSync(f.key, join(f.source, 'link'));
    expect(() => encryptBackupTree(f.source, f.encrypted, f.key)).toThrow();
    expect(existsSync(f.encrypted)).toBe(false);
    rmSync(join(f.source, 'link'));
    writeFileSync(join(f.source, 'inside-key'), randomBytes(32), { mode: 0o600 });
    expect(() => encryptBackupTree(f.source, f.encrypted, join(f.source, 'inside-key'))).toThrow(
      'separately'
    );
  });

  it('refuses existing destinations, overlapping trees and CI before reading any key', () => {
    const f = fixture();
    mkdirSync(f.encrypted);
    expect(() => encryptBackupTree(f.source, f.encrypted, f.key)).toThrow('already exist');
    expect(() => encryptBackupTree(f.source, join(f.source, 'nested'), f.key)).toThrow('overlap');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    expect(() => readBackupKey('/does-not-exist')).toThrow('forbidden in CI');
    expect(() => encryptBackupTree(f.source, f.encrypted, f.key)).toThrow('forbidden in CI');
    expect(() => decryptBackupTree(f.source, f.restored, f.key)).toThrow('forbidden in CI');
  });
});
