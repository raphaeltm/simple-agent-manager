/** Drive the production upgrade trigger with a deployed-state store and command runner. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BoxContext, runBackup, type RunResult, runRollback } from './backup-lib';
import { runUpgrade } from './upgrade-lib';

vi.mock('./backup-lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backup-lib')>()),
  runBackup: vi.fn(),
  runRollback: vi.fn(),
}));

vi.mock('./upgrade-preflight.js', () => ({ assertRollbackReady: vi.fn() }));

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const HISTORY = [
  { tag: 'v1', new_sqlite_classes: ['ProjectData'] },
  { tag: 'selfhost-hosted-git-v1', new_sqlite_classes: ['HostedGitRepo'] },
];
let root: string;
let steps: string[];
let logs: string[];
let diff: string[];
let dirty: boolean;
let target: typeof HISTORY;
let current: string;
let failCommand: string | undefined;
let generatedChange: boolean;
let cacheProject: string;
let invalidCacheMount: boolean;

function run(command: string, args: string[]): RunResult {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const commandArgs =
    command === 'pnpm' && args[0] === 'selfhost:deploy'
      ? args.slice(0, args.indexOf('--env-file'))
      : args;
  const line = `${command} ${commandArgs.join(' ')}`;
  steps.push(line);
  if (command === 'git') {
    if (args[0] === 'status') return ok(dirty ? ' M file' : '');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(FROM);
    if (args[0] === 'rev-parse') return ok(TO);
    if (args[0] === 'show') return ok('services:\n  celld:\n    image: celld:fixed\n');
    if (args[0] === 'diff') return ok(diff.join('\n'));
    if (args[0] === 'checkout') current = args[2] ?? FROM;
  }
  if (command === 'docker' && args.includes('ps')) {
    cacheProject = args[args.indexOf('--project-name') + 1] ?? '';
    return ok('c'.repeat(64));
  }
  if (command === 'docker' && args[0] === 'inspect') {
    return ok(
      JSON.stringify([
        {
          Type: invalidCacheMount ? 'bind' : 'volume',
          Name: `${cacheProject}_celld-data`,
          Destination: '/var/lib/celld',
        },
      ])
    );
  }
  if (command === 'docker' && args[0] === 'volume' && args[1] === 'inspect') {
    return ok(
      JSON.stringify([
        {
          Name: `${cacheProject}_celld-data`,
          CreatedAt: '2026-11-19T00:00:00Z',
          Labels: {
            'com.docker.compose.project': cacheProject,
            'com.docker.compose.volume': 'celld-data',
          },
        },
      ])
    );
  }
  if (command === 'gcloud') {
    return ok(
      JSON.stringify(
        args.at(-1)?.endsWith('current.json')
          ? { script_name: 'sam', version: 'abc', prefix: 'deploy/sam/abc' }
          : {
              script_name: 'sam',
              version: 'abc',
              sqlite_classes: ['ProjectData', 'HostedGitRepo', '__D1Database'],
            }
      )
    );
  }
  if (command === 'pnpm' && args[0] === 'exec')
    return ok(JSON.stringify(current === TO ? target : HISTORY));
  if (line === 'pnpm selfhost:deploy --init' && generatedChange) {
    writeFileSync(join(root, 'state/gateway.env'), 'changed');
  }
  if (line === failCommand)
    return { status: 1, stdout: '', stderr: 'secret-value-must-never-appear' };
  return ok();
}

function context(): BoxContext {
  return {
    box: { CELLD_BUCKET: 'gs://fleet/celld', SAM_DOMAIN: 'box.example' },
    envFile: join(root, 'box.env'),
    stateDir: join(root, 'state'),
    composeFiles: ['compose.yml'],
    run,
    now: () => 0,
    log: (message) => logs.push(message),
  };
}
const upgrade = (checkHealth = async () => true, backupDir: string | null = join(root, 'backup')) =>
  runUpgrade(context(), { to: 'release', backupDir, checkHealth });

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'upgrade-'));
  mkdirSync(join(root, 'state/project'), { recursive: true });
  writeFileSync(
    join(root, 'state/project/wrangler.json'),
    JSON.stringify({ name: 'sam', migrations: HISTORY })
  );
  writeFileSync(join(root, 'state/gateway.env'), 'before');
  steps = [];
  logs = [];
  diff = ['apps/api/src/routes/projects.ts'];
  dirty = false;
  target = structuredClone(HISTORY);
  current = FROM;
  failCommand = undefined;
  generatedChange = false;
  cacheProject = '';
  invalidCacheMount = false;
  vi.mocked(runBackup)
    .mockReset()
    .mockImplementation(() => {
      steps.push('BACKUP');
      return {} as ReturnType<typeof runBackup>;
    });
  vi.mocked(runRollback)
    .mockReset()
    .mockImplementation(() => {
      steps.push('RESTORE');
    });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const deployedSteps = () => steps.filter((step) => !step.startsWith('pnpm exec '));

describe('runUpgrade', () => {
  it('backs up after checking active state, then checks target tags before any deployment', async () => {
    const result = await upgrade();
    expect(steps.indexOf('BACKUP')).toBeGreaterThan(
      steps.findIndex((step) => step.includes('deploy/sam/abc/manifest.json'))
    );
    const targetProbe = steps
      .map((step, index) => (step.startsWith('pnpm exec ') ? index : -1))
      .filter((index) => index >= 0)
      .pop()!;
    expect(targetProbe).toBeLessThan(steps.indexOf('pnpm selfhost:deploy --init'));
    expect(result.composeRestarted).toBe(false);
    expect(steps).toContain('pnpm selfhost:deploy');
    expect(logs.join('\n')).toContain('DO migration preflight passed');
    expect(runRollback).not.toHaveBeenCalled();
  });

  it.each(['deploy/selfhost/docker-compose.yml', 'generated-state'])(
    'restarts between init and deploy when %s changes',
    async (path) => {
      if (path === 'generated-state') generatedChange = true;
      else diff = [path];
      expect((await upgrade()).composeRestarted).toBe(true);
      const up = steps.findIndex(
        (step) => step.startsWith('docker compose ') && step.endsWith(' up -d')
      );
      expect(up).toBeGreaterThan(steps.indexOf('pnpm selfhost:deploy --init'));
      expect(up).toBeLessThan(steps.indexOf('pnpm selfhost:deploy'));
    }
  );

  it('scopes every forward and recovery compose command to the selected installation', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const box = { ...context(), box: { ...context().box, COMPOSE_PROJECT_NAME: 'owned-upgrade' } };
    failCommand = 'pnpm selfhost:deploy';
    await expect(
      runUpgrade(box, {
        to: 'release',
        backupDir: join(root, 'backup'),
        checkHealth: async () => true,
      })
    ).rejects.toThrow(/command output withheld/);
    const docker = steps.filter((step) => step.startsWith('docker compose '));
    expect(docker.length).toBeGreaterThanOrEqual(2);
    expect(
      docker.every((step) => step.startsWith('docker compose --project-name owned-upgrade '))
    ).toBe(true);
    expect(runRollback).toHaveBeenCalledOnce();
  });

  it('proves the real celld cache mount before snapshotting or changing the checkout', async () => {
    await upgrade();
    const proof = steps.findIndex((step) => step.startsWith('docker volume inspect '));
    expect(proof).toBeGreaterThan(-1);
    expect(proof).toBeLessThan(steps.indexOf('BACKUP'));
    expect(steps.indexOf('BACKUP')).toBeLessThan(steps.indexOf(`git checkout --detach ${TO}`));
  });

  it('refuses an unowned bind-mounted cache before backup or checkout', async () => {
    invalidCacheMount = true;
    await expect(upgrade()).rejects.toThrow(/not the canonical owned volume/);
    expect(runBackup).not.toHaveBeenCalled();
    expect(steps.some((step) => step.startsWith('git checkout'))).toBe(false);
    expect(steps).not.toContain('pnpm selfhost:deploy --init');
  });

  it('permits a new shared tag before the retained selfhost-only suffix', async () => {
    target.splice(1, 0, { tag: 'v2', new_sqlite_classes: ['MoreData'] });
    await upgrade();
    expect(steps).toContain('pnpm selfhost:deploy');
  });

  it.each(['unknown', 'out-of-order', 'missing-hosted-git', 'changed-class'])(
    'refuses %s target tags and restores checkout without touching cloud state',
    async (kind) => {
      if (kind === 'unknown') target[0] = { tag: 'unknown', new_sqlite_classes: ['ProjectData'] };
      if (kind === 'out-of-order') target.reverse();
      if (kind === 'missing-hosted-git') target.pop();
      if (kind === 'changed-class') target[0]!.new_sqlite_classes = ['Changed'];
      await expect(upgrade()).rejects.toThrow(/DO migration preflight refused/);
      expect(deployedSteps()).toContain(`git checkout --detach ${FROM}`);
      expect(steps).not.toContain('pnpm selfhost:deploy --init');
      expect(runRollback).not.toHaveBeenCalled();
    }
  );

  it.each(['pnpm selfhost:deploy --init', 'pnpm selfhost:deploy'])(
    'automatically restores the snapshot before starting old code on failure of %s',
    async (command) => {
      diff = ['apps/api/src/db/migrations/0300_new.sql'];
      failCommand = command;
      await expect(upgrade()).rejects.toThrow(/command output withheld/);
      expect(runRollback).toHaveBeenCalledWith(expect.anything(), join(root, 'backup'));
      expect(steps.indexOf('RESTORE')).toBeLessThan(steps.indexOf(`git checkout --detach ${FROM}`));
      expect(steps.at(-1)).toMatch(/^docker compose .* up -d$/);
      expect(logs.join('\n')).toContain('automatic rollback completed');
      expect(logs.join('\n')).not.toContain('secret-value');
    }
  );

  it('rolls back when upgraded health fails and verifies recovered health', async () => {
    const health = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(upgrade(health)).rejects.toThrow(/not healthy/);
    expect(runRollback).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).toContain('automatic rollback completed');
  });

  it('does not start old code if restoring the snapshot fails', async () => {
    failCommand = 'pnpm selfhost:deploy';
    vi.mocked(runRollback).mockImplementation(() => {
      throw new Error('secret-value');
    });
    await expect(upgrade()).rejects.toThrow(/automatic rollback did not complete/);
    expect(steps).not.toContain(`git checkout --detach ${FROM}`);
    expect(logs.join('\n')).not.toContain('secret-value');
  });

  it('fails recovery if the restored installation is unhealthy', async () => {
    await expect(upgrade(async () => false)).rejects.toThrow(/automatic rollback did not complete/);
    expect(logs.join('\n')).not.toContain('automatic rollback completed');
  });

  it('requires a fresh backup before upgrading', async () => {
    await expect(upgrade(async () => true, null)).rejects.toThrow(/requires a fresh backup/);
    expect(steps.some((step) => step.startsWith('git checkout'))).toBe(false);
  });

  it('refuses dirty tracked files before backup or fetch', async () => {
    dirty = true;
    await expect(upgrade()).rejects.toThrow(/uncommitted/);
    expect(steps).toEqual(['git status --porcelain --untracked-files=no']);
  });
});
