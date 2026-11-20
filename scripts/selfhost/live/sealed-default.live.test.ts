/**
 * Sealed secrets by default, end to end on the real runtime: celld 0.6.3 (pinned) over the
 * box's object store (the pinned MinIO image), the key agent as its real container image
 * (deploy/selfhost/key-agent/Dockerfile) started the way docker-compose.yml starts it, the real
 * `deploy.ts --init`, and `pnpm selfhost:secrets migrate`'s orchestration (secrets-migrate.ts)
 * with its real contract check.
 *
 * As in the spike's live test, the Worker is a probe, not the SAM API: in sealed mode it is
 * wrapped by the same runtime-secrets module the API's celld entry uses, with the vars
 * `deploy.ts` renders for this box (read from its --dry-run); in legacy mode it gets the secrets
 * as plain vars, as a pre-sealing deploy did. It answers the SHA-256 of ENCRYPTION_KEY.
 *
 * Proves, on an existing install that ran on plaintext deploy vars: the agent container runs as
 * the owner of .state from the start, never root, with no capabilities, and refuses to start as
 * root (finding F10); a migration that breaks after the switch rolls back to plaintext deploy
 * vars; a working one leaves a clean current version, keeps the plaintext files until a key copy
 * is proven, then removes them; the old plaintext version is listed and nothing is deleted
 * (F10: no purge); `secrets reseal` (the switch path) moves the install to a new bundle without a
 * gap and it keeps serving.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCommand } from '../backup-cli';
import type { BoxContext } from '../backup-lib';
import { ensureCelldBinary } from '../celld-binary.js';
import { pingKeyAgent } from '../../../deploy/selfhost/key-agent/healthcheck.ts';
import { CLOSED_HOST, noStackDocker, runDeploy as harnessRunDeploy } from '../deploy-harness.js';
import { knownSecrets, scanDeployVersions } from '../plaintext-scan';
import { ensurePlatformKeys } from '../platform-keys';
import { parseDotenv, readPrivateJson } from '../secret-files';
import { type MigrateDeps, runMigration } from '../secrets-migrate';
import { preflightSealedSecrets } from '../secrets-preflight';
import { runSwitch } from '../secrets-switch';
import {
  type CelldNode,
  celldNode,
  type ObjectStore,
  startObjectStore,
  writeProject,
} from './celld-lab';
import { freePort, hasDocker, LIVE_TMP, REPO_ROOT, type Running, waitFor } from './harness';

const KEY = 'sam-live-default';
const SECRET = 'live-default-store-0123456789';
const IMAGE = 'sam-selfhost-key-agent:live-test';
/** What the generated celld entry imports on a sealed box (scripts/selfhost/celld-project.ts). */
const RUNTIME_SECRETS = join(REPO_ROOT, 'apps/api/src/selfhost/runtime-secrets-socket.ts');
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

/** The real deploy entry; its init finds an existing install, and no stack runs in this lab. */
const runDeploy = (envFile: string, args: string[]) =>
  harnessRunDeploy(envFile, args, noStackDocker(root));

let root = '';
let state = '';
let envFile = '';
let store: ObjectStore | undefined;
let node: CelldNode;
let agentPort = 0;
let agentContainer = '';
let celld: Running | undefined;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const box = () => parseDotenv(readFileSync(envFile, 'utf8'), envFile);

function ctx(): BoxContext {
  return {
    box: box(),
    envFile,
    stateDir: state,
    composeFiles: [],
    run: runCommand,
    now: () => Date.now(),
    log: () => undefined,
    user: `${uid}:${process.getgid?.()}`,
  };
}

function celldDeploy(name: string, worker: string, vars: Record<string, string>): void {
  const project = writeProject(join(root, `project-${name}-${Date.now()}`), {
    name: 'workspaces-api',
    worker,
    vars,
  });
  const result = node.deploy(project);
  expect(result.status, result.stderr + result.stdout).toBe(0);
}

const PROBE = `
async function answer(env) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.ENCRYPTION_KEY ?? '')));
  return Response.json({ sha: [...d].map((b) => b.toString(16).padStart(2, '0')).join('') });
}`;

/** The pre-sealing deploy: every secret a plain var. */
function deployLegacy(): void {
  const secrets = {
    ...readPrivateJson(join(state, 'platform-keys.json')),
    ...parseDotenv(readFileSync(join(state, 'secrets.env'), 'utf8'), 'secrets.env'),
  };
  celldDeploy('legacy', `${PROBE}\nexport default { fetch: (_r, env) => answer(env) };`, secrets);
}

/** The sealed deploy: the vars deploy.ts renders for this box, the runtime-secrets wrapper. */
async function deploySealed(): Promise<void> {
  const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
  expect(dry.status, dry.out).toBe(0);
  const vars = (
    JSON.parse(dry.out.slice(dry.out.indexOf('{\n'))) as { vars: Record<string, string> }
  ).vars;
  const keep = [
    'SAM_KEY_AGENT_ADDRESS',
    'SAM_SECRET_BUNDLE_ID',
    'SAM_KEY_AGENT_VERIFY_KEY',
    'SAM_INSTALLATION_ID',
  ];
  celldDeploy(
    'sealed',
    `import { wrapWorker } from ${JSON.stringify(RUNTIME_SECRETS)};\n${PROBE}\nexport default wrapWorker({ fetch: (_r, env) => answer(env) });`,
    Object.fromEntries(keep.map((name) => [name, vars[name] ?? '']))
  );
}

function stopAgent(): void {
  if (agentContainer) spawnSync('docker', ['rm', '-f', agentContainer]);
  agentContainer = '';
}

/** `docker run` arguments for the key-agent service as docker-compose.yml runs it. */
function agentArgs(user: string): string[] {
  return [
    'run',
    '-d',
    '--network',
    'host',
    '--user',
    user,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--env-file',
    join(state, 'key-agent/agent.env'),
    '-e',
    `SAM_KEY_AGENT_ALLOWED_UIDS=${uid}`,
    '-e',
    'SAM_KEY_AGENT_STATE_DIR=/etc/sam/key-agent',
    '-v',
    `${join(state, 'key-agent')}:/etc/sam/key-agent:ro`,
    IMAGE,
  ];
}

/** The key-agent service as docker-compose.yml runs it: SAM_KEY_AGENT_UID, no capabilities. */
async function startAgent(): Promise<void> {
  stopAgent();
  const run = spawnSync('docker', agentArgs(`${uid}:${gid}`), { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  agentContainer = run.stdout.trim();
  await waitFor(
    'the key agent container',
    async () => (await pingKeyAgent(agentPort).catch(() => null))?.sealed === true,
    60_000,
    () => spawnSync('docker', ['logs', agentContainer], { encoding: 'utf8' }).stdout
  );
}

async function adoptAndCheck(): Promise<{ healthy: boolean; detail: string }> {
  const reload = await fetch(`http://127.0.0.1:${node.internalPort}/reload`, {
    method: 'POST',
  }).catch(() => null);
  if (!reload?.ok) return { healthy: false, detail: `reload ${reload?.status ?? 'failed'}` };
  const response = await fetch(`http://127.0.0.1:${node.port}/`).catch(() => null);
  if (!response) return { healthy: false, detail: 'no response' };
  const body = (await response.json()) as { sha?: string; code?: string };
  const expected = sha256(
    (readPrivateJson(join(state, 'platform-keys.json')).ENCRYPTION_KEY as string | undefined) ??
      'gone'
  );
  return response.ok && body.sha === expected
    ? { healthy: true, detail: 'HTTP 200' }
    : { healthy: false, detail: `HTTP ${response.status} ${body.code ?? ''}` };
}

function deps(log: string[], breakAgent = false): MigrateDeps {
  return {
    log: (m) => log.push(m),
    init: async () => {
      const init = await runDeploy(envFile, ['--init']);
      if (init.status !== 0) throw new Error(init.out);
    },
    preflight: preflightSealedSecrets,
    startStack: startAgent,
    deploy: async (legacy) => {
      if (legacy) return deployLegacy();
      if (breakAgent) stopAgent(); // the switch meets a key agent that is gone
      await deploySealed();
    },
    adoptAndCheck,
    currentVersionSecrets: async () => {
      const versions = scanDeployVersions(ctx(), await knownSecrets(box(), state));
      return (
        versions.find((v) => v.referencedBy.includes('deploy/current.json'))?.secretNames ?? []
      );
    },
  };
}

describe.skipIf(!hasDocker && !process.env.CI)('sealed secrets by default on celld', () => {
  beforeAll(async () => {
    agentPort = await freePort();
    store = await startObjectStore(KEY, SECRET);
    node = await celldNode(
      await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')),
      store,
      's3://fleet/celld'
    );
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'sealed-default-'));
    state = join(root, '.state');
    envFile = join(root, '.env');
    writeFileSync(
      envFile,
      [
        'SAM_DOMAIN=sam.example.com',
        'SAM_TLS_MODE=internal',
        'COMPOSE_PROFILES=tunnel,local-store',
        'CELLD_BUCKET=s3://fleet/celld',
        `S3_ENDPOINT=${store.url}`,
        `AWS_ACCESS_KEY_ID=${KEY}`,
        `AWS_SECRET_ACCESS_KEY=${SECRET}`,
        `SAM_KEY_AGENT_PORT=${agentPort}`,
        `SAM_KEY_AGENT_UID=${uid}`,
        `CELLD_PORT=${node.port}`,
        `CELLD_INTERNAL_PORT=${node.internalPort}`,
        `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
        `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
        `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
    // A box from before sealed secrets: plaintext platform keys and operator secrets.
    mkdirSync(state, { mode: 0o700 });
    ensurePlatformKeys(state, 'init');
    writeFileSync(
      join(state, 'secrets.env'),
      `GITHUB_CLIENT_SECRET=${randomBytes(16).toString('hex')}\n`,
      {
        mode: 0o600,
      }
    );

    const build = spawnSync(
      'docker',
      ['build', '-q', '-t', IMAGE, join(REPO_ROOT, 'deploy/selfhost/key-agent')],
      { encoding: 'utf8' }
    );
    expect(build.status, build.stderr).toBe(0);
    celld = node.start();
    deployLegacy();
    await waitFor(
      'the legacy install to serve',
      async () => (await adoptAndCheck()).healthy,
      120_000,
      () => celld?.output() ?? ''
    );
  }, 600_000);

  afterAll(async () => {
    stopAgent();
    await celld?.stop();
    store?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('rolls back to plaintext deploy vars when the first request after the switch is not healthy', async () => {
    const log: string[] = [];
    await expect(runMigration({ box: box(), stateDir: state }, deps(log, true))).rejects.toThrow(
      /rolled back: the new version is not healthy: HTTP 503 KEY_AGENT_UNREACHABLE/
    );
    expect(log.join('\n')).toContain(
      'rolled back: the install runs on plaintext deploy vars again'
    );
    expect((await adoptAndCheck()).healthy).toBe(true);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
  }, 600_000);

  it('the agent container runs as the owner of .state, never root, and refuses root', async () => {
    await startAgent();
    const top = spawnSync('docker', ['top', agentContainer, '-o', 'pid,uid,comm'], {
      encoding: 'utf8',
    });
    expect(top.stdout).toMatch(new RegExp(`\\n\\s*\\d+\\s+${uid}\\s+node`));
    expect(top.stdout).not.toMatch(/\n\s*\d+\s+0\s+node/);
    const caps = spawnSync(
      'docker',
      ['inspect', '-f', '{{json .HostConfig.CapAdd}}', agentContainer],
      {
        encoding: 'utf8',
      }
    );
    expect(caps.stdout.trim()).toBe('null');
    // F10 control: the same image started as root exits with the reason, serving nothing.
    const root = spawnSync('docker', [...agentArgs('0:0').filter((a) => a !== '-d'), '--rm'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(root.status).not.toBe(0);
    expect(`${root.stdout}${root.stderr}`).toContain('the key agent must not run as root');
  }, 120_000);

  it('migrates: clean current version, files kept until a key copy is proven, then removed', async () => {
    const keys = readPrivateJson(join(state, 'platform-keys.json'));
    const log: string[] = [];
    expect(await runMigration({ box: box(), stateDir: state }, deps(log))).toBe(
      'migrated-files-kept'
    );
    expect(log.join('\n')).toContain('KEY FILE CREATED');
    const response = await fetch(`http://127.0.0.1:${node.port}/`);
    expect(await response.json()).toEqual({ sha: sha256(keys.ENCRYPTION_KEY ?? '') });

    const copy = join(root, 'kek-copy');
    writeFileSync(copy, readFileSync(join(state, 'key-agent/kek')), { mode: 0o600 });
    const finishing = deps([]);
    finishing.adoptAndCheck = async () => {
      const reload = await fetch(`http://127.0.0.1:${node.internalPort}/reload`, {
        method: 'POST',
      });
      const r = await fetch(`http://127.0.0.1:${node.port}/`);
      const body = (await r.json()) as { sha?: string };
      return {
        healthy: reload.ok && r.ok && body.sha === sha256(keys.ENCRYPTION_KEY ?? ''),
        detail: `HTTP ${r.status}`,
      };
    };
    expect(await runMigration({ box: box(), stateDir: state, keyCopy: copy }, finishing)).toBe(
      'migrated'
    );
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
    expect(existsSync(join(state, 'secrets.env'))).toBe(false);

    // Every secret still known (from the bundle alone); the old plaintext version is listed
    // (names only) and nothing is deleted (F10: no purge); the current one is clean.
    const secrets = await knownSecrets(box(), state);
    expect(secrets.values).toContain(keys.ENCRYPTION_KEY);
    const versions = scanDeployVersions(ctx(), secrets);
    const plaintext = versions.filter((v) => v.secretNames.length > 0);
    expect(plaintext.length).toBeGreaterThanOrEqual(1);
    expect(
      versions.find((v) => v.referencedBy.includes('deploy/current.json'))?.secretNames
    ).toEqual([]);
    expect(scanDeployVersions(ctx(), secrets).map((v) => v.prefix)).toEqual(
      versions.map((v) => v.prefix)
    );
    expect((await finishing.adoptAndCheck()).healthy).toBe(true);
  }, 600_000);

  it('reseal (the switch path) moves the running install to a new bundle and keeps serving', async () => {
    const served = async () =>
      ((await (await fetch(`http://127.0.0.1:${node.port}/`)).json()) as { sha?: string }).sha;
    const shaBefore = await served();
    expect(shaBefore).toMatch(/^[0-9a-f]{64}$/);
    const before = readdirSync(join(state, 'key-agent/bundles'));
    const log: string[] = [];
    const healthyOnNewBundle = async () => {
      const reload = await fetch(`http://127.0.0.1:${node.internalPort}/reload`, {
        method: 'POST',
      });
      const sha = await served();
      return { healthy: reload.ok && sha === shaBefore, detail: `sha ${sha}` };
    };
    await runSwitch(
      { box: box(), stateDir: state, to: null },
      {
        log: (m) => log.push(m),
        detect: async () => ({ platform: null, candidates: [] }),
        restartAgent: startAgent,
        deploy: deploySealed,
        adoptAndCheck: healthyOnNewBundle,
      }
    );
    const added = readdirSync(join(state, 'key-agent/bundles')).filter((n) => !before.includes(n));
    expect(added).toHaveLength(1);
    expect(existsSync(join(state, 'key-agent/previous.env'))).toBe(false);
    expect(log.join('\n')).toContain('done: the box seals with file');
    // The Worker now names the new bundle and still gets the same ENCRYPTION_KEY.
    const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
    expect(dry.out).toContain(`"SAM_SECRET_BUNDLE_ID": "${added[0]?.replace('.json', '')}"`);
    expect(await served()).toBe(shaBefore);
  }, 600_000);
});
