/** The manual command enters the same populated-install recovery path as automatic rollback. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginRollbackCacheStart,
  finishRollbackCache,
  refreshRollbackCacheReceipt,
  runRollback,
} from './backup-lib.js';
import { rollbackSteps } from './upgrade-instructions.js';
import { type BoxContext, UPGRADE_PENDING_FILE } from './upgrade-lib.js';
import { runManualRollback } from './upgrade-rollback.js';

vi.mock('./backup-lib.js', async (original) => ({
  ...(await original<typeof import('./backup-lib.js')>()),
  runRollback: vi.fn(),
  beginRollbackCacheStart: vi.fn(),
  refreshRollbackCacheReceipt: vi.fn(),
  finishRollbackCache: vi.fn(),
}));
vi.mock('./upgrade-preflight.js', async (original) => ({
  ...(await original<typeof import('./upgrade-preflight.js')>()),
  assertRollbackReady: vi.fn(),
}));

const FROM = 'a'.repeat(40);
const OPERATOR_REF = 'b'.repeat(40);
let root: string;
let ctx: BoxContext;
let steps: string[];
let stateEnvs: (string | undefined)[];
let dirty: boolean;

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'manual-rollback-'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/populated-data'), 'current installation data');
  steps = [];
  stateEnvs = [];
  dirty = false;
  vi.mocked(refreshRollbackCacheReceipt).mockReset();
  vi.mocked(beginRollbackCacheStart).mockReset();
  vi.mocked(finishRollbackCache).mockReset();
  ctx = {
    box: { COMPOSE_PROJECT_NAME: 'owned-manual' },
    envFile: join(root, 'box.env'),
    stateDir: join(root, 'state'),
    composeFiles: ['base.yml', 'overlay.yml'],
    secretsFile: join(root, 'custom secrets'),
    encryptionKeyFile: join(root, 'backup key'),
    log: vi.fn(),
    run: (command, args, env) => {
      if (args[0] === 'status') return { status: 0, stdout: dirty ? ' M tracked' : '', stderr: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: OPERATOR_REF, stderr: '' };
      steps.push(`${command} ${args.join(' ')}`);
      if (command === 'docker') stateEnvs.push(env?.SAM_SELFHOST_STATE_DIR);
      return { status: 0, stdout: args.includes('config') ? 'celld\ncaddy' : '', stderr: '' };
    },
  };
  vi.mocked(runRollback)
    .mockReset()
    .mockImplementation(() => {
      steps.push('OWNED_SNAPSHOT_RESTORE');
    });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const rollback = (checkHealth = async () => true) =>
  runManualRollback(ctx, {
    from: FROM,
    backupDir: join(root, 'snapshot'),
    rebuilds: ['caddy', 'inactive-mail'],
    checkHealth,
  });

describe('manual owned rollback', () => {
  it.each([
    'checkout',
    'dependencies',
    'services',
    'build',
    'intent',
    'up-status',
    'up-throw',
    'refresh',
    'health',
    'finish',
  ])(
    'retries a recovery interrupted at the %s boundary without skipping snapshot restoration',
    async (phase) => {
      const runner = ctx.run;
      let failed = false;
      ctx.run = (command, args, env) => {
        const matches =
          (phase === 'checkout' && command === 'git' && args[0] === 'checkout') ||
          (phase === 'dependencies' && command === 'pnpm' && args[0] === 'install') ||
          (phase === 'services' && args.includes('config')) ||
          (phase === 'build' && args.includes('build')) ||
          (phase.startsWith('up-') && args.includes('up'));
        if (matches && !failed) {
          failed = true;
          if (phase === 'up-throw') throw new Error('transport unavailable');
          return { status: 1, stdout: '', stderr: 'withheld' };
        }
        return runner(command, args, env);
      };
      if (phase === 'intent')
        vi.mocked(beginRollbackCacheStart).mockImplementationOnce(() => {
          throw new Error('cannot persist intent');
        });
      if (phase === 'refresh')
        vi.mocked(refreshRollbackCacheReceipt).mockImplementationOnce(() => {
          throw new Error('cannot inspect replacement');
        });
      if (phase === 'finish')
        vi.mocked(finishRollbackCache).mockImplementationOnce(() => {
          throw new Error('cannot clear progress');
        });
      const health = vi
        .fn()
        .mockResolvedValueOnce(phase !== 'health')
        .mockResolvedValue(true);
      await expect(rollback(health)).rejects.toThrow(/Manual rollback did not complete/);
      expect(existsSync(join(ctx.stateDir, UPGRADE_PENDING_FILE))).toBe(true);
      if (phase !== 'finish') expect(finishRollbackCache).not.toHaveBeenCalled();
      await rollback(health);
      expect(runRollback).toHaveBeenCalledTimes(2);
      expect(existsSync(join(ctx.stateDir, UPGRADE_PENDING_FILE))).toBe(false);
      expect(steps.filter((step) => step === 'OWNED_SNAPSHOT_RESTORE')).toHaveLength(2);
    }
  );

  it('retries after dependency failure with the removed cache receipt still retained', async () => {
    const receipt = join(ctx.stateDir, 'rollback-cache-pending.json');
    let removed = false;
    vi.mocked(runRollback).mockImplementation(() => {
      if (removed && !existsSync(receipt)) throw new Error('cache absent without proof');
      removed = true;
      writeFileSync(receipt, 'exact original cache proof');
    });
    vi.mocked(finishRollbackCache).mockImplementation(() => rmSync(receipt));
    const runner = ctx.run;
    let failInstall = true;
    ctx.run = (command, args, env) => {
      if (command === 'pnpm' && args[0] === 'install' && failInstall) {
        failInstall = false;
        return { status: 1, stdout: '', stderr: 'withheld' };
      }
      return runner(command, args, env);
    };
    await expect(rollback()).rejects.toThrow(/Manual rollback did not complete/);
    expect(existsSync(receipt)).toBe(true);
    expect(refreshRollbackCacheReceipt).not.toHaveBeenCalled();
    expect(finishRollbackCache).not.toHaveBeenCalled();
    await rollback();
    expect(runRollback).toHaveBeenCalledTimes(2);
    expect(finishRollbackCache).toHaveBeenCalledOnce();
    expect(existsSync(receipt)).toBe(false);
  });

  it('retains the new cache proof through a failed health check and finishes only after healthy retry', async () => {
    const receipt = join(ctx.stateDir, 'rollback-cache-pending.json');
    vi.mocked(refreshRollbackCacheReceipt).mockImplementation(() => {
      expect(steps.at(-1)).toMatch(/ up -d$/);
      writeFileSync(receipt, 'new container and cache creation proof');
    });
    vi.mocked(finishRollbackCache).mockImplementation(() => rmSync(receipt));
    await expect(rollback(async () => false)).rejects.toThrow(/Manual rollback did not complete/);
    expect(readFileSync(receipt, 'utf8')).toContain('new container');
    expect(finishRollbackCache).not.toHaveBeenCalled();
    await rollback(async () => {
      expect(existsSync(receipt)).toBe(true);
      return true;
    });
    expect(refreshRollbackCacheReceipt).toHaveBeenCalledTimes(2);
    expect(existsSync(receipt)).toBe(false);
  });

  it('refreshes ownership after partial Compose startup but never finishes its failed recovery', async () => {
    const runner = ctx.run;
    ctx.run = (command, args, env) => {
      const result = runner(command, args, env);
      return args.includes('up') ? { ...result, status: 1 } : result;
    };
    await expect(rollback()).rejects.toThrow(/Manual rollback did not complete/);
    expect(refreshRollbackCacheReceipt).toHaveBeenCalledWith(
      expect.anything(),
      join(root, 'snapshot')
    );
    expect(finishRollbackCache).not.toHaveBeenCalled();
  });

  it('does not declare a healthy rollback when the replacement cache identity cannot be proven', async () => {
    vi.mocked(refreshRollbackCacheReceipt).mockImplementation(() => {
      throw new Error('foreign cache');
    });
    const health = vi.fn(async () => true);
    await expect(rollback(health)).rejects.toThrow(/Manual rollback did not complete/);
    expect(health).not.toHaveBeenCalled();
    expect(finishRollbackCache).not.toHaveBeenCalled();
  });

  it('recovers a populated install before old code starts, builds only active images and verifies health', async () => {
    const health = vi.fn(async () => {
      steps.push('HEALTH');
      return true;
    });
    await rollback(health);
    expect(runRollback).toHaveBeenCalledWith(expect.anything(), join(root, 'snapshot'), FROM);
    expect(steps[0]).toBe('OWNED_SNAPSHOT_RESTORE');
    expect(steps[1]).toBe(`git checkout --detach ${FROM}`);
    expect(steps[2]).toBe('pnpm install --frozen-lockfile');
    expect(steps.filter((step) => step.includes(' build '))).toEqual([
      expect.stringContaining(' build caddy'),
    ]);
    expect(steps.some((step) => step.includes('inactive-mail'))).toBe(false);
    expect(steps.at(-2)).toMatch(/--project-name owned-manual .* -f overlay.yml .* up -d$/);
    expect(steps.at(-1)).toBe('HEALTH');
    expect(stateEnvs.every((value) => value === ctx.stateDir)).toBe(true);
    expect(existsSync(join(ctx.stateDir, UPGRADE_PENDING_FILE))).toBe(false);
    expect(health).toHaveBeenCalledOnce();
  });

  it('keeps pending recovery and stops this custom state install if restored health fails', async () => {
    await expect(rollback(async () => false)).rejects.toThrow(/Manual rollback did not complete/);
    const pending = JSON.parse(
      readFileSync(join(ctx.stateDir, UPGRADE_PENDING_FILE), 'utf8')
    ) as unknown;
    expect(pending).toEqual({ from: FROM, backupDir: join(root, 'snapshot'), phase: 'verifying' });
    expect(steps.at(-3)).toMatch(/ stop celld$/);
    expect(steps.slice(-2)).toEqual([
      `git checkout --detach ${OPERATOR_REF}`,
      'pnpm install --frozen-lockfile',
    ]);
    expect(stateEnvs.at(-1)).toBe(ctx.stateDir);
  });

  it('never starts old code when owned snapshot restoration refuses', async () => {
    vi.mocked(runRollback).mockImplementation(() => {
      throw new Error('private-value-never-print');
    });
    await expect(rollback()).rejects.toThrow(
      'Manual rollback did not complete; keep celld stopped and retry the same rollback command'
    );
    expect(steps).not.toContain(`git checkout --detach ${FROM}`);
    expect(steps.at(-3)).toMatch(/ stop celld$/);
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain('private-value');
  });

  it('refuses a dirty checkout before restoring any data', async () => {
    dirty = true;
    await expect(rollback()).rejects.toThrow(/clean tracked checkout/);
    expect(runRollback).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it.each([
    { from: 'main', rebuilds: [] },
    { from: FROM, rebuilds: ['--unsafe'] },
  ])('refuses ambiguous commit/service parameters before mutation', async (options) => {
    await expect(
      runManualRollback(ctx, {
        ...options,
        backupDir: join(root, 'snapshot'),
        checkHealth: async () => true,
      })
    ).rejects.toThrow(/original full commit SHA/);
    expect(runRollback).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it.each(['CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP'])(
    'refuses %s before touching a populated installation',
    async (name) => {
      vi.stubEnv(name, '');
      await expect(rollback()).rejects.toThrow(/forbidden in CI/);
      expect(runRollback).not.toHaveBeenCalled();
      expect(steps).toEqual([]);
    }
  );

  it('prints one executable in-place rollback command with exact commit, snapshot, box, state, key, secrets and affected images', () => {
    const [command] = rollbackSteps(ctx, FROM, join(root, "snap's hot"), ['caddy']);
    expect(command).toContain(`pnpm selfhost:upgrade --to ${FROM} --rollback-from`);
    expect(command).toContain(`--box-env ${ctx.envFile} --state-dir ${ctx.stateDir}`);
    expect(command).toContain(
      `--secrets '${ctx.secretsFile}' --encryption-key-file '${ctx.encryptionKeyFile}' --rebuild caddy`
    );
    expect(command).toContain("'\\''");
    expect(command).not.toMatch(/selfhost:restore|git checkout|docker compose/);
  });
});
