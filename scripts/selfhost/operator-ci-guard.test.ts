/** Real CLI and public helper denial: nonexistent paths prove CI is refused before any read. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBox } from './backup-cli';
import { decryptBackupTree, encryptBackupTree, readBackupKey } from './backup-encryption';
import { type BoxContext, runBackup, runRestore, runRollback } from './backup-lib';

const ROOT = resolve(import.meta.dirname, '../..');
const ABSENT = resolve(ROOT, '.tmp/nonexistent-operator-guard-sentinel');
const SIGNALS = ['GITHUB_ACTIONS', 'CI', 'RUNNER_NAME', 'RUNNER_TEMP'] as const;
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe('operator commands never read secret files in CI', () => {
  it.each(SIGNALS)(
    'rejects even an empty %s at every public secret helper before reads or runner calls',
    (signal) => {
      vi.stubEnv(signal, '');
      const run = vi.fn(() => {
        throw new Error('runner must not be called');
      });
      const context: BoxContext = {
        box: {},
        envFile: ABSENT,
        stateDir: ABSENT,
        encryptionKeyFile: ABSENT,
        composeFiles: [],
        run,
        now: Date.now,
        log: vi.fn(),
      };
      for (const invoke of [
        () => loadBox(ABSENT),
        () => readBackupKey(ABSENT),
        () => encryptBackupTree(ABSENT, ABSENT, ABSENT),
        () => decryptBackupTree(ABSENT, ABSENT, ABSENT),
        () => runBackup(context, ABSENT),
        () => runRestore(context, ABSENT),
        () => runRollback(context, ABSENT),
      ])
        expect(invoke).toThrow('Operator secret commands are forbidden in CI');
      expect(run).not.toHaveBeenCalled();
    }
  );

  it.each(SIGNALS)(
    'rejects %s through real backup, restore and upgrade CLI entrypoints',
    (signal) => {
      for (const [script, args] of [
        ['backup.ts', ['--to', ABSENT]],
        ['restore.ts', ['--from', ABSENT]],
        ['upgrade.ts', ['--to', 'main']],
      ] as const) {
        const result = spawnSync(
          resolve(ROOT, 'node_modules/.bin/tsx'),
          [resolve(import.meta.dirname, script), ...args, '--box-env', ABSENT],
          {
            cwd: ROOT,
            env: { ...process.env, [signal]: 'false' },
            encoding: 'utf8',
          }
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Operator secret commands are forbidden in CI');
        expect(result.stderr).not.toMatch(/ENOENT|does not exist/);
        expect(result.stdout).toBe('');
      }
    },
    30_000
  );
});
