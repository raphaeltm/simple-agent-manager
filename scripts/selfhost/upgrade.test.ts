/**
 * selfhost:upgrade orchestration (upgrade-lib.ts) with git, pnpm and docker answered by a fake
 * runner. Asserts the order of the steps, that no backup is taken, that the stack restarts only
 * when compose inputs change (files in deploy/selfhost/, selected compose files or generated
 * .state/ files), that an image is rebuilt only by an explicit `docker compose build` of a service
 * whose build inputs changed (never `up --build`), that a failed upgrade can be retried, and that
 * the printed rollback selects the same box and matches whether the upgrade carried a D1 migration.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

function run(command: string, args: string[]): RunResult {
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
          : ref === TO
            ? FILES_AT_TO[path]
            : undefined;
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
    box: { CELLD_BUCKET: 'gs://fleet/celld', SAM_DOMAIN: 'box.example' },
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
  head = FROM;
  composeAt = { [FROM]: COMPOSE(), [TO]: COMPOSE() };
  activeServices = ['celld', 'caddy'];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The deploy arguments the fake box (ctx()) must be deployed with. */
const BOX_ARGS = '--env-file <root>/box.env --state-dir <root>/state';
const compact = () =>
  steps.map((s) => (s.startsWith('docker compose') ? s.replace(/ -f .* --env-file \S+/, '') : s));

describe('runUpgrade', () => {
  it('checks out, migrates and deploys with no backup, and leaves the stack running when compose inputs are unchanged', async () => {
    const result = await upgrade();
    // No backup step: nothing touches the bucket and the celld container is never stopped.
    expect(compact()).toEqual([
      'git fetch --tags origin',
      `git checkout --detach ${TO}`,
      'pnpm install --frozen-lockfile',
      `pnpm selfhost:deploy --init ${BOX_ARGS}`,
      `pnpm selfhost:deploy ${BOX_ARGS}`,
    ]);
    expect(result.composeRestarted).toBe(false);
    expect(logs.join('\n')).toContain('no backup is taken');
    expect(result.rollback.map((step) => step.replaceAll(root, '<root>'))).toEqual([
      `git checkout ${FROM}`,
      'pnpm install --frozen-lockfile',
      `pnpm selfhost:deploy ${BOX_ARGS}`,
    ]);
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
    writeFileSync(envFile, 'CELLD_BUCKET=gs://fleet/celld\n', { mode: 0o600 });
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
    expect(rollback).toContain(`pnpm selfhost:deploy ${expected} --init`);
    expect(rollback).toContain(`pnpm selfhost:deploy ${expected}`);
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
    expect(result.rollback.join('\n')).toContain('do NOT redeploy the old Worker');
    expect(result.rollback.join('\n')).toContain('The upgrade took no backup');
    // There is no restore command to point at in this version.
    expect(result.rollback.join('\n')).not.toContain('selfhost:restore');
  });

  it('stops at a failed deploy and prints the rollback', async () => {
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/migration 0219 failed/);
    expect(logs.join('\n')).toContain('to roll back:');
    expect(logs.join('\n')).toContain(`git checkout ${FROM}`);
  });

  // The failed run leaves the checkout at the target: equal refs must not read as "deployed".
  it('retries a failed upgrade with the same --to, from the ref deployed before it', async () => {
    failDeploy = true;
    await expect(upgrade()).rejects.toThrow(/migration 0219 failed/);
    expect(head).toBe(TO);
    expect(existsSync(join(root, 'state', UPGRADE_PENDING_FILE))).toBe(true);

    failDeploy = false;
    steps = [];
    const retry = await upgrade();
    expect(compact()).toEqual([
      'git fetch --tags origin',
      `git checkout --detach ${TO}`,
      'pnpm install --frozen-lockfile',
      `pnpm selfhost:deploy --init ${BOX_ARGS}`,
      // The failed run may have restarted the stack already, so the retry restarts it too.
      'docker compose up -d',
      `pnpm selfhost:deploy ${BOX_ARGS}`,
    ]);
    expect(retry.from).toBe(FROM);
    expect(retry.rollback[0]).toBe(`git checkout ${FROM}`);
    expect(existsSync(join(root, 'state', UPGRADE_PENDING_FILE))).toBe(false);

    // Control: once it has succeeded, the same --to is a no-op.
    steps = [];
    expect((await upgrade()).rollback).toEqual([]);
    expect(steps).toEqual(['git fetch --tags origin']);
    expect(logs.at(-1)).toBe('already at that ref; nothing to do');
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
    await expect(upgrade()).rejects.toThrow(/migration 0219 failed/);
    const printed = logs.join('\n').replaceAll(root, '<root>');
    expect(printed).toContain(`pnpm selfhost:deploy ${BOX_ARGS} --init`);
    expect(printed).toMatch(/docker compose .* up -d$/m);

    // A fresh box at FROM for the success case.
    rmSync(join(root, 'state', UPGRADE_PENDING_FILE));
    writeFileSync(join(root, 'state/gateway.env'), 'FRPS_PORT_RANGE=20000-29999\n');
    head = FROM;
    failDeploy = false;
    const rollback = (await upgrade()).rollback.map((step) => step.replaceAll(root, '<root>'));
    expect(rollback).toContain(`pnpm selfhost:deploy ${BOX_ARGS} --init`);
    expect(rollback.some((step) => /^docker compose .* up -d$/.test(step))).toBe(true);
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

// Seen on a box, 2026-11-12: .env had COMPOSE_FILE listing an override file. The upgrade's
// `docker compose -f docker-compose.yml up -d --build` replaced that list and recreated celld
// without what the override added.
// S4: the box's ports are checked against the lease range when the upgrade loads the box, before it
// fetches, checks out or runs docker compose (not only inside Caddy's start.sh once it is up).
describe('loadBox refuses a box port inside the lease range', () => {
  const envWith = (line: string) => {
    const envFile = join(root, 'ports.env');
    writeFileSync(envFile, `CELLD_BUCKET=gs://fleet/celld\n${line}\n`, { mode: 0o600 });
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
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml']);
    await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    expect(restartCommand()).toBe(
      `docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
        `-f ${join(SELFHOST_DIR, 'docker-compose.override.yml')} ` +
        `--env-file <root>/real.env up -d`
    );
  });

  it('uses docker-compose.yml alone when COMPOSE_FILE is unset (control)', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv([]);
    await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    expect(restartCommand()).toBe(
      `docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} --env-file <root>/real.env up -d`
    );
  });

  it('prints rollback compose steps for the selected box: its .env and every compose file', async () => {
    diff = ['deploy/selfhost/docker-compose.yml'];
    const ctx = boxFromEnv(['COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml']);
    const result = await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    const composeSteps = result.rollback.filter((step) => step.includes('docker compose'));
    expect(composeSteps.map((step) => step.replaceAll(root, '<root>'))).toEqual([
      `docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
        `-f ${join(SELFHOST_DIR, 'docker-compose.override.yml')} ` +
        `--env-file <root>/real.env up -d`,
    ]);
  });

  it('selects the same box in the restore-based rollback, quoting a path with a space', async () => {
    diff = ['apps/api/src/db/migrations/0300_new.sql'];
    const envFile = join(root, 'my box.env');
    writeFileSync(envFile, 'CELLD_BUCKET=gs://fleet/celld\n', { mode: 0o600 });
    const ctx = { ...loadBox(envFile, join(root, 'state')), run, log: (m: string) => logs.push(m) };
    const { rollback } = await runUpgrade(ctx, { to: 'v1', checkHealth: async () => true });
    const file = join(SELFHOST_DIR, 'docker-compose.yml');
    expect(rollback).toContain(`docker compose -f ${file} --env-file '${envFile}' down`);
    expect(rollback).toContain(`docker compose -f ${file} --env-file '${envFile}' up -d`);
    expect(rollback.join('\n')).toContain(`Point CELLD_BUCKET in ${envFile} at a new`);
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
      `docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} ` +
      `-f ${join(SELFHOST_DIR, 'docker-compose.override.yml')} ` +
      `--env-file <root>/real.env build caddy`;
    expect(steps).toContain(build);
    const rollback = result.rollback.map((step) => step.replaceAll(root, '<root>'));
    expect(rollback.indexOf(build)).toBeGreaterThan(-1);
    expect(rollback.indexOf(build)).toBeLessThan(rollback.findIndex((s) => s.endsWith(' up -d')));
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
    expect(result.rollback.map((step) => step.replaceAll(root, '<root>'))).toEqual([
      `git checkout ${FROM}`,
      'pnpm install --frozen-lockfile',
      `pnpm selfhost:deploy ${BOX_ARGS} --init`,
      'docker compose -f compose.yml --env-file <root>/box.env build caddy',
      'docker compose -f compose.yml --env-file <root>/box.env up -d',
      `pnpm selfhost:deploy ${BOX_ARGS}`,
    ]);
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
    await expect(upgrade()).rejects.toThrow(/migration 0219 failed/);
    const printed = logs.join('\n').replaceAll(root, '<root>');
    expect(printed).toContain(
      'docker compose -f compose.yml --env-file <root>/box.env build caddy'
    );
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
