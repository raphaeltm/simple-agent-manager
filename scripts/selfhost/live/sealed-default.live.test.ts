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
 * Proves: the agent container drops from root to the owner of .state/key-agent and serves
 * celld's uid only; a migration that breaks after the switch rolls back to plaintext deploy vars;
 * a working one leaves a clean current version, keeps the plaintext files until a key copy is
 * proven, then removes them; the old plaintext version is then listed and purged.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCommand } from '../backup-cli';
import { type BoxContext, OBJECTSTORE_IMAGE } from '../backup-lib';
import { ensureCelldBinary, resolveEsbuild } from '../celld-binary.js';
import { CLOSED_HOST, runDeploy } from '../deploy-harness.js';
import { knownSecrets, purgeVersions, scanDeployVersions } from '../plaintext-scan';
import { ensurePlatformKeys } from '../platform-keys';
import { parseDotenv, readPrivateJson } from '../secret-files';
import { type MigrateDeps, runMigration } from '../secrets-migrate';
import { preflightSealedSecrets } from '../secrets-preflight';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, start, waitFor } from './harness';

const KEY = 'sam-live-default';
const SECRET = 'live-default-store-0123456789';
const IMAGE = 'sam-selfhost-key-agent:live-test';
const RUNTIME_SECRETS = join(REPO_ROOT, 'apps/api/src/selfhost/runtime-secrets.ts');
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const uid = process.getuid?.() ?? 0;

let root = '';
let state = '';
let envFile = '';
let store = '';
let agentContainer = '';
let binary = '';
let celld: Running | undefined;
let ports: { store: number; celld: number; internal: number; agent: number };

const storeEnv = () => ({
  AWS_ACCESS_KEY_ID: KEY,
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_REGION: 'us-east-1',
});
const bucketArgs = () => [
  '--bucket',
  's3://fleet/celld',
  '--endpoint',
  `http://127.0.0.1:${ports.store}`,
];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const box = () => parseDotenv(readFileSync(envFile, 'utf8'), envFile);

function ctx(): BoxContext {
  return {
    box: box(),
    envFile,
    stateDir: state,
    composeFile: '',
    run: runCommand,
    now: () => Date.now(),
    log: () => undefined,
    user: `${uid}:${process.getgid?.()}`,
  };
}

function celldDeploy(name: string, worker: string, vars: Record<string, string>): void {
  const project = join(root, `project-${name}-${Date.now()}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'worker.js'), worker);
  writeFileSync(
    join(project, 'wrangler.json'),
    JSON.stringify({
      name: 'workspaces-api',
      main: 'worker.js',
      compatibility_date: '2026-01-01',
      vars,
    })
  );
  const result = spawnSync(binary, ['deploy', project, ...bucketArgs()], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...storeEnv(),
      CELLD_ESBUILD: resolveEsbuild(join(REPO_ROOT, 'apps/api')),
    },
  });
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
    'SAM_KEY_AGENT_URL',
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

/** The key-agent service as docker-compose.yml runs it: root with SETUID/SETGID only, read-only. */
async function startAgent(): Promise<void> {
  stopAgent();
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--network',
      'host',
      '--user',
      '0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'SETUID',
      '--cap-add',
      'SETGID',
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
    ],
    { encoding: 'utf8' }
  );
  expect(run.status, run.stderr).toBe(0);
  agentContainer = run.stdout.trim();
  await waitFor(
    'the key agent container',
    async () => {
      const r = await fetch(`http://127.0.0.1:${ports.agent}/healthz`).catch(() => null);
      return r?.ok ? ((await r.json()) as { sealed?: boolean }).sealed !== false : false;
    },
    60_000,
    () => spawnSync('docker', ['logs', agentContainer], { encoding: 'utf8' }).stdout
  );
}

async function adoptAndCheck(): Promise<{ healthy: boolean; detail: string }> {
  const reload = await fetch(`http://127.0.0.1:${ports.internal}/reload`, { method: 'POST' }).catch(
    () => null
  );
  if (!reload?.ok) return { healthy: false, detail: `reload ${reload?.status ?? 'failed'}` };
  const response = await fetch(`http://127.0.0.1:${ports.celld}/`).catch(() => null);
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
    ports = {
      store: await freePort(),
      celld: await freePort(),
      internal: await freePort(),
      agent: await freePort(),
    };
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
        `S3_ENDPOINT=http://127.0.0.1:${ports.store}`,
        `AWS_ACCESS_KEY_ID=${KEY}`,
        `AWS_SECRET_ACCESS_KEY=${SECRET}`,
        `SAM_KEY_AGENT_PORT=${ports.agent}`,
        `CELLD_PORT=${ports.celld}`,
        `CELLD_INTERNAL_PORT=${ports.internal}`,
        `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
        `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
        `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
    // A box from before sealed secrets: plaintext platform keys and operator secrets.
    mkdirSync(state, { mode: 0o700 });
    ensurePlatformKeys(join(state, 'platform-keys.json'));
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
    const minio = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--network',
        'host',
        '-e',
        `MINIO_ROOT_USER=${KEY}`,
        '-e',
        `MINIO_ROOT_PASSWORD=${SECRET}`,
        '--entrypoint',
        'minio',
        OBJECTSTORE_IMAGE,
        'server',
        '/data',
        '--address',
        `127.0.0.1:${ports.store}`,
        '--console-address',
        `127.0.0.1:${await freePort()}`,
      ],
      { encoding: 'utf8' }
    );
    expect(minio.status, minio.stderr).toBe(0);
    store = minio.stdout.trim();
    await waitFor(
      'object store',
      async () =>
        (await fetch(`http://127.0.0.1:${ports.store}/minio/health/live`).catch(() => null))?.ok
    );
    const mb = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '-e',
        `MC_HOST_src=http://${KEY}:${SECRET}@127.0.0.1:${ports.store}`,
        '-e',
        'MC_CONFIG_DIR=/tmp/mc',
        '--entrypoint',
        'mc',
        OBJECTSTORE_IMAGE,
        'mb',
        'src/fleet',
      ],
      { encoding: 'utf8' }
    );
    expect(mb.status, mb.stderr).toBe(0);
    binary = await ensureCelldBinary(join(LIVE_TMP, 'celld-bin'));
    celld = start(
      binary,
      [
        ...bucketArgs(),
        '--listen',
        `127.0.0.1:${ports.celld}`,
        '--internal-listen',
        `127.0.0.1:${ports.internal}`,
      ],
      storeEnv()
    );
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
    if (store) spawnSync('docker', ['rm', '-f', store]);
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

  it('the agent container drops from root to the owner of .state/key-agent', async () => {
    await startAgent();
    const top = spawnSync('docker', ['top', agentContainer, '-o', 'pid,uid,comm'], {
      encoding: 'utf8',
    });
    expect(top.stdout).toMatch(new RegExp(`\\n\\s*\\d+\\s+${uid}\\s+node`));
    expect(top.stdout).not.toMatch(/\n\s*\d+\s+0\s+node/);
    // Its own start-up log says so (server.ts dropToOwnerOf); peer refusal: key-agent-celld.live.
    const logs = spawnSync('docker', ['logs', agentContainer], { encoding: 'utf8' });
    expect(logs.stdout).toContain(`"event":"key_agent.dropped_root","uid":${uid}`);
  }, 120_000);

  it('migrates: clean current version, files kept until a key copy is proven, then removed', async () => {
    const keys = readPrivateJson(join(state, 'platform-keys.json'));
    const log: string[] = [];
    expect(await runMigration({ box: box(), stateDir: state }, deps(log))).toBe(
      'migrated-files-kept'
    );
    expect(log.join('\n')).toContain('KEY FILE CREATED');
    const response = await fetch(`http://127.0.0.1:${ports.celld}/`);
    expect(await response.json()).toEqual({ sha: sha256(keys.ENCRYPTION_KEY ?? '') });

    const copy = join(root, 'kek-copy');
    writeFileSync(copy, readFileSync(join(state, 'key-agent/kek')), { mode: 0o600 });
    const finishing = deps([]);
    finishing.adoptAndCheck = async () => {
      const reload = await fetch(`http://127.0.0.1:${ports.internal}/reload`, { method: 'POST' });
      const r = await fetch(`http://127.0.0.1:${ports.celld}/`);
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
    // and purged; the current one is clean and keeps serving.
    const secrets = await knownSecrets(box(), state);
    expect(secrets.values).toContain(keys.ENCRYPTION_KEY);
    const before = scanDeployVersions(ctx(), secrets);
    expect(before.filter((v) => v.secretNames.length > 0).length).toBeGreaterThanOrEqual(1);
    const result = purgeVersions(ctx(), secrets, 's3://fleet/celld');
    expect(result.deleted.length).toBeGreaterThanOrEqual(1);
    expect(scanDeployVersions(ctx(), secrets).every((v) => v.secretNames.length === 0)).toBe(true);
    expect((await finishing.adoptAndCheck()).healthy).toBe(true);
  }, 600_000);
});
