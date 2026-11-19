/**
 * selfhost:upgrade orchestration (upgrade-lib.ts) with git, pnpm and docker answered by a fake
 * runner. Asserts the order of the steps, that an encrypted backup is taken, that the stack restarts only
 * when compose inputs change (files in deploy/selfhost/, selected compose files or generated
 * .state/ files), that an image is rebuilt only by an explicit `docker compose build` of a service
 * whose build inputs changed (never `up --build`), that interrupted recovery retains its original snapshot for retry, and that
 * the printed rollback selects the same box and matches whether the upgrade carried a D1 migration.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackup, runRollback } from './backup-lib.js';
import { composeFilesFor } from './compose-env.js';
import { SELFHOST_DIR } from './deploy-steps.js';
import { imageRebuilds } from './image-rebuilds.js';
import {
  type BoxContext,
  loadBox,
  type RunResult,
  runUpgrade,
  UPGRADE_PENDING_FILE,
} from './upgrade-lib.js';

vi.mock('./backup-lib.js', async (original) => ({
  ...(await original<typeof import('./backup-lib.js')>()),
  runBackup: vi.fn(),
  assertRollbackCacheReady: vi.fn(),
  runRollback: vi.fn(),
}));
vi.mock('./upgrade-migrations.js', async (original) => ({
  ...(await original<typeof import('./upgrade-migrations.js')>()),
  sourceMigrations: vi.fn(() => [{ tag: 'v1', new_sqlite_classes: ['ProjectData'] }]),
  installedMigrations: vi.fn(() => [{ tag: 'v1', new_sqlite_classes: ['ProjectData'] }]),
}));

vi.mock('./upgrade-preflight.js', () => ({ assertRollbackReady: vi.fn() }));

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
let root: string;
let steps: string[];
let logs: string[];
let diff: string[];
let dirty: boolean;
let failDeploy: boolean;
let initRewritesState: boolean;
/** What the fake checkout has checked out (`git checkout --detach` moves it). */
let head: string;
/** docker-compose.yml at each ref, and the services `docker compose config --services` lists. */
let composeAt: Record<string, string | null>;
/** Other tracked files by repository path, then ref (a selected compose overlay). */
let trackedAt: Record<string, Record<string, string>>;
let activeServices: string[];

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

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  if (command === 'docker') dockerStateEnv.push(env?.SAM_SELFHOST_STATE_DIR);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const line = `${command} ${args.join(' ')}`;
  if (command === 'git') {
    if (args[0] === 'status') return ok(dirty ? ' M apps/api/src/index.ts' : '');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(head);
    if (args[0] === 'checkout') head = args[2] ?? head;
    if (args[0] === 'rev-parse') return ok(TO);
    if (args[0] === 'diff') return ok(diff.join('\n'));
    if (args[0] === 'show') {
      const [ref = '', path = ''] = (args[1] ?? '').split(':');
      const text =
        path === 'deploy/selfhost/docker-compose.yml'
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
  if (command === 'docker' && args.includes('config')) return ok(activeServices.join('\n'));
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
  head = FROM;
  composeAt = { [FROM]: COMPOSE(), [TO]: COMPOSE() };
  trackedAt = {};
  dockerStateEnv = [];
  activeServices = ['celld', 'caddy'];
});

afterEach(() => {
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
    expect(result.rollback.join('\n')).toContain('selfhost:restore');
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
          step.includes('selfhost:restore') && step.includes('--box-env <root>/custom/box.env')
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
    expect(result.rollback.join('\n')).toContain('do not redeploy old code');
    expect(result.rollback.join('\n')).toContain('selfhost:restore');
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

  it('refuses a pending record it did not write before touching the checkout', async () => {
    writeFileSync(join(root, 'state', UPGRADE_PENDING_FILE), '{"from":"HEAD~1"}\n');
    await expect(upgrade()).rejects.toThrow(/not a record this upgrade wrote/);
    expect(steps).toEqual(['git fetch --tags origin']);
  });

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
    expect(rollback.some((step) => step.includes('selfhost:restore'))).toBe(true);
    expect(rollback.some((step) => /^docker compose .* up -d$/.test(step))).toBe(true);
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
    const composeSteps = result.rollback.filter((step) => step.includes('docker compose'));
    expect(composeSteps.map((step) => step.replaceAll(root, '<root>'))).toEqual([
      `docker compose --project-name sam-test -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
        `-f ${join(SELFHOST_DIR, 'docker-compose.override.yml')} ` +
        `--env-file <root>/real.env up -d`,
    ]);
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
    const file = join(SELFHOST_DIR, 'docker-compose.yml');
    expect(rollback.join('\n')).toContain(`--box-env '${envFile}'`);
    expect(rollback).toContain(
      `docker compose --project-name sam-test -f ${file} --env-file '${envFile}' up -d`
    );
    expect(rollback.join('\n')).toContain('empty installation');
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
    expect(rollback.indexOf(build)).toBeGreaterThan(-1);
    expect(rollback.indexOf(build)).toBeLessThan(rollback.findIndex((s) => s.endsWith(' up -d')));
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
    const printed = result.rollback.filter((step) => step.includes('docker compose'));
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.every((step) => step.startsWith(`SAM_SELFHOST_STATE_DIR=${state} docker`))).toBe(
      true
    );
  });

  it('control: sets nothing when the .env already names that state dir', async () => {
    diff = ['deploy/selfhost/caddy/Dockerfile', 'apps/api/src/db/migrations/0300_new.sql'];
    const result = await runUpgrade(box([`SAM_SELFHOST_STATE_DIR=${join(root, 'state')}`]), {
      to: 'v1',
      checkHealth: async () => true,
    });
    expect(dockerStateEnv.length).toBeGreaterThan(1);
    expect(dockerStateEnv.every((value) => value === undefined)).toBe(true);
    expect(result.rollback.some((step) => step.startsWith('docker compose'))).toBe(true);
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
    expect(rollback).toContain(
      'docker compose --project-name sam-test -f compose.yml --env-file <root>/box.env build caddy'
    );
    expect(
      rollback.indexOf(
        'docker compose --project-name sam-test -f compose.yml --env-file <root>/box.env build caddy'
      )
    ).toBeLessThan(
      rollback.indexOf(
        'docker compose --project-name sam-test -f compose.yml --env-file <root>/box.env up -d'
      )
    );
  });

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
