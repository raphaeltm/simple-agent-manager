/**
 * `rotate encryption-key` end to end on the real runtime: celld 0.6.3 (pinned) over the box's
 * object store (the pinned MinIO image), the key agent as its real container image, and the real
 * orchestrator (rotate-run.ts) driving the real control endpoint over loopback HTTP with the real
 * signing (rotate-box-deps.ts `control`).
 *
 * As in the other live tests the Worker is a probe, not the whole SAM API: it is wrapped by the
 * same runtime-secrets module the API's celld entry uses (so it gets the read fallback and the
 * control path exactly as the API does), binds a real celld D1 database and R2 bucket, and seeds
 * and reads credentials with the app's own encrypt/decrypt and file encryption.
 *
 * Proves on celld: rows and a library file encrypted under the old key are re-encrypted online
 * and stay readable throughout; an interruption mid-migration resumes; after the final reseal the
 * Worker reads everything with the new key alone, the control endpoint is gone, and no deploy
 * manifest in the bucket holds either key.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sealSecrets } from '../../../deploy/selfhost/key-agent/bundle.ts';
import { createKeyProvider } from '../../../deploy/selfhost/key-agent/providers.ts';
import { runCommand } from '../backup-cli';
import { type BoxContext, OBJECTSTORE_IMAGE } from '../backup-lib';
import { ensureCelldBinary, resolveEsbuild } from '../celld-binary.js';
import { KEY_CHOICE_FORMAT, writeKeyChoice } from '../key-choice';
import {
  agentVerifyKey,
  ensureKeyServiceFiles,
  generateAgentSigningKey,
  keyAgentUrl,
  keyServiceSettings,
} from '../key-service';
import { completePlatformKeys } from '../platform-keys';
import type { RotateDeps } from '../rotate-apply';
import { boxRotateDeps } from '../rotate-box-deps';
import { runRotate } from '../rotate-run';
import { openRotationStore, readJournal } from '../rotate-store';
import { parseDotenv } from '../secret-files';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, start, waitFor } from './harness';

const KEY = 'sam-live-rotate';
const SECRET = 'live-rotate-store-0123456789';
const IMAGE = 'sam-selfhost-key-agent:live-test';
const API_SRC = join(REPO_ROOT, 'apps/api/src');
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const uid = process.getuid?.() ?? 0;
const ROWS = 30;

let root = '';
let state = '';
let envFile = '';
let store = '';
let agentContainer = '';
let binary = '';
let celld: Running | undefined;
let ports: { store: number; celld: number; internal: number; agent: number };

const box = () => parseDotenv(readFileSync(envFile, 'utf8'), envFile);
const bucketArgs = () => [
  '--bucket',
  's3://fleet/celld',
  '--endpoint',
  `http://127.0.0.1:${ports.store}`,
];
const storeEnv = () => ({
  AWS_ACCESS_KEY_ID: KEY,
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_REGION: 'us-east-1',
});

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

/** The probe: the API's runtime-secrets wrapper around a Worker that seeds and reads credentials. */
const PROBE = `
import { wrapWorker } from ${JSON.stringify(join(API_SRC, 'selfhost/runtime-secrets.ts'))};
import { D1_LOCATIONS } from ${JSON.stringify(join(API_SRC, 'selfhost/key-rotation/d1-locations.ts'))};
import { decrypt, encrypt } from ${JSON.stringify(join(API_SRC, 'services/encryption.ts'))};
import { decryptFile, encryptFile, metadataToR2CustomMetadata, r2CustomMetadataToMetadata } from ${JSON.stringify(join(API_SRC, 'services/file-encryption.ts'))};

async function setup(env) {
  for (const location of D1_LOCATIONS) {
    const columns = location.pairs.flatMap((p) => [p.ciphertext + ' TEXT', p.iv + ' TEXT']).join(', ');
    await env.DATABASE.prepare('CREATE TABLE IF NOT EXISTS ' + location.table + ' (id TEXT PRIMARY KEY, ' + columns + ')').run();
  }
  await env.DATABASE.prepare('CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, placement_credential_fingerprint TEXT)').run();
  for (let i = 0; i < ${ROWS}; i += 1) {
    const sealed = await encrypt('secret-' + i, env.ENCRYPTION_KEY);
    await env.DATABASE.prepare('INSERT INTO credentials (id, encrypted_token, iv) VALUES (?, ?, ?)')
      .bind('c-' + String(i).padStart(3, '0'), sealed.ciphertext, sealed.iv).run();
  }
  const file = await encryptFile(new TextEncoder().encode('library body').buffer, env.ENCRYPTION_KEY);
  await env.R2.put('library/p1/f1', file.ciphertext, { customMetadata: metadataToR2CustomMetadata(file.metadata) });
  return Response.json({ ok: true });
}

async function read(env) {
  const { results } = await env.DATABASE.prepare('SELECT id, encrypted_token, iv FROM credentials ORDER BY id').all();
  const values = [];
  for (const row of results) values.push(await decrypt(row.encrypted_token, row.iv, env.ENCRYPTION_KEY));
  const object = await env.R2.get('library/p1/f1');
  const body = await decryptFile(await object.arrayBuffer(), r2CustomMetadataToMetadata(object.customMetadata), env.ENCRYPTION_KEY);
  return Response.json({ values, file: new TextDecoder().decode(body), rotating: Boolean(env.ENCRYPTION_KEY_PREVIOUS) });
}

export default wrapWorker({
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/setup') return await setup(env);
    if (path === '/read') return await read(env);
    return Response.json({ ok: true });
  },
});
`;

async function deployProbe(): Promise<void> {
  const head = await openRotationStore(box(), state).head();
  const project = join(root, `project-${Date.now()}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'worker.ts'), PROBE);
  writeFileSync(
    join(project, 'wrangler.json'),
    JSON.stringify({
      name: 'workspaces-api',
      main: 'worker.ts',
      compatibility_date: '2026-01-01',
      d1_databases: [{ binding: 'DATABASE', database_name: 'main', database_id: 'main' }],
      r2_buckets: [{ binding: 'R2', bucket_name: 'files' }],
      vars: {
        SAM_KEY_AGENT_URL: keyAgentUrl({ port: ports.agent }),
        SAM_SECRET_BUNDLE_ID: head.bundle.bundleId,
        SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(head.secrets),
        SAM_INSTALLATION_ID: head.secrets.SAM_INSTALLATION_ID,
      },
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
  if (result.status !== 0) throw new Error(`celld deploy failed: ${result.stderr}${result.stdout}`);
}

async function adoptAndCheck(): Promise<{ healthy: boolean; detail: string }> {
  const reload = await fetch(`http://127.0.0.1:${ports.internal}/reload`, { method: 'POST' }).catch(
    () => null
  );
  if (!reload?.ok) return { healthy: false, detail: `reload ${reload?.status ?? 'failed'}` };
  const response = await fetch(`http://127.0.0.1:${ports.celld}/health`).catch(() => null);
  return response?.ok
    ? { healthy: true, detail: 'HTTP 200' }
    : { healthy: false, detail: `HTTP ${response?.status ?? 'none'}` };
}

async function readProbe(): Promise<{ values: string[]; file: string; rotating: boolean }> {
  const response = await fetch(`http://127.0.0.1:${ports.celld}/read`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { values: string[]; file: string; rotating: boolean };
}

function deps(log: string[], interruptAfterMigratePages = 0): RotateDeps {
  const real = boxRotateDeps({ ...ctx(), log: (m) => log.push(m) });
  let migratePages = 0;
  return {
    ...real,
    backup: () => null,
    deploy: deployProbe,
    adoptAndCheck,
    restartGatewayConsumers: async () => {
      throw new Error('not used by encryption-key');
    },
    control: async (key, body) => {
      if (body.mode === 'migrate' && interruptAfterMigratePages > 0) {
        migratePages += 1;
        if (migratePages > interruptAfterMigratePages)
          throw new Error('the operator pressed Ctrl-C');
      }
      return await real.control(key, body);
    },
  };
}

const rotateInput = (extra: Record<string, unknown> = {}) => ({
  box: box(),
  stateDir: state,
  names: [] as string[],
  all: false,
  dryRun: false,
  resume: false,
  skipBackup: true,
  // Values outside D1/R2 expire immediately in this test (no interactions exist).
  storedLifetimeMinutes: 0.02,
  ...extra,
});

function stopAgent(): void {
  if (agentContainer) spawnSync('docker', ['rm', '-f', agentContainer]);
  agentContainer = '';
}

describe.skipIf(!hasDocker && !process.env.CI)('encryption-key rotation on celld', () => {
  beforeAll(async () => {
    ports = {
      store: await freePort(),
      celld: await freePort(),
      internal: await freePort(),
      agent: await freePort(),
    };
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'key-rotation-'));
    state = join(root, '.state');
    envFile = join(root, '.env');
    writeFileSync(
      envFile,
      [
        'SAM_DOMAIN=sam.example.com',
        'CELLD_BUCKET=s3://fleet/celld',
        `S3_ENDPOINT=http://127.0.0.1:${ports.store}`,
        `AWS_ACCESS_KEY_ID=${KEY}`,
        `AWS_SECRET_ACCESS_KEY=${SECRET}`,
        `SAM_KEY_AGENT_PORT=${ports.agent}`,
        `CELLD_PORT=${ports.celld}`,
        `CELLD_INTERNAL_PORT=${ports.internal}`,
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
    mkdirSync(state, { mode: 0o700 });
    // A sealed box: the file key provider, one bundle with every platform key.
    writeKeyChoice(state, {
      format: KEY_CHOICE_FORMAT,
      provider: 'file',
      settings: {},
      reason: 'live test',
      source: 'auto',
      chosenAt: new Date().toISOString(),
    });
    const settings = keyServiceSettings({ ...box(), SAM_KEY_PROVIDER: 'file' }, state);
    if (!settings) throw new Error('no key service settings');
    ensureKeyServiceFiles(settings);
    const secrets = {
      ...completePlatformKeys({}).keys,
      SAM_KEY_AGENT_SIGNING_KEY: generateAgentSigningKey(),
    };
    const bundle = await sealSecrets(secrets, createKeyProvider(settings.hostEnv), {
      installationId: secrets.SAM_INSTALLATION_ID,
    });
    writeFileSync(join(settings.bundleDir, `${bundle.bundleId}.json`), JSON.stringify(bundle), {
      mode: 0o600,
    });

    const build = spawnSync(
      'docker',
      ['build', '-q', '-t', IMAGE, join(REPO_ROOT, 'deploy/selfhost/key-agent')],
      {
        encoding: 'utf8',
      }
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
      'the key agent',
      async () => (await fetch(`http://127.0.0.1:${ports.agent}/healthz`).catch(() => null))?.ok
    );
    await deployProbe();
    await waitFor(
      'the probe Worker',
      async () => (await adoptAndCheck()).healthy,
      120_000,
      () => celld?.output() ?? ''
    );
    const seeded = await fetch(`http://127.0.0.1:${ports.celld}/setup`, { method: 'POST' });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
  }, 600_000);

  afterAll(async () => {
    stopAgent();
    await celld?.stop();
    if (store) spawnSync('docker', ['rm', '-f', store]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('re-encrypts online, resumes after an interruption, and ends readable with the new key alone', async () => {
    const before = await readProbe();
    expect(before.values).toEqual(Array.from({ length: ROWS }, (_, i) => `secret-${i}`));
    const oldKey = (await openRotationStore(box(), state).head()).secrets.ENCRYPTION_KEY ?? '';

    // Interrupted after the first migrate page (pages of 200 would hold every row, so use the
    // CLI's real page size and stop before the library page).
    const log: string[] = [];
    await expect(
      runRotate(rotateInput({ names: ['encryption-key'] }), deps(log, 1))
    ).rejects.toThrow('Ctrl-C');
    expect(readJournal(state)?.steps['encryption-key']?.phase).toBe('migrating');
    // Mid-rotation the Worker reads every value (new key current, old key the fallback).
    const mid = await readProbe();
    expect(mid.rotating).toBe(true);
    expect(mid.values).toEqual(before.values);
    expect(mid.file).toBe('library body');

    await runRotate(rotateInput({ resume: true }), deps(log));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await runRotate(rotateInput({ resume: true }), deps(log));
    expect(readJournal(state)).toBeNull();

    const head = (await openRotationStore(box(), state).head()).secrets;
    expect(head.ENCRYPTION_KEY).not.toBe(oldKey);
    expect(head.ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
    expect(head.SAM_KEY_ROTATION_CONTROL_KEY).toBeUndefined();
    const after = await readProbe();
    expect(after.rotating).toBe(false);
    expect(after.values).toEqual(before.values);
    expect(after.file).toBe('library body');

    // The control endpoint left with the rotation's bundle.
    const control = await fetch(`http://127.0.0.1:${ports.celld}/__sam-selfhost/key-rotation`, {
      method: 'POST',
      body: '{"op":"status"}',
    });
    expect(control.status).toBe(404);

    // No deploy manifest in the bucket holds either key (they only ever travelled sealed).
    const dump = join(root, 'bucket-dump');
    const mirror = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '-v',
        `${root}:${root}`,
        '-e',
        `MC_HOST_src=http://${KEY}:${SECRET}@127.0.0.1:${ports.store}`,
        '-e',
        'MC_CONFIG_DIR=/tmp/mc',
        '--entrypoint',
        'mc',
        OBJECTSTORE_IMAGE,
        'mirror',
        '--quiet',
        'src/fleet/celld/deploy',
        dump,
      ],
      { encoding: 'utf8' }
    );
    expect(mirror.status, mirror.stderr).toBe(0);
    const manifests = readdirSync(dump, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'manifest.json')
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
    expect(manifests.length).toBeGreaterThanOrEqual(3);
    for (const text of manifests) {
      expect(text.includes(oldKey)).toBe(false);
      expect(text.includes(head.ENCRYPTION_KEY ?? 'unset')).toBe(false);
    }
    expect(log.join('\n')).toContain('the old value is retired from the Worker');
  }, 600_000);
});
