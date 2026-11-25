/**
 * selfhost:upgrade orchestration (upgrade-lib.ts) with git, pnpm and docker answered by a fake
 * runner. Asserts the order of the steps, that an encrypted backup is taken, that the stack restarts only
 * when compose inputs change (files in deploy/selfhost/, selected compose files or generated
 * .state/ files), that an image is rebuilt only by an explicit `docker compose build` of a service
 * whose build inputs changed (never `up --build`), that interrupted recovery retains its original snapshot for retry, and that
 * the printed rollback selects the same box and matches whether the upgrade carried a D1 migration.
 */
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackup, runRollback } from './backup-lib.js';
import { composeFilesFor } from './compose-env.js';
import { SELFHOST_DIR } from './deploy-steps.js';
import { imageRebuilds } from './image-rebuilds.js';
import {
  type BoxContext,
  loadBox,
  recoverUpgrade,
  type RunResult,
  runUpgrade,
  UPGRADE_PENDING_FILE,
} from './upgrade-lib.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

vi.mock('./backup-lib.js', async (original) => ({
  ...(await original<typeof import('./backup-lib.js')>()),
  runBackup: vi.fn(),
  assertRollbackCacheReady: vi.fn(),
  runRollback: vi.fn(),
  beginRollbackCacheStart: vi.fn(),
  refreshRollbackCacheReceipt: vi.fn(),
  finishRollbackCache: vi.fn(),
}));
vi.mock('./upgrade-migrations.js', async (original) => ({
  ...(await original<typeof import('./upgrade-migrations.js')>()),
  sourceMigrations: vi.fn(() => [{ tag: 'v1', new_sqlite_classes: ['ProjectData'] }]),
  installedMigrations: vi.fn(() => [{ tag: 'v1', new_sqlite_classes: ['ProjectData'] }]),
}));

vi.mock('./upgrade-preflight.js', async (original) => ({
  ...(await original<typeof import('./upgrade-preflight.js')>()),
  assertRollbackReady: vi.fn(),
}));

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
let root: string;
let steps: string[];
let logs: string[];
let diff: string[];
let dirty: boolean;
let failDeploy: boolean;
let initRewritesState: boolean;
let initRewritesFence: boolean;
/** What the fake checkout has checked out (`git checkout --detach` moves it). */
let head: string;
/** docker-compose.yml at each ref, and the services `docker compose config --services` lists. */
let composeAt: Record<string, string | null>;
/** Other tracked files by repository path, then ref (a selected compose overlay). */
let trackedAt: Record<string, Record<string, string>>;
let activeServices: string[];
let previousServices: string[] | undefined;

const COMPOSE = (dnsModule = 'github.com/caddy-dns/googleclouddns@v1.1.0') => `
services:
  celld:
    image: ghcr.io/denoland/celld@sha256:${'1'.repeat(64)}
  caddy:
    build:
      context: ./caddy
      args:
        CADDY_DNS_MODULE: \${CADDY_DNS_MODULE:-${dnsModule}}
    image: sam-selfhost-caddy:local
  sam-mx:
    profiles: [mail-in]
    build: ./sam-mx
    image: sam-selfhost-sam-mx:local
`;
/** Files at the target ref that the upgrade reads (the caddy context's .dockerignore). */
const FILES_AT_TO: Record<string, string> = {
  'deploy/selfhost/caddy/.dockerignore': '# empty context\n*\n',
};

/** SAM_SELFHOST_STATE_DIR in each docker command's environment (undefined: not set). */
let dockerStateEnv: (string | undefined)[];
/** Tracked files of the fake checkout (under <root>/repo) and their git index modes. */
let trackedModes: Record<string, '100644' | '100755'>;
/** `pnpm install` fails while the target ref is checked out (before any deploy). */
let failTargetInstall: boolean;

/** A checkout under the operator's `umask 077`: git rewrites every checked-out file as 0600. */
function checkoutUnderUmask077(): void {
  for (const path of Object.keys(trackedModes)) chmodSync(join(root, 'repo', path), 0o600);
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  if (command === 'docker') dockerStateEnv.push(env?.SAM_SELFHOST_STATE_DIR);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const line = `${command} ${args.join(' ')}`;
  if (command === 'git') {
    if (args[0] === 'status') return ok(dirty ? ' M apps/api/src/index.ts' : '');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(head);
    if (args[0] === 'checkout') {
      head = args[2] ?? head;
      checkoutUnderUmask077();
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(join(root, 'repo'));
    if (args[0] === 'ls-files')
      return ok(
        Object.entries(trackedModes)
          .map(([path, mode]) => `${mode} ${'c'.repeat(40)} 0\t${path}\0`)
          .join('')
      );
    if (args[0] === 'rev-parse') return ok(TO);
    if (args[0] === 'diff') return ok(diff.join('\n'));
    if (args[0] === 'show') {
      const [ref = '', path = ''] = (args[1] ?? '').split(':');
      const text =
        path === 'deploy/selfhost/docker-compose.yml' ||
        path === 'scripts/selfhost/compose.yml' ||
        path === 'compose.yml'
          ? composeAt[ref]
          : (trackedAt[path]?.[ref] ?? (ref === TO ? FILES_AT_TO[path] : undefined));
      return text === undefined || text === null
        ? { status: 128, stdout: '', stderr: 'does not exist' }
        : ok(text);
    }
    steps.push(line);
    return ok();
  }
  steps.push(line.replaceAll(root, '<root>'));
  const deploy = command === 'pnpm' && args[0] === 'selfhost:deploy';
  if (deploy && args.includes('--init') && initRewritesState) {
    writeFileSync(join(root, 'state/gateway.env'), 'FRPS_PORT_RANGE=21000-21999\n');
  }
  if (deploy && args.includes('--init') && initRewritesFence) {
    writeFileSync(join(root, 'state/egress-fence.nft'), 'table inet changed {}\n');
  }
  if (command === 'docker' && args.includes('config'))
    return ok((head === FROM ? (previousServices ?? activeServices) : activeServices).join('\n'));
  if (command === 'pnpm' && args[0] === 'install' && failTargetInstall && head === TO) {
    return { status: 1, stdout: '', stderr: 'EACCES' };
  }
  if (deploy && !args.includes('--init') && failDeploy) {
    return { status: 1, stdout: '', stderr: 'migration 0219 failed' };
  }
  return ok();
}

function ctx(): BoxContext {
  return {
    // The .env names the state dir, so docker compose reads the same one the upgrade does.
    box: {
      CELLD_BUCKET: 'gs://fleet/celld',
      COMPOSE_PROJECT_NAME: 'sam-test',
      SAM_DOMAIN: 'box.example',
      SAM_SELFHOST_STATE_DIR: join(root, 'state'),
    },
    envFile: join(root, 'box.env'),
    stateDir: join(root, 'state'),
    composeFiles: ['compose.yml'],
    run,
    log: (m) => logs.push(m),
  };
}

const upgrade = (health = true) =>
  runUpgrade(ctx(), { to: 'v2026.11.12', checkHealth: async () => health });

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  vi.mocked(runBackup).mockReset();
  vi.mocked(runRollback).mockReset();
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'sam-upgrade-'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/gateway.env'), 'FRPS_PORT_RANGE=20000-29999\n');
  writeFileSync(join(root, 'box.env'), 'x=1\n', { mode: 0o600 });
  steps = [];
  logs = [];
  diff = ['apps/api/src/routes/projects.ts'];
  dirty = false;
  failDeploy = false;
  initRewritesState = false;
  initRewritesFence = false;
  head = FROM;
  composeAt = { [FROM]: COMPOSE(), [TO]: COMPOSE() };
  trackedAt = {};
  dockerStateEnv = [];
  failTargetInstall = false;
  // The key agent image copies these; it runs as a non-root uid (deploy/selfhost/key-agent).
  trackedModes = {
    'deploy/selfhost/key-agent/bundle-store.ts': '100644',
    'deploy/selfhost/key-agent/server.ts': '100644',
    'scripts/selfhost/hosted-git-smoke.sh': '100755',
  };
  for (const path of Object.keys(trackedModes)) {
    mkdirSync(join(root, 'repo', path, '..'), { recursive: true });
    writeFileSync(join(root, 'repo', path), 'tracked\n', { mode: 0o600 });
  }
  activeServices = ['celld', 'caddy'];
  previousServices = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** The deploy arguments the fake box (ctx()) must be deployed with. */
const BOX_ARGS = '--env-file <root>/box.env --state-dir <root>/state';
const compact = () =>
  steps.map((s) =>
    s.startsWith('docker compose')
      ? s.replace(/ --project-name \S+/, '').replace(/ -f .* --env-file \S+/, '')
      : s
  );

describe('runUpgrade', () => {
  it('recreates the fence before restarting the stack after a generated nft-only change', async () => {
    initRewritesFence = true;
    const result = await upgrade();
    expect(result.composeRestarted).toBe(true);
    const order = compact();
    expect(order).toContain('docker compose up -d --force-recreate egress-fence');
    expect(order.indexOf('docker compose up -d --force-recreate egress-fence')).toBeLessThan(
      order.indexOf('docker compose up -d')
    );
  });

  it.each([true, false])(
    'recovery recreates restored rules only when the old stack has a fence (%s)',
    async (hasFence) => {
      writeFileSync(join(root, 'state/egress-fence.nft'), 'table inet restored {}\n');
      previousServices = ['celld', 'caddy', ...(hasFence ? ['egress-fence'] : [])];
      await recoverUpgrade(ctx(), FROM, join(root, 'backup'), [], {
        to: 'v1',
        checkHealth: async () => true,
      });
      const order = compact();
      const recreate = 'docker compose up -d --force-recreate egress-fence';
      if (hasFence) {
        expect(order.indexOf(recreate)).toBeGreaterThan(-1);
        expect(order.indexOf(recreate)).toBeLessThan(order.indexOf('docker compose up -d'));
      } else expect(order).not.toContain(recreate);
    }
  );

  it('checks out, backs up, migrates and deploys, and leaves the stack running when compose inputs are unchanged', async () => {
    const result = await upgrade();
    expect(compact()).toEqual([
      'git fetch --tags origin',
      `git checkout --detach ${TO}`,
      'pnpm install --frozen-lockfile',
      `pnpm selfhost:deploy --init ${BOX_ARGS}`,
      `pnpm selfhost:deploy ${BOX_ARGS}`,
    ]);
    expect(result.composeRestarted).toBe(false);
    expect(runBackup).toHaveBeenCalledOnce();
    expect(result.rollback.join('\n')).toContain('--rollback-from');
  });

  it('restarts the stack between --init and the deploy when a compose file changed', async () => {
    diff = ['deploy/selfhost/docker-compose.yml', 'deploy/selfhost/README.md'];
    const result = await upgrade();
    const order = compact();
    const up = order.indexOf('docker compose up -d');
    expect(up).toBeGreaterThan(order.indexOf(`pnpm selfhost:deploy --init ${BOX_ARGS}`));
    expect(up).toBeLessThan(order.indexOf(`pnpm selfhost:deploy ${BOX_ARGS}`));
    expect(result.composeRestarted).toBe(true);
  });

  // An upgrade that dropped them deployed the checkout's default deploy/selfhost/.env and
  // .state instead, where --init generates brand-new platform keys for an existing install.
  it('passes a non-default env file, state dir and secrets file to every deploy it runs', async () => {
    const envFile = join(root, 'custom', 'box.env');
    mkdirSync(join(root, 'custom'));
    writeFileSync(
      envFile,
      `CELLD_BUCKET=gs://fleet/celld\nCOMPOSE_PROJECT_NAME=sam-test\nSAM_SELFHOST_STATE_DIR=${join(root, 'state')}\n`,
      { mode: 0o600 }
    );
    const secrets = join(root, 'custom', 'secrets.env');
    const loaded = loadBox(envFile, join(root, 'custom-state'), secrets);
    diff = ['deploy/selfhost/docker-compose.yml'];
    const result = await runUpgrade(
      { ...loaded, run, log: (m) => logs.push(m) },
      { to: 'v1', checkHealth: async () => true }
    );
    const expected =
      '--env-file <root>/custom/box.env --state-dir <root>/custom-state ' +
      '--secrets <root>/custom/secrets.env';
    const deploys = steps.filter((step) => step.startsWith('pnpm selfhost:deploy'));
    expect(deploys).toEqual([
      `pnpm selfhost:deploy --init ${expected}`,
      `pnpm selfhost:deploy ${expected}`,
    ]);
    const rollback = result.rollback.map((step) => step.replaceAll(root, '<root>'));
    expect(
      rollback.some(
        (step) =>
          step.includes('--rollback-from') && step.includes('--box-env <root>/custom/box.env')
      )
    ).toBe(true);
  });

  it('restarts the stack when --init rewrote a generated state file (gateway.env)', async () => {
    initRewritesState = true;
    const result = await upgrade();
    expect(result.composeRestarted).toBe(true);
  });

  it('does not restart for a README-only change under deploy/selfhost', async () => {
    diff = ['deploy/selfhost/README.md'];
    expect((await upgrade()).composeRestarted).toBe(false);
  });

  it('prints a restore-based rollback when the upgrade carries a D1 migration', async () => {
    diff = ['apps/api/src/db/migrations/0300_new.sql'];
    const result = await upgrade();
    expect(result.migrationsChanged).toBe(true);
    expect(result.rollback.join('\n')).toContain(`selfhost:upgrade --to ${FROM}`);
    expect(result.rollback.join('\n')).toContain('--rollback-from');
  });

  it('stops at a failed deploy and prints the rollback', async () => {
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/command output withheld/);
    expect(runRollback).toHaveBeenCalledOnce();
    expect(head).toBe(FROM);
    expect(logs.join('\n')).toContain('automatic rollback completed');
  });

  // The failed run leaves the checkout at the target: equal refs must not read as "deployed".
  it('retries a failed upgrade with the same --to, from the ref deployed before it', async () => {
    failDeploy = true;
    vi.mocked(runRollback).mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    await expect(upgrade()).rejects.toThrow(/automatic rollback did not complete/);
    expect(head).toBe(TO);
    expect(existsSync(join(root, 'state', UPGRADE_PENDING_FILE))).toBe(true);
    failDeploy = false;
    const retry = await upgrade();
    expect(runRollback).toHaveBeenCalledTimes(2);
    expect(retry.from).toBe(FROM);
    expect(existsSync(join(root, 'state', UPGRADE_PENDING_FILE))).toBe(false);
    steps = [];
    expect((await upgrade()).rollback).toEqual([]);
    expect(steps).toEqual(['git fetch --tags origin']);
  });

  it('refuses A-to-C retry after an interrupted A-to-B image rebuild before starting A with B images', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile'];
    failDeploy = true;
    vi.mocked(runRollback).mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    await expect(upgrade()).rejects.toThrow(/automatic rollback did not complete/);
    expect(steps.some((step) => step.includes('build caddy'))).toBe(true);
    const pending = JSON.parse(readFileSync(join(root, 'state', UPGRADE_PENDING_FILE), 'utf8'));
    expect(pending.to).toBe(TO);
    const priorRestores = vi.mocked(runRollback).mock.calls.length;
    steps = [];
    const next = ctx();
    next.run = (command, args, env) =>
      command === 'git' && args[0] === 'rev-parse' && args[1] !== 'HEAD'
        ? { status: 0, stdout: 'c'.repeat(40), stderr: '' }
        : run(command, args, env);
    await expect(
      runUpgrade(next, { to: 'release-c', checkHealth: async () => true })
    ).rejects.toThrow(/target differs/);
    expect(vi.mocked(runRollback).mock.calls.length).toBe(priorRestores);
    expect(steps).toEqual(['git fetch --tags origin']);
    expect(head).toBe(TO);
  });

  it('retains the original target if snapshot recovery succeeds but old health fails', async () => {
    failDeploy = true;
    await expect(upgrade(false)).rejects.toThrow(/automatic rollback did not complete/);
    const pending = JSON.parse(readFileSync(join(root, 'state', UPGRADE_PENDING_FILE), 'utf8'));
    expect(pending.to).toBe(TO);
  });

  it.each([undefined, 'main', 'unknown'])(
    'refuses legacy or malformed pending target %s before any recovery or checkout',
    async (to) => {
      writeFileSync(
        join(root, 'state', UPGRADE_PENDING_FILE),
        JSON.stringify({ from: FROM, backupDir: join(root, 'snapshot'), to })
      );
      await expect(upgrade()).rejects.toThrow(/target differs or is unrecorded/);
      expect(runRollback).not.toHaveBeenCalled();
      expect(steps).toEqual(['git fetch --tags origin']);
      expect(head).toBe(FROM);
    }
  );

  it('refuses a pending record it did not write before touching the checkout', async () => {
    writeFileSync(join(root, 'state', UPGRADE_PENDING_FILE), '{"from":"HEAD~1"}\n');
    await expect(upgrade()).rejects.toThrow(/not a record this upgrade wrote/);
    expect(steps).toEqual(['git fetch --tags origin']);
  });

  it.each([
    'unlink-before',
    'unlink-lost',
    'completion-file-sync',
    'completion-parent-sync',
    'unlink-parent-sync',
  ] as const)(
    'preserves accepted live writes after successful health and interrupted %s',
    async (boundary) => {
      const pending = join(root, 'state', UPGRADE_PENDING_FILE);
      const data = join(root, 'state/accepted-data');
      let healthy = false,
        injected = false,
        completionWritten = false;
      const originalRm = fs.rmSync,
        originalSync = fs.fsyncSync,
        originalWrite = fs.writeSync;
      vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
        const result = Reflect.apply(originalWrite, fs, args);
        if (healthy && /"phase"\s*:\s*"completed"/.test(String(args[1]))) completionWritten = true;
        return result;
      });
      vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
        if (
          !injected &&
          healthy &&
          String(path) === pending &&
          ['unlink-before', 'unlink-lost'].includes(boundary)
        ) {
          injected = true;
          if (boundary === 'unlink-before') throw new Error('Injected pending unlink failure');
          const retained = readFileSync(pending, 'utf8');
          originalRm(path, options);
          // Model the directory entry reappearing after a power loss without parent fsync.
          writeFileSync(pending, retained, { mode: 0o600 });
          return;
        }
        return originalRm(path, options);
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        originalSync(fd);
        if (injected || !healthy) return;
        const directory = fs.fstatSync(fd).isDirectory();
        const completed =
          existsSync(pending) && /"phase"\s*:\s*"completed"/.test(readFileSync(pending, 'utf8'));
        if (
          (boundary === 'completion-file-sync' && !directory && completionWritten) ||
          (boundary === 'completion-parent-sync' && directory && completed) ||
          (boundary === 'unlink-parent-sync' &&
            directory &&
            completionWritten &&
            !existsSync(pending))
        ) {
          injected = true;
          throw new Error('Injected completion durability failure');
        }
      });
      vi.mocked(runRollback).mockImplementation(() => writeFileSync(data, 'old snapshot rows'));
      const health = vi.fn(async () => {
        healthy = true;
        writeFileSync(data, 'accepted live writes');
        return true;
      });
      try {
        await runUpgrade(ctx(), { to: 'v2026.11.12', checkHealth: health });
      } catch {
        /* A completion durability failure must remain safe to retry. */
      }
      expect(health).toHaveBeenCalledOnce();
      expect(injected).toBe(true);
      expect(head).toBe(TO);
      expect(readFileSync(data, 'utf8')).toBe('accepted live writes');
      expect(runRollback).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      vi.mocked(runBackup).mockClear();
      vi.mocked(runRollback).mockClear();
      steps = [];
      const retryHealth = vi.fn(async () => true);
      let retryError: unknown;
      try {
        await runUpgrade(ctx(), { to: 'v2026.11.12', checkHealth: retryHealth });
      } catch (error) {
        retryError = error;
      }
      if (boundary === 'completion-file-sync') {
        if (retryError) expect(String(retryError)).toMatch(/verification|completion/);
      } else expect(retryError).toBeUndefined();
      expect(readFileSync(data, 'utf8')).toBe('accepted live writes');
      expect(head).toBe(TO);
      expect(runRollback).not.toHaveBeenCalled();
      expect(runBackup).not.toHaveBeenCalled();
      expect(retryHealth).not.toHaveBeenCalled();
      expect(steps.some((step) => /selfhost:deploy|checkout|docker/.test(step))).toBe(false);
      if (boundary !== 'completion-file-sync') expect(existsSync(pending)).toBe(false);
    }
  );

  it.each(['before-unlink', 'lost-unlink'] as const)(
    'never replays the snapshot after healthy automatic recovery and %s interruption',
    async (boundary) => {
      const pending = join(root, 'state', UPGRADE_PENDING_FILE);
      const data = join(root, 'state/recovered-live-data');
      let healthCalls = 0,
        injected = false;
      const originalRm = fs.rmSync;
      vi.mocked(runRollback).mockImplementation(() => writeFileSync(data, 'old snapshot rows'));
      vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
        if (!injected && healthCalls === 2 && String(path) === pending) {
          injected = true;
          if (boundary === 'before-unlink')
            throw new Error('Injected recovered cleanup interruption');
          const retained = readFileSync(pending, 'utf8');
          originalRm(path, options);
          writeFileSync(pending, retained, { mode: 0o600 });
          return;
        }
        return originalRm(path, options);
      });
      const health = vi.fn(async () => {
        healthCalls += 1;
        if (healthCalls === 1) return false;
        writeFileSync(data, 'accepted recovery writes');
        return true;
      });
      await expect(runUpgrade(ctx(), { to: 'v2026.11.12', checkHealth: health })).rejects.toThrow();
      expect(health).toHaveBeenCalledTimes(2);
      expect(injected).toBe(true);
      expect(head).toBe(FROM);
      expect(readFileSync(data, 'utf8')).toBe('accepted recovery writes');
      expect(runRollback).toHaveBeenCalledOnce();
      expect(existsSync(pending)).toBe(true);
      vi.restoreAllMocks();
      vi.mocked(runRollback).mockClear();
      await runUpgrade(ctx(), { to: 'v2026.11.12', checkHealth: async () => true });
      expect(readFileSync(data, 'utf8')).toBe('accepted recovery writes');
      expect(runRollback).not.toHaveBeenCalled();
      expect(head).toBe(TO);
      expect(existsSync(pending)).toBe(false);
    }
  );

  it.each(['source', 'target', 'snapshot', 'phase', 'head', 'public-file'] as const)(
    'refuses a completed marker with invalid %s without restoring or deploying',
    async (defect) => {
      head = defect === 'head' ? FROM : TO;
      const originalHead = head;
      const pending = join(root, 'state', UPGRADE_PENDING_FILE);
      const marker = {
        from: defect === 'source' ? 'HEAD~1' : FROM,
        to: defect === 'target' ? 'c'.repeat(40) : TO,
        backupDir: defect === 'snapshot' ? 'relative/path' : join(root, 'snapshot'),
        phase: defect === 'phase' ? 'unrecognized' : 'completed',
      };
      const bytes = JSON.stringify(marker);
      writeFileSync(pending, bytes, { mode: defect === 'public-file' ? 0o644 : 0o600 });
      const health = vi.fn(async () => true);
      await expect(runUpgrade(ctx(), { to: 'v2026.11.12', checkHealth: health })).rejects.toThrow();
      expect(readFileSync(pending, 'utf8')).toBe(bytes);
      expect(head).toBe(originalHead);
      expect(runRollback).not.toHaveBeenCalled();
      expect(runBackup).not.toHaveBeenCalled();
      expect(health).not.toHaveBeenCalled();
      expect(steps.some((step) => /selfhost:deploy|checkout|docker/.test(step))).toBe(false);
    }
  );

  it('control: a completed upgrade leaves no pending record and is not repeated', async () => {
    await upgrade();
    expect(existsSync(join(root, 'state', UPGRADE_PENDING_FILE))).toBe(false);
    steps = [];
    await upgrade();
    expect(steps).toEqual(['git fetch --tags origin']);
  });

  // The upgrade restarted the stack for the new gateway.env; the rollback must restart it again.
  it('rolls back generated state that --init changed, on failure and on success', async () => {
    initRewritesState = true;
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/command output withheld/);
    expect(runRollback).toHaveBeenCalledOnce();
    expect(compact().at(-1)).toBe('docker compose up -d');
    expect(head).toBe(FROM);
    writeFileSync(join(root, 'state/gateway.env'), 'before');
    failDeploy = false;
    const rollback = (await upgrade()).rollback;
    expect(rollback.some((step) => step.includes('--rollback-from'))).toBe(true);
    expect(rollback).toHaveLength(1);
    expect(rollback[0]).toContain(`--to ${FROM}`);
  });

  it('fails when the API is unhealthy after the deploy', async () => {
    await expect(upgrade(false)).rejects.toThrow(/automatic rollback did not complete/);
  });

  it('refuses a checkout with uncommitted tracked changes before touching anything', async () => {
    dirty = true;
    await expect(upgrade()).rejects.toThrow(/uncommitted/);
    expect(steps).toEqual([]);
  });
});

// Seen on a box, 2026-11-12: .env had COMPOSE_FILE listing an override file. The upgrade's
// `docker compose --project-name sam-test -f docker-compose.yml up -d --build` replaced that list and recreated celld
// without what the override added.
// S4: the box's ports are checked against the lease range when the upgrade loads the box, before it
// fetches, checks out or runs docker compose (not only inside Caddy's start.sh once it is up).
// Idea 01M89H1MQHJH432BFT2N43GHJJ: under `umask 077` every checkout rewrote tracked files 0600,
// the non-root key agent failed with EACCES, and the automatic rollback failed the same way.
describe('runUpgrade under a restrictive operator umask', () => {
  const modes = () =>
    Object.fromEntries(
      Object.keys(trackedModes).map((path) => [
        path,
        (statSync(join(root, 'repo', path)).mode & 0o777).toString(8),
      ])
    );
  const GIT_MODES = {
    'deploy/selfhost/key-agent/bundle-store.ts': '644',
    'deploy/selfhost/key-agent/server.ts': '644',
    'scripts/selfhost/hosted-git-smoke.sh': '755',
  };

  it('leaves the target checkout at git modes, so the key agent can read its sources', async () => {
    await upgrade();
    expect(head).toBe(TO);
    expect(modes()).toEqual(GIT_MODES);
    expect(logs).toContain('restored git file modes on 3 tracked files');
  });

  it('restores git modes when a failed deploy rolls back to the previous ref', async () => {
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/command output withheld/);
    expect(logs.join('\n')).toContain('automatic rollback completed');
    expect(head).toBe(FROM);
    expect(modes()).toEqual(GIT_MODES);
  });

  it('restores git modes when the rollback runs before any deploy (failed install)', async () => {
    failTargetInstall = true;
    await expect(upgrade()).rejects.toThrow(/pnpm install --frozen-lockfile failed/);
    expect(logs.join('\n')).toContain('automatic rollback completed');
    expect(head).toBe(FROM);
    expect(modes()).toEqual(GIT_MODES);
  });

  it('control: the fake checkout does leave files 0600 until the repair runs', () => {
    checkoutUnderUmask077();
    expect(new Set(Object.values(modes()))).toEqual(new Set(['600']));
  });
});

describe('loadBox refuses a box port inside the lease range', () => {
  const envWith = (line: string) => {
    const envFile = join(root, 'ports.env');
    writeFileSync(
      envFile,
      `CELLD_BUCKET=gs://fleet/celld\nCOMPOSE_PROJECT_NAME=sam-test\n${line}\n`,
      { mode: 0o600 }
    );
    return envFile;
  };

  it.each(['SAM_MX_LISTEN=:20025', 'CELLD_INTERNAL_PORT=20001'])('%s', (line) => {
    expect(() => loadBox(envWith(line), join(root, 'state'))).toThrow(
      /REVERSE_TUNNEL_PORT_RANGE 20000-29999 contains/
    );
  });

  it('control: the default listeners load', () => {
    expect(loadBox(envWith('SAM_MX_LISTEN=:25'), join(root, 'state')).box.SAM_MX_LISTEN).toBe(
      ':25'
    );
  });
});

describe('runUpgrade with the box .env COMPOSE_FILE', () => {
  const boxFromEnv = (lines: string[]): BoxContext => {
    const envFile = join(root, 'real.env');
    const stateLine = `SAM_SELFHOST_STATE_DIR=${join(root, 'state')}`;
    writeFileSync(
      envFile,
      [
        `CELLD_BUCKET=gs://fleet/celld`,
        'COMPOSE_PROJECT_NAME=sam-test',
        stateLine,
        ...lines,
        '',
      ].join('\n'),
      {
        mode: 0o600,
      }
    );
    // The real loader reads the .env; only the commands are answered by the fake runner.
    return { ...loadBox(envFile, join(root, 'state')), run, log: (m) => logs.push(m) };
  };
  const restartCommand = () =>
    steps.find((s) => s.startsWith('docker compose') && s.includes(' up '));

  it('restarts the stack with every file COMPOSE_FILE lists, in order', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml']);
    await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    expect(restartCommand()).toBe(
      `docker compose --project-name sam-test -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
        `-f ${join(SELFHOST_DIR, 'docker-compose.override.yml')} ` +
        `--env-file <root>/real.env up -d`
    );
  });

  it('uses docker-compose.yml alone when COMPOSE_FILE is unset (control)', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv([]);
    await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    expect(restartCommand()).toBe(
      `docker compose --project-name sam-test -f ${join(SELFHOST_DIR, 'docker-compose.yml')} --env-file <root>/real.env up -d`
    );
  });

  it('prints rollback compose steps for the selected box: its .env and every compose file', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml']);
    const result = await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    expect(result.rollback).toHaveLength(1);
    expect(result.rollback[0]).toContain(`--box-env ${ctx.envFile}`);
    expect(result.rollback[0]).toContain(`--state-dir ${ctx.stateDir}`);
    expect(result.rollback[0]).not.toContain('selfhost:restore');
  });

  it('selects the same box in the restore-based rollback, quoting a path with a space', async () => {
    diff = ['apps/api/src/db/migrations/0300_new.sql'];
    const envFile = join(root, 'my box.env');
    writeFileSync(
      envFile,
      `CELLD_BUCKET=gs://fleet/celld\nCOMPOSE_PROJECT_NAME=sam-test\nSAM_SELFHOST_STATE_DIR=${join(root, 'state')}\n`,
      { mode: 0o600 }
    );
    const ctx = { ...loadBox(envFile, join(root, 'state')), run, log: (m: string) => logs.push(m) };
    const { rollback } = await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    expect(rollback.join('\n')).toContain(`--box-env '${envFile}'`);
    expect(rollback.join('\n')).toContain(`--to ${FROM}`);
    expect(rollback.join('\n')).toContain('--rollback-from');
    expect(rollback.join('\n')).not.toContain('selfhost:restore');
  });

  // COMPOSE_FILE may list a file outside deploy/selfhost; a change to it alone must restart.
  it('restarts the stack when only a selected compose file outside deploy/selfhost changed', async () => {
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:../../ops/box.yml']);
    diff = ['ops/box.yml'];
    expect(
      (await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true })).composeRestarted
    ).toBe(true);
  });

  it('control: an unselected file beside it does not restart the stack', async () => {
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:../../ops/box.yml']);
    diff = ['ops/other.yml'];
    expect(
      (await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true })).composeRestarted
    ).toBe(false);
  });

  // F11: the explicit build selects the same box as every other compose command.
  it('rebuilds with every selected compose file and the box .env, forward and in the rollback', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile'];
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml']);
    const result = await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    const build =
      `docker compose --project-name sam-test -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
      `-f ${join(SELFHOST_DIR, 'docker-compose.override.yml')} ` +
      `--env-file <root>/real.env build caddy`;
    expect(steps).toContain(build);
    const rollback = result.rollback.map((step) => step.replaceAll(root, '<root>'));
    expect(rollback[0]).toContain('--rebuild caddy');
    expect(rollback[0]).toContain('--box-env <root>/real.env');
  });
});

// docker compose reads ${SAM_SELFHOST_STATE_DIR:-./.state} against deploy/selfhost/, not the .env's
// directory, so a --state-dir the .env does not name must reach every compose command.
describe('runUpgrade with a state dir docker compose would not read on its own', () => {
  const box = (stateLine: string[]): BoxContext => {
    const envFile = join(root, 'real.env');
    writeFileSync(
      envFile,
      ['COMPOSE_PROJECT_NAME=sam-test', 'CELLD_BUCKET=gs://fleet/celld', ...stateLine, ''].join(
        '\n'
      ),
      {
        mode: 0o600,
      }
    );
    return { ...loadBox(envFile, join(root, 'state')), run, log: (m) => logs.push(m) };
  };

  it('sets SAM_SELFHOST_STATE_DIR on every compose command it runs and prints', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile', 'apps/api/src/db/migrations/0300_new.sql'];
    const result = await runUpgrade(box([]), { to: 'v1', checkHealth: async () => true });
    const state = join(root, 'state');
    expect(dockerStateEnv.length).toBeGreaterThan(1);
    expect(dockerStateEnv.every((value) => value === state)).toBe(true);
    expect(result.rollback[0]).toContain(`--state-dir ${state}`);
  });

  it('control: sets nothing when the .env already names that state dir', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile', 'apps/api/src/db/migrations/0300_new.sql'];
    const result = await runUpgrade(box([`SAM_SELFHOST_STATE_DIR=${join(root, 'state')}`]), {
      to: 'v1',
      checkHealth: async () => true,
    });
    expect(dockerStateEnv.length).toBeGreaterThan(1);
    expect(dockerStateEnv.every((value) => value === undefined)).toBe(true);
    expect(result.rollback[0]).toContain(`--state-dir ${join(root, 'state')}`);
    expect(result.rollback.some((step) => step.includes('SAM_SELFHOST_STATE_DIR='))).toBe(false);
  });
});

// A selected overlay can add or change a build section; up -d never builds, so the plan must see it.
describe('runUpgrade with a compose overlay that builds', () => {
  const OVERLAY = 'deploy/selfhost/docker-compose.override.yml';
  const overlay = (dnsModule: string) => `
services:
  caddy:
    build:
      args:
        CADDY_DNS_MODULE: ${dnsModule}
`;
  const boxWithOverlay = (file = 'docker-compose.override.yml'): BoxContext => {
    const envFile = join(root, 'real.env');
    writeFileSync(
      envFile,
      `CELLD_BUCKET=gs://fleet/celld\nCOMPOSE_PROJECT_NAME=sam-test\nSAM_SELFHOST_STATE_DIR=${join(root, 'state')}\n` +
        `COMPOSE_FILE=docker-compose.yml:${file}\n`,
      { mode: 0o600 }
    );
    return { ...loadBox(envFile, join(root, 'state')), run, log: (m) => logs.push(m) };
  };
  const built = () => steps.filter((s) => s.startsWith('docker compose') && s.includes(' build '));

  it('rebuilds caddy when a tracked overlay changes its build args', async () => {
    diff = [OVERLAY];
    trackedAt[OVERLAY] = { [FROM]: overlay('mod@v1'), [TO]: overlay('mod@v2') };
    await runUpgrade(boxWithOverlay(), { to: 'v1', checkHealth: async () => true });
    expect(built().map((s) => s.split(' ').at(-1))).toEqual(['caddy']);
  });

  it('rollback retains a service defined only by the selected old overlay', async () => {
    trackedAt[OVERLAY] = {
      [FROM]: 'services:\n  custom-relay:\n    build: ./relay-old\n',
      [TO]: 'services:\n  custom-relay:\n    build: ./relay-new\n  new-sidecar:\n    build: ./new-sidecar\n',
    };
    diff = [OVERLAY];
    activeServices = ['celld', 'custom-relay', 'new-sidecar'];
    const result = await runUpgrade(boxWithOverlay(), { to: 'v1', checkHealth: async () => true });
    expect(result.imagesRebuilt).toEqual(['custom-relay', 'new-sidecar']);
    previousServices = ['celld', 'custom-relay'];
    await recoverUpgrade(boxWithOverlay(), FROM, result.backupDir!, result.imagesRebuilt, {
      to: 'v1',
      checkHealth: async () => true,
    });
    expect(built().at(-1)?.split(' build ')[1]).toBe('custom-relay');
    expect(built().at(-1)).toContain('docker-compose.override.yml');
  });

  it('rollback excludes services found only in an unselected default compose file', async () => {
    const envFile = join(root, 'custom-box.env');
    writeFileSync(envFile, `CELLD_BUCKET=gs://fleet/celld\nCOMPOSE_FILE=../../ops/custom.yml\n`, {
      mode: 0o600,
    });
    trackedAt['ops/custom.yml'] = {
      [FROM]: 'services:\n  celld:\n    image: existing\n',
      [TO]: 'services:\n  celld:\n    image: existing\n  caddy:\n    build: ./custom-caddy\n',
    };
    diff = ['ops/custom.yml'];
    const result = await runUpgrade(
      { ...loadBox(envFile, join(root, 'state')), run, log: (m) => logs.push(m) },
      { to: 'v1', checkHealth: async () => true }
    );
    expect(result.imagesRebuilt).toEqual(['caddy']);
    previousServices = ['celld'];
    const buildsBefore = built().length;
    await recoverUpgrade(
      { ...loadBox(envFile, join(root, 'state')), run, log: (m) => logs.push(m) },
      FROM,
      result.backupDir!,
      result.imagesRebuilt,
      { to: 'v1', checkHealth: async () => true }
    );
    expect(built()).toHaveLength(buildsBefore);
  });

  it('control: an overlay change that leaves every build section alone rebuilds nothing', async () => {
    diff = [OVERLAY];
    trackedAt[OVERLAY] = { [FROM]: overlay('mod@v1'), [TO]: `${overlay('mod@v1')}  celld: {}\n` };
    await runUpgrade(boxWithOverlay(), { to: 'v1', checkHealth: async () => true });
    expect(built()).toEqual([]);
  });

  it('rebuilds a service an untracked overlay builds when its context changed', async () => {
    const file = join(root, 'ops.yml');
    writeFileSync(file, 'services:\n  celld:\n    build: ./celld-local\n');
    diff = ['deploy/selfhost/celld-local/main.go'];
    activeServices = ['celld', 'caddy'];
    await runUpgrade(boxWithOverlay(file), { to: 'v1', checkHealth: async () => true });
    expect(built().map((s) => s.split(' ').at(-1))).toEqual(['celld']);
  });
});

// F11: an image build fetches base images and modules from the network, so it must be explicit
// and happen only when the image it produces differs.
describe('runUpgrade image builds', () => {
  const dockerSteps = () => compact().filter((step) => step.startsWith('docker'));

  it('rebuilds caddy explicitly, then restarts without --build, when its Dockerfile changed', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile'];
    const result = await upgrade();
    expect(dockerSteps()).toEqual([
      'docker compose config --services',
      'docker compose build caddy',
      'docker compose up -d',
    ]);
    const order = compact();
    expect(order.indexOf('docker compose build caddy')).toBeGreaterThan(
      order.indexOf(`pnpm selfhost:deploy --init ${BOX_ARGS}`)
    );
    expect(order.indexOf('docker compose up -d')).toBeLessThan(
      order.indexOf(`pnpm selfhost:deploy ${BOX_ARGS}`)
    );
    expect(result.imagesRebuilt).toEqual(['caddy']);
    // Rolling back rebuilds the old image the same explicit way.
    const rollback = result.rollback.map((step) => step.replaceAll(root, '<root>'));
    expect(rollback[0]).toContain('--rebuild caddy');
    expect(rollback[0]).toContain('--box-env <root>/box.env');
  });

  it.each([false, true])(
    'rollback filters newly added services from the old ref (migration=%s)',
    async (migrated) => {
      composeAt[TO] =
        `${COMPOSE()}  egress-fence:\n    build: ./egress-fence\n  gce-metadata-proxy:\n    build: ./metadata-proxy\n`;
      diff = [
        'deploy/selfhost/docker-compose.yml',
        'deploy/selfhost/caddy/Dockerfile',
        ...(migrated ? ['apps/api/src/db/migrations/9999_test.sql'] : []),
      ];
      activeServices = ['celld', 'caddy', 'egress-fence', 'gce-metadata-proxy'];
      const result = await upgrade();
      expect(result.imagesRebuilt).toEqual(['caddy', 'egress-fence', 'gce-metadata-proxy']);
      previousServices = ['celld', 'caddy'];
      await recoverUpgrade(ctx(), FROM, result.backupDir!, result.imagesRebuilt, {
        to: 'v1',
        checkHealth: async () => true,
      });
      expect(
        dockerSteps()
          .filter((step) => step.includes(' build '))
          .at(-1)
      ).toBe('docker compose build caddy');
    }
  );

  it('rebuilds caddy when the compose build args changed (a new pinned module)', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    composeAt[TO] = COMPOSE('github.com/caddy-dns/googleclouddns@v1.2.0');
    expect((await upgrade()).imagesRebuilt).toEqual(['caddy']);
  });

  it('does not rebuild caddy for a Caddyfile change: its build context is empty', async () => {
    diff = ['deploy/selfhost/caddy/Caddyfile', 'deploy/selfhost/caddy/sam.d/frp.caddy'];
    const result = await upgrade();
    expect(dockerSteps()).toEqual(['docker compose up -d']);
    expect(result.imagesRebuilt).toEqual([]);
    expect(result.composeRestarted).toBe(true);
  });

  it('does not build sam-mx on a box that does not run it (mail-in profile off)', async () => {
    diff = ['deploy/selfhost/sam-mx/session.go'];
    const result = await upgrade();
    expect(dockerSteps()).toEqual(['docker compose config --services', 'docker compose up -d']);
    expect(result.imagesRebuilt).toEqual([]);
  });

  it('builds sam-mx when the box runs it and its source changed (control)', async () => {
    diff = ['deploy/selfhost/sam-mx/session.go'];
    activeServices = ['celld', 'caddy', 'sam-mx'];
    expect((await upgrade()).imagesRebuilt).toEqual(['sam-mx']);
    expect(dockerSteps()).toContain('docker compose build sam-mx');
  });

  it('prints the rebuild in the rollback when the deploy after it fails', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile'];
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/command output withheld/);
    expect(compact().filter((step) => step === 'docker compose build caddy')).toHaveLength(2);
    expect(runRollback).toHaveBeenCalledOnce();
  });

  it('filters unavailable old services from rollback after a failed upgraded deploy', async () => {
    composeAt[TO] = `${COMPOSE()}  new-sidecar:\n    build: ./new-sidecar\n`;
    diff = ['deploy/selfhost/docker-compose.yml', 'deploy/selfhost/caddy/Dockerfile'];
    activeServices = ['celld', 'caddy', 'new-sidecar'];
    failDeploy = true;
    previousServices = ['celld', 'caddy'];
    await expect(upgrade()).rejects.toThrow(/command output withheld/);
    expect(
      dockerSteps()
        .filter((step) => step.includes(' build '))
        .at(-1)
    ).toBe('docker compose build caddy');
  });

  it('never passes --build to docker compose', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile', 'deploy/selfhost/docker-compose.yml'];
    await upgrade();
    expect(steps.some((step) => step.includes('--build'))).toBe(false);
  });
});

describe('imageRebuilds', () => {
  it('counts every file of a context that sends its files to the build', () => {
    expect(imageRebuilds(['deploy/selfhost/sam-mx/go.sum'], COMPOSE(), COMPOSE())).toEqual([
      'sam-mx',
    ]);
  });

  it('ignores README files and unrelated paths', () => {
    expect(
      imageRebuilds(
        ['deploy/selfhost/sam-mx/README.md', 'apps/api/src/index.ts'],
        COMPOSE(),
        COMPOSE()
      )
    ).toEqual([]);
  });

  it('rebuilds a service that had no build section at the old ref', () => {
    expect(imageRebuilds([], null, COMPOSE())).toEqual(['caddy', 'sam-mx']);
  });

  // An overlay whose context is the repository root (`../..` from deploy/selfhost) sends every
  // file to the build: a change anywhere in the repository must count.
  it('counts any changed file for a build context at the repository root', () => {
    const rootBuild = 'services:\n  celld:\n    build:\n      context: ../..\n';
    const overlays = [{ from: rootBuild, to: rootBuild }];
    expect(
      imageRebuilds(['apps/api/src/index.ts'], COMPOSE(), COMPOSE(), () => null, overlays)
    ).toEqual(['celld']);
    expect(imageRebuilds(['README.md'], COMPOSE(), COMPOSE(), () => null, overlays)).toEqual([]);
  });

  // Compose merges build args by name whatever form each file uses (list or mapping).
  it('merges list-form overlay args by name, so a base-only arg change still rebuilds', () => {
    const listOverlay = 'services:\n  caddy:\n    build:\n      args:\n        - EXTRA=x\n';
    const overlays = [{ from: listOverlay, to: listOverlay }];
    expect(imageRebuilds([], COMPOSE('mod@v1'), COMPOSE('mod@v2'), () => null, overlays)).toEqual([
      'caddy',
    ]);
    expect(imageRebuilds([], COMPOSE('mod@v1'), COMPOSE('mod@v1'), () => null, overlays)).toEqual(
      []
    );
  });

  it('merges an overlay build section over the base one (args merge, keys replace)', () => {
    const tweak = 'services:\n  caddy:\n    build:\n      args:\n        EXTRA: x\n';
    expect(
      imageRebuilds([], COMPOSE(), COMPOSE(), () => null, [{ from: null, to: tweak }])
    ).toEqual(['caddy']);
    expect(
      imageRebuilds([], COMPOSE(), COMPOSE(), () => null, [{ from: tweak, to: tweak }])
    ).toEqual([]);
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
