/**
 * selfhost:upgrade orchestration (upgrade-lib.ts) with git, pnpm, gcloud and docker answered by
 * a fake runner. Asserts the order of the steps, that the stack restarts only when compose
 * inputs change (files in deploy/selfhost/ or generated .state/ files), and that the printed
 * rollback matches whether the upgrade carried a D1 migration.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadBox, SELFHOST_DIR } from './backup-cli';
import { type BoxContext, composeFilesFor, type RunResult } from './backup-lib';
import { runUpgrade } from './upgrade-lib';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
let root: string;
let steps: string[];
let logs: string[];
let diff: string[];
let dirty: boolean;
let failDeploy: boolean;
let initRewritesState: boolean;
let initRewritesAgentEnv: boolean;

function run(command: string, args: string[]): RunResult {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const line = `${command} ${args.join(' ')}`;
  if (command === 'git') {
    if (args[0] === 'status') return ok(dirty ? ' M apps/api/src/index.ts' : '');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(FROM);
    if (args[0] === 'rev-parse') return ok(TO);
    if (args[0] === 'diff') return ok(diff.join('\n'));
    steps.push(line);
    return ok();
  }
  steps.push(line.replace(join(root, ''), '<root>/'));
  if (command === 'pnpm' && args.join(' ') === 'selfhost:deploy --init' && initRewritesState) {
    writeFileSync(join(root, 'state/gateway.env'), 'FRPS_PORT_RANGE=21000-21999\n');
  }
  if (command === 'pnpm' && args.join(' ') === 'selfhost:deploy --init' && initRewritesAgentEnv) {
    // A legacy box upgraded to sealed-by-default: --init chose a provider for the key agent.
    mkdirSync(join(root, 'state/key-agent'), { recursive: true });
    writeFileSync(join(root, 'state/key-agent/agent.env'), 'SAM_KEY_PROVIDER=file\n');
  }
  if (command === 'pnpm' && args.join(' ') === 'selfhost:deploy' && failDeploy) {
    return { status: 1, stdout: '', stderr: 'migration 0219 failed' };
  }
  return ok();
}

function ctx(): BoxContext {
  return {
    box: { CELLD_BUCKET: 'gs://fleet/celld', SAM_DOMAIN: 'box.example' },
    envFile: join(root, 'box.env'),
    stateDir: join(root, 'state'),
    composeFiles: ['compose.yml'],
    run,
    now: () => 0,
    log: (m) => logs.push(m),
  };
}

const upgrade = (health = true) =>
  runUpgrade(ctx(), {
    to: 'v2026.11.12',
    backupDir: join(root, 'bk'),
    checkHealth: async () => health,
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-upgrade-'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/gateway.env'), 'FRPS_PORT_RANGE=20000-29999\n');
  writeFileSync(join(root, 'box.env'), 'x=1\n', { mode: 0o600 });
  steps = [];
  logs = [];
  diff = ['apps/api/src/routes/projects.ts'];
  dirty = false;
  failDeploy = false;
  initRewritesState = false;
  initRewritesAgentEnv = false;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const compact = () =>
  steps.map((s) =>
    s.startsWith('gcloud')
      ? 'gcloud rsync'
      : s.startsWith('docker compose')
        ? s.replace(/ -f .* --env-file \S+/, '')
        : s
  );

describe('runUpgrade', () => {
  it('backs up, checks out, migrates and deploys, and leaves the stack running when compose inputs are unchanged', async () => {
    const result = await upgrade();
    expect(compact()).toEqual([
      'git fetch --tags origin',
      'gcloud rsync', // live pre-copy
      'docker compose stop celld',
      'gcloud rsync', // delta
      'docker compose start celld',
      `git checkout --detach ${TO}`,
      'pnpm install --frozen-lockfile',
      'pnpm selfhost:deploy --init',
      'pnpm selfhost:deploy',
    ]);
    expect(result.composeRestarted).toBe(false);
    expect(result.rollback).toEqual([
      `git checkout ${FROM}`,
      'pnpm install --frozen-lockfile',
      'pnpm selfhost:deploy',
    ]);
  });

  it('restarts the stack between --init and the deploy when a compose file changed', async () => {
    diff = ['deploy/selfhost/docker-compose.yml', 'deploy/selfhost/README.md'];
    const result = await upgrade();
    const order = compact();
    const up = order.indexOf('docker compose up -d --build');
    expect(up).toBeGreaterThan(order.indexOf('pnpm selfhost:deploy --init'));
    expect(up).toBeLessThan(order.indexOf('pnpm selfhost:deploy'));
    expect(result.composeRestarted).toBe(true);
  });

  it('restarts the stack when --init rewrote a generated state file (gateway.env)', async () => {
    initRewritesState = true;
    const result = await upgrade();
    expect(result.composeRestarted).toBe(true);
  });

  it('restarts the stack when --init rewrote the key agent env (key-agent/agent.env)', async () => {
    initRewritesAgentEnv = true;
    diff = ['apps/api/src/routes/projects.ts'];
    expect((await upgrade()).composeRestarted).toBe(true);
  });

  it('keeps a plaintext box on plaintext deploy vars and points to selfhost:secrets migrate', async () => {
    writeFileSync(join(root, 'state/platform-keys.json'), '{}');
    await upgrade();
    // Both deploy steps hold the box on its plaintext files: no unchecked switch to sealed.
    expect(compact()).toContain('pnpm selfhost:deploy --init --key-provider legacy-plaintext');
    expect(compact()).toContain('pnpm selfhost:deploy --key-provider legacy-plaintext');
    expect(logs.join('\n')).toContain('pnpm selfhost:secrets migrate');
  });

  it('upgrades a sealed box (a recorded key provider) on the sealed path, with no hint', async () => {
    mkdirSync(join(root, 'state/key-agent'), { recursive: true });
    writeFileSync(join(root, 'state/key-agent/choice.json'), '{}');
    await upgrade();
    expect(compact()).toContain('pnpm selfhost:deploy --init');
    expect(compact().filter((step) => step.includes('legacy-plaintext'))).toEqual([]);
    expect(logs.join('\n')).not.toContain('pnpm selfhost:secrets migrate');
  });

  it('does not restart for a README-only change under deploy/selfhost', async () => {
    diff = ['deploy/selfhost/README.md'];
    expect((await upgrade()).composeRestarted).toBe(false);
  });

  it('prints a restore-based rollback when the upgrade carries a D1 migration', async () => {
    diff = ['apps/api/src/db/migrations/0300_new.sql'];
    const result = await upgrade();
    expect(result.migrationsChanged).toBe(true);
    expect(result.rollback.join('\n')).toContain(
      `pnpm selfhost:restore --from ${join(root, 'bk')}`
    );
    expect(result.rollback.join('\n')).toContain('do NOT redeploy the old Worker');
  });

  it('stops at a failed deploy and prints the rollback', async () => {
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/migration 0219 failed/);
    expect(logs.join('\n')).toContain('to roll back:');
    expect(logs.join('\n')).toContain(`git checkout ${FROM}`);
  });

  it('fails when the API is unhealthy after the deploy', async () => {
    await expect(upgrade(false)).rejects.toThrow(/not healthy/);
  });

  it('refuses a checkout with uncommitted tracked changes before touching anything', async () => {
    dirty = true;
    await expect(upgrade()).rejects.toThrow(/uncommitted/);
    expect(steps).toEqual([]);
  });
});

// sam-box, 2026-11-12 (R4): .env had COMPOSE_FILE=docker-compose.yml:docker-compose.guided-login.yml
// (the README's way to turn on guided login). The upgrade's `docker compose -f docker-compose.yml
// up -d --build` replaced that list, recreated celld without the override's DOCKER_HOST, and every
// guided login then failed at once with sandbox_provision_failed ("no container engine").
describe('runUpgrade with the box .env COMPOSE_FILE', () => {
  const boxFromEnv = (lines: string[]): BoxContext => {
    const envFile = join(root, 'real.env');
    writeFileSync(envFile, [`CELLD_BUCKET=gs://fleet/celld`, ...lines, ''].join('\n'), {
      mode: 0o600,
    });
    // The real loader reads the .env; only the commands are answered by the fake runner.
    return { ...loadBox(envFile, join(root, 'state')), run, log: (m) => logs.push(m) };
  };
  const restartCommand = () =>
    steps.find((s) => s.startsWith('docker compose') && s.includes(' up '));

  it('restarts the stack with every file COMPOSE_FILE lists, in order', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:docker-compose.guided-login.yml']);
    await runUpgrade(ctx, { to: 'v1', backupDir: null, checkHealth: async () => true });
    expect(restartCommand()).toBe(
      `docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
        `-f ${join(SELFHOST_DIR, 'docker-compose.guided-login.yml')} ` +
        `--env-file <root>//real.env up -d --build`
    );
  });

  it('uses docker-compose.yml alone when COMPOSE_FILE is unset (control)', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv([]);
    await runUpgrade(ctx, { to: 'v1', backupDir: null, checkHealth: async () => true });
    expect(restartCommand()).toBe(
      `docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} --env-file <root>//real.env up -d --build`
    );
  });

  it('prints rollback compose steps that read .env in deploy/selfhost instead of naming one file', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const result = await runUpgrade(boxFromEnv([]), {
      to: 'v1',
      backupDir: null,
      checkHealth: async () => true,
    });
    const composeSteps = result.rollback.filter((step) => step.includes('docker compose'));
    expect(composeSteps).toEqual(['(cd deploy/selfhost && docker compose up -d --build)']);
  });
});

describe('composeFilesFor', () => {
  it('splits on COMPOSE_PATH_SEPARATOR and keeps absolute entries', () => {
    expect(
      composeFilesFor({ COMPOSE_FILE: 'a.yml; /abs/b.yml', COMPOSE_PATH_SEPARATOR: ';' }, '/box')
    ).toEqual(['/box/a.yml', '/abs/b.yml']);
  });

  it('falls back to docker-compose.yml for an empty list', () => {
    expect(composeFilesFor({ COMPOSE_FILE: ' : ' }, '/box')).toEqual(['/box/docker-compose.yml']);
  });
});
