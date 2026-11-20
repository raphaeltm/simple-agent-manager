import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensurePrivateDir,
  parseDotenv,
  readSecretsFile,
  replacePrivateFile,
  writePrivateFile,
} from './secret-files.js';

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
    expect(parsed).toEqual({
      A: 'plain value',
      B: 'b',
      C: 'lit\\n#not-a-comment',
      D: 'esc\naped "q"',
      E: '',
    });
  });

  it('accepts a multi-line PEM in double quotes', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----';
    expect(parseDotenv(`KEY="${pem}"\nNEXT=1`, 't')).toEqual({ KEY: pem, NEXT: '1' });
  });

  it('names the bad line without echoing its value', () => {
    expect(() => parseDotenv('OK=1\nnot a secret line', 'secrets.env')).toThrow(
      'secrets.env:2: expected NAME=value'
    );
    expect(() => parseDotenv('K="unterminated-secret', 's')).toThrow(
      /^s:1: unterminated double quote$/
    );
  });

  it('accepts the same NAME=value shapes as before the regex was replaced', () => {
    expect(
      parseDotenv(
        [
          'A = spaced',
          'export\tB=tab',
          'export   C =  c ',
          'export=keyword-as-name',
          'exportD=1',
          '_E1=x=y',
          'F="q" # comment',
          "G='lit' ignored",
        ].join('\n'),
        't'
      )
    ).toEqual({
      A: 'spaced',
      B: 'tab',
      C: 'c',
      export: 'keyword-as-name',
      exportD: '1',
      _E1: 'x=y',
      F: 'q',
      G: 'lit',
    });
  });

  it('rejects the same malformed lines as before the regex was replaced', () => {
    for (const bad of ['1A=x', 'A B=x', 'export 1A=x', '=x', 'A', 'A=x\ry']) {
      expect(() => parseDotenv(bad, 't'), JSON.stringify(bad)).toThrow('t:1: expected NAME=value');
    }
    expect(() => parseDotenv('A="x" trailing', 't')).toThrow(
      't:1: unexpected text after closing quote'
    );
    expect(() => parseDotenv("A='x", 't')).toThrow('t:1: unterminated single quote');
  });

  it('rejects a long adversarial line in linear time (regression: \\s*=\\s*(.*)$ was quadratic)', () => {
    // The previous single regex took ~1.5 s on this shape at 40k spaces; string parsing takes <1 ms.
    const line = `A=${' '.repeat(50_000)}y\ry`;
    const started = performance.now();
    expect(() => parseDotenv(line, 't')).toThrow('t:1: expected NAME=value');
    expect(performance.now() - started).toBeLessThan(200);
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

  it('tightens an existing world-readable file before writing a secret into it', () => {
    const path = join(tempDir(), 'platform-keys.json');
    writeFileSync(path, '{}', { mode: 0o644 });
    writePrivateFile(path, 'secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('secret');
  });

  it('tightens an existing state directory', () => {
    const dir = join(tempDir(), 'state');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
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

describe('replacePrivateFile', () => {
  it('creates a 0600 file and leaves no temp file behind', () => {
    const dir = tempDir();
    const path = join(dir, 'keys.json');
    replacePrivateFile(path, 'one\n', { backup: true });
    expect(readFileSync(path, 'utf8')).toBe('one\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Nothing to back up on the first write.
    expect(readdirSync(dir)).toEqual(['keys.json']);
  });

  it('keeps the previous content as a 0600 .bak when replacing', () => {
    const dir = tempDir();
    const path = join(dir, 'keys.json');
    writeFileSync(path, 'old\n', { mode: 0o600 });
    replacePrivateFile(path, 'new\n', { backup: true });
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('old\n');
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['keys.json', 'keys.json.bak']);
  });

  it('tightens a world-readable file it replaces', () => {
    const dir = tempDir();
    const path = join(dir, 'gateway.env');
    writeFileSync(path, 'old\n', { mode: 0o644 });
    replacePrivateFile(path, 'new\n');
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['gateway.env']);
  });

  it('leaves the original untouched and no temp file when the rename fails', () => {
    const dir = tempDir();
    // A non-empty directory where the file should go: rename(2) cannot replace it.
    const path = join(dir, 'keys.json');
    mkdirSync(path);
    writeFileSync(join(path, 'inside'), 'x');
    expect(() => replacePrivateFile(path, 'new\n')).toThrow();
    expect(readdirSync(dir)).toEqual(['keys.json']);
    expect(readFileSync(join(path, 'inside'), 'utf8')).toBe('x');
  });
});
