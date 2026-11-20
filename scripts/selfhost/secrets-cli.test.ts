/**
 * `pnpm selfhost:secrets` argument handling through the real entry point. Box round R11:
 * `pnpm selfhost:secrets --help` crashed with a Node stack trace (ERR_PARSE_ARGS_UNKNOWN_OPTION).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, runTsx, writeBox } from './deploy-harness.js';
import { ensurePlatformKeys } from './platform-keys.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const SECRETS = resolve(import.meta.dirname, 'secrets.ts');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secrets-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pnpm selfhost:secrets', () => {
  it.each([['--help'], ['-h'], ['plaintext', '--help']])(
    '%s prints the usage and exits 0, without a box',
    async (...args) => {
      // No .env exists at this path: help must not need one.
      const result = await runTsx(SECRETS, [...args, '--box-env', join(dir, 'missing.env')]);
      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain('pnpm selfhost:secrets <command>');
      expect(result.out).toContain('plaintext [--backups');
      expect(result.out).toContain('rotate --all | <key>');
      expect(result.out).not.toMatch(/--purge/);
      expect(result.out).not.toMatch(/\n\s+at /);
    }
  );

  it('an unknown option is a one-line error and the usage, not a stack trace', async () => {
    const result = await runTsx(SECRETS, ['status', '--bogus', '--box-env', writeBox(dir)]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("[selfhost] Unknown option '--bogus'");
    expect(result.out).toContain('pnpm selfhost:secrets <command>');
    expect(result.out).not.toMatch(/\n\s+at /);
  });

  // F10: no purge. `--purge` is not an option, so it cannot delete anything under deploy/.
  it('refuses plaintext --purge as an unknown option, before touching the box', async () => {
    const result = await runTsx(SECRETS, [
      'plaintext',
      '--purge',
      '--confirm',
      's3://fleet/celld',
      '--box-env',
      writeBox(dir),
    ]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("[selfhost] Unknown option '--purge'");
  });

  it('control: a known command still runs', async () => {
    const result = await runTsx(SECRETS, ['status', '--box-env', writeBox(dir)]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('key provider: none chosen yet');
  });

  // Box round on #2933: a plaintext box is sealed only by migrate, so status must say so.
  it('status on a box running on plaintext deploy vars points at migrate, not --init', async () => {
    const envFile = writeBox(dir);
    const state = join(dir, '.state');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    ensurePlatformKeys(state, 'init');
    const result = await runTsx(SECRETS, ['status', '--box-env', envFile]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain(
      'runs on plaintext deploy vars. Run `pnpm selfhost:secrets migrate`'
    );
    expect(result.out).not.toContain('selfhost:deploy --init` to choose one and seal');
  });
});
