import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSecretsKeepPlatformKeys,
  DRY_RUN_KEY_PLACEHOLDER,
  ensurePlatformKeys,
  PLATFORM_KEY_NAMES,
  PLATFORM_KEYS_FILE,
  PRIOR_DEPLOY_EVIDENCE,
} from './platform-keys.js';
import { assertPrivateFile } from './secret-files.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sam-selfhost-keys-'));
}

/** Leaves `entry` (a PRIOR_DEPLOY_EVIDENCE path) in `dir` the way a deploy would. */
function plantEvidence(dir: string, entry: string): void {
  const path = join(dir, entry);
  if (entry.endsWith('bundles')) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'b1.json'), '{}');
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x\n', { mode: 0o600 });
}

function rewrite(dir: string, keys: Record<string, string>): void {
  writeFileSync(join(dir, PLATFORM_KEYS_FILE), JSON.stringify(keys), { mode: 0o600 });
}

describe('ensurePlatformKeys', () => {
  it('--init on a fresh dir generates every key once, root-only, and reuses them next time', () => {
    const dir = tempDir();
    const path = join(dir, PLATFORM_KEYS_FILE);
    const first = ensurePlatformKeys(dir, 'init');
    expect(first.generated).toEqual([...PLATFORM_KEY_NAMES]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => assertPrivateFile(path)).not.toThrow();
    expect(Buffer.from(first.keys.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    expect(first.keys.SAM_INSTALLATION_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(first.keys.JWT_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');
    // A first write has nothing to back up and leaves no temp file.
    expect(readdirSync(dir)).toEqual([PLATFORM_KEYS_FILE]);

    const before = readFileSync(path, 'utf8');
    for (const mode of ['init', 'deploy', 'dry-run'] as const) {
      const again = ensurePlatformKeys(dir, mode);
      expect(again.generated).toEqual([]);
      expect(again.keys).toEqual(first.keys);
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual([PLATFORM_KEYS_FILE]);
  });

  it('reuses an existing complete file untouched even beside prior-deploy evidence', () => {
    const dir = tempDir();
    const { keys } = ensurePlatformKeys(dir, 'init');
    for (const entry of PRIOR_DEPLOY_EVIDENCE) plantEvidence(dir, entry);
    const path = join(dir, PLATFORM_KEYS_FILE);
    const before = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const again = ensurePlatformKeys(dir, 'deploy');
    expect(again.generated).toEqual([]);
    expect(again.keys).toEqual(keys);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('refuses to create keys outside --init', () => {
    const dir = tempDir();
    expect(() => ensurePlatformKeys(dir, 'deploy')).toThrow(/run pnpm selfhost:deploy --init/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(PRIOR_DEPLOY_EVIDENCE.map((entry) => [entry]))(
    'refuses to generate keys when %s shows an earlier deploy',
    (entry) => {
      const dir = tempDir();
      plantEvidence(dir, entry);
      for (const mode of ['init', 'deploy', 'dry-run'] as const) {
        expect(() => ensurePlatformKeys(dir, mode)).toThrow(
          new RegExp(`${entry.replace(/[.]/g, '\\.')}.*restore ${PLATFORM_KEYS_FILE}`, 's')
        );
      }
      expect(existsSync(join(dir, PLATFORM_KEYS_FILE))).toBe(false);
    }
  );

  it('control: an empty sealed-bundles dir is not evidence', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'key-agent', 'bundles'), { recursive: true });
    expect(ensurePlatformKeys(dir, 'init').generated).toEqual([...PLATFORM_KEY_NAMES]);
  });

  it('a dry run on a fresh dir reports placeholders and writes nothing', () => {
    const dir = tempDir();
    const result = ensurePlatformKeys(dir, 'dry-run');
    expect(result.generated).toEqual([...PLATFORM_KEY_NAMES]);
    for (const name of PLATFORM_KEY_NAMES) expect(result.keys[name]).toBe(DRY_RUN_KEY_PLACEHOLDER);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('--init completes a file missing a whole group, keeping the previous file as .bak', () => {
    const dir = tempDir();
    const path = join(dir, PLATFORM_KEYS_FILE);
    const { keys } = ensurePlatformKeys(dir, 'init');
    for (const entry of PRIOR_DEPLOY_EVIDENCE) plantEvidence(dir, entry);
    const rest: Record<string, string> = { ...keys };
    delete rest.PREVIEW_SIGNING_KEY;
    rewrite(dir, rest);
    const previous = readFileSync(path, 'utf8');
    // A plain deploy does not generate it; a dry run reports it; --init (as upgrade runs) does.
    expect(() => ensurePlatformKeys(dir, 'deploy')).toThrow(
      /has no PREVIEW_SIGNING_KEY; run pnpm selfhost:deploy --init/
    );
    expect(readFileSync(path, 'utf8')).toBe(previous);
    expect(ensurePlatformKeys(dir, 'dry-run').generated).toEqual(['PREVIEW_SIGNING_KEY']);
    expect(readFileSync(path, 'utf8')).toBe(previous);
    const result = ensurePlatformKeys(dir, 'init');
    expect(result.generated).toEqual(['PREVIEW_SIGNING_KEY']);
    expect(result.keys.ENCRYPTION_KEY).toBe(keys.ENCRYPTION_KEY);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(previous);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it.each([['ENCRYPTION_KEY'], ['SAM_INSTALLATION_ID']])(
    'never regenerates a lost %s in an existing file, in any mode',
    (name) => {
      const dir = tempDir();
      const path = join(dir, PLATFORM_KEYS_FILE);
      const { keys } = ensurePlatformKeys(dir, 'init');
      for (const entry of PRIOR_DEPLOY_EVIDENCE) plantEvidence(dir, entry);
      const rest: Record<string, string> = { ...keys };
      delete rest[name];
      rewrite(dir, rest);
      const before = readFileSync(path, 'utf8');
      for (const mode of ['init', 'deploy', 'dry-run'] as const) {
        expect(() => ensurePlatformKeys(dir, mode)).toThrow(
          new RegExp(`has no ${name}\\..*Restore it from your backup`, 's')
        );
      }
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(`${path}.bak`)).toBe(false);
    }
  );

  it('refuses to regenerate half of a key pair', () => {
    const dir = tempDir();
    const { keys } = ensurePlatformKeys(dir, 'init');
    const rest: Record<string, string> = { ...keys };
    delete rest.JWT_PUBLIC_KEY;
    rewrite(dir, rest);
    expect(() => ensurePlatformKeys(dir, 'init')).toThrow(
      /has JWT_PRIVATE_KEY but not JWT_PUBLIC_KEY/
    );
  });

  it('refuses an existing key with an empty value instead of regenerating it', () => {
    const dir = tempDir();
    const path = join(dir, PLATFORM_KEYS_FILE);
    const { keys } = ensurePlatformKeys(dir, 'init');
    rewrite(dir, { ...keys, ENCRYPTION_KEY: '' });
    const before = readFileSync(path, 'utf8');
    expect(() => ensurePlatformKeys(dir, 'init')).toThrow(/ENCRYPTION_KEY is empty/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('assertSecretsKeepPlatformKeys', () => {
  const keys = Object.fromEntries(PLATFORM_KEY_NAMES.map((name) => [name, `${name}-value`])) as {
    [K in (typeof PLATFORM_KEY_NAMES)[number]]: string;
  };

  it.each([...PLATFORM_KEY_NAMES])('refuses secrets.env overriding %s', (name) => {
    expect(() =>
      assertSecretsKeepPlatformKeys({ [name]: 'operator-value' }, keys, 'secrets.env')
    ).toThrow(`secrets.env: ${name} differs from the generated value`);
  });

  it('accepts the generated value repeated, and unrelated secrets', () => {
    expect(() =>
      assertSecretsKeepPlatformKeys(
        { ENCRYPTION_KEY: keys.ENCRYPTION_KEY, GITHUB_CLIENT_SECRET: 'x' },
        keys,
        'secrets.env'
      )
    ).not.toThrow();
  });
});
