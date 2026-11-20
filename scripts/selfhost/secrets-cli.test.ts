/**
 * `pnpm selfhost:secrets` argument handling through the real entry point. Box round R11:
 * `pnpm selfhost:secrets --help` crashed with a Node stack trace (ERR_PARSE_ARGS_UNKNOWN_OPTION).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, runTsx, writeBox } from './deploy-harness.js';

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
      expect(result.out).not.toMatch(/rotate|--purge/);
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
});
