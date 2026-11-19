/** The manual command enters the same populated-install recovery path as automatic rollback. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRollback } from './backup-lib.js';
import { rollbackSteps } from './upgrade-instructions.js';
import { type BoxContext, UPGRADE_PENDING_FILE } from './upgrade-lib.js';
import { runManualRollback } from './upgrade-rollback.js';

vi.mock('./backup-lib.js', async (original) => ({
  ...(await original<typeof import('./backup-lib.js')>()),
  runRollback: vi.fn(),
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
    expect(pending).toEqual({ from: FROM, backupDir: join(root, 'snapshot') });
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
