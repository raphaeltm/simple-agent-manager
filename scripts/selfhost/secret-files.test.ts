import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensurePlatformKeys, PLATFORM_KEY_NAMES } from './platform-keys.js';
import { assertPrivateFile, parseDotenv, readSecretsFile } from './secret-files.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sam-selfhost-'));
}

describe('parseDotenv', () => {
  it('parses plain, quoted, exported and commented lines', () => {
    const parsed = parseDotenv(
      [
        '# comment',
        'A=plain value # trailing comment',
        'export B=b',
        "C='lit\\n#not-a-comment'",
        'D="esc\\naped \\"q\\""',
        'E=',
      ].join('\n'),
      't'
    );
    expect(parsed).toEqual({ A: 'plain value', B: 'b', C: 'lit\\n#not-a-comment', D: 'esc\naped "q"', E: '' });
  });

  it('accepts a multi-line PEM in double quotes', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----';
    expect(parseDotenv(`KEY="${pem}"\nNEXT=1`, 't')).toEqual({ KEY: pem, NEXT: '1' });
  });

  it('names the bad line without echoing its value', () => {
    expect(() => parseDotenv('OK=1\nnot a secret line', 'secrets.env')).toThrow('secrets.env:2: expected NAME=value');
    expect(() => parseDotenv('K="unterminated-secret', 's')).toThrow(/^s:1: unterminated double quote$/);
  });
});

describe('root-only secret files', () => {
  it('refuses a group- or world-readable secrets file', () => {
    const path = join(tempDir(), 'secrets.env');
    writeFileSync(path, 'A=1\n', { mode: 0o644 });
    expect(() => readSecretsFile(path)).toThrow(/readable by group or others/);
    chmodSync(path, 0o600);
    expect(readSecretsFile(path)).toEqual({ A: '1' });
  });

  it('treats a missing secrets file as empty', () => {
    expect(readSecretsFile(join(tempDir(), 'absent.env'))).toEqual({});
  });

  it('rejects names that are not UPPER_SNAKE_CASE', () => {
    const path = join(tempDir(), 'secrets.env');
    writeFileSync(path, 'lower=1\n', { mode: 0o600 });
    expect(() => readSecretsFile(path)).toThrow(/not an UPPER_SNAKE_CASE name/);
  });
});

describe('ensurePlatformKeys', () => {
  it('generates every key once, root-only, and reuses them on the next run', () => {
    const path = join(tempDir(), 'platform-keys.json');
    const first = ensurePlatformKeys(path);
    expect(first.generated).toEqual([...PLATFORM_KEY_NAMES]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => assertPrivateFile(path)).not.toThrow();
    expect(Buffer.from(first.keys.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    expect(first.keys.SAM_INSTALLATION_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(first.keys.JWT_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');

    const before = readFileSync(path, 'utf8');
    const second = ensurePlatformKeys(path);
    expect(second.generated).toEqual([]);
    expect(second.keys).toEqual(first.keys);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('completes a file missing a whole group without touching existing keys', () => {
    const path = join(tempDir(), 'platform-keys.json');
    const { keys } = ensurePlatformKeys(path);
    const { PREVIEW_SIGNING_KEY: _dropped, ...rest } = keys;
    writeFileSync(path, JSON.stringify(rest), { mode: 0o600 });
    const result = ensurePlatformKeys(path);
    expect(result.generated).toEqual(['PREVIEW_SIGNING_KEY']);
    expect(result.keys.ENCRYPTION_KEY).toBe(keys.ENCRYPTION_KEY);
  });

  it('refuses to regenerate half of a key pair', () => {
    const path = join(tempDir(), 'platform-keys.json');
    const { keys } = ensurePlatformKeys(path);
    const { JWT_PUBLIC_KEY: _dropped, ...rest } = keys;
    writeFileSync(path, JSON.stringify(rest), { mode: 0o600 });
    expect(() => ensurePlatformKeys(path)).toThrow(/has JWT_PRIVATE_KEY but not JWT_PUBLIC_KEY/);
  });
});
