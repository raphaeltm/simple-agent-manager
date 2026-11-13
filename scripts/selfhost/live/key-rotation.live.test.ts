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
import type { BoxContext } from '../backup-lib';
import { ensureCelldBinary } from '../celld-binary.js';
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
import {
  type CelldNode,
  celldNode,
  hasDocker,
  type ObjectStore,
  startObjectStore,
  writeProject,
} from './celld-lab';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, waitFor } from './harness';

const KEY = 'sam-live-rotate';
const SECRET = 'live-rotate-store-0123456789';
const IMAGE = 'sam-selfhost-key-agent:live-test';
const API_SRC = join(REPO_ROOT, 'apps/api/src');
const uid = process.getuid?.() ?? 0;
const ROWS = 30;

let root = '';
let state = '';
let envFile = '';
let store: ObjectStore | undefined;
let node: CelldNode;
let agentPort = 0;
let agentContainer = '';
let celld: Running | undefined;

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

/** The probe: the API's runtime-secrets wrapper around a Worker that seeds and reads credentials. */
const PROBE = `
import { wrapWorker } from ${JSON.stringify(join(API_SRC, 'selfhost/runtime-secrets.ts'))};
import { D1_LOCATIONS } from ${JSON.stringify(join(API_SRC, 'selfhost/key-rotation/d1-locations.ts'))};
import { decrypt, encrypt } from ${JSON.stringify(join(API_SRC, 'services/encryption.ts'))};
import { decryptFile, encryptFile, metadataToR2CustomMetadata, r2CustomMetadataToMetadata } from ${JSON.stringify(join(API_SRC, 'services/file-encryption.ts'))};
import { conditionalWriteProblem } from ${JSON.stringify(join(API_SRC, 'selfhost/key-rotation/library-conditional.ts'))};

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
    if (path === '/conditional') return Response.json({ problem: await conditionalWriteProblem(env.R2) });
    return Response.json({ ok: true });
  },
});
`;

async function deployProbe(): Promise<void> {
  const head = await openRotationStore(box(), state).head();
  const project = writeProject(join(root, `project-${Date.now()}`), {
    name: 'workspaces-api',
    main: 'worker.ts',
    worker: PROBE,
    bindings: {
      d1_databases: [{ binding: 'DATABASE', database_name: 'main', database_id: 'main' }],
      r2_buckets: [{ binding: 'R2', bucket_name: 'files' }],
    },
    vars: {
      SAM_KEY_AGENT_URL: keyAgentUrl({ port: agentPort }),
      SAM_SECRET_BUNDLE_ID: head.bundle.bundleId,
      SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(head.secrets),
      SAM_INSTALLATION_ID: head.secrets.SAM_INSTALLATION_ID,
    },
  });
  const result = node.deploy(project);
  if (result.status !== 0) throw new Error(`celld deploy failed: ${result.stderr}${result.stdout}`);
}

async function adoptAndCheck(): Promise<{ healthy: boolean; detail: string }> {
  const reload = await fetch(`http://127.0.0.1:${node.internalPort}/reload`, {
    method: 'POST',
  }).catch(() => null);
  if (!reload?.ok) return { healthy: false, detail: `reload ${reload?.status ?? 'failed'}` };
  const response = await fetch(`http://127.0.0.1:${node.port}/health`).catch(() => null);
  return response?.ok
    ? { healthy: true, detail: 'HTTP 200' }
    : { healthy: false, detail: `HTTP ${response?.status ?? 'none'}` };
}

async function readProbe(): Promise<{ values: string[]; file: string; rotating: boolean }> {
  const response = await fetch(`http://127.0.0.1:${node.port}/read`);
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
    agentPort = await freePort();
    store = await startObjectStore(KEY, SECRET);
    node = await celldNode(
      await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')),
      store,
      's3://fleet/celld'
    );
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'key-rotation-'));
    state = join(root, '.state');
    envFile = join(root, '.env');
    writeFileSync(
      envFile,
      [
        'SAM_DOMAIN=sam.example.com',
        'CELLD_BUCKET=s3://fleet/celld',
        `S3_ENDPOINT=${store.url}`,
        `AWS_ACCESS_KEY_ID=${KEY}`,
        `AWS_SECRET_ACCESS_KEY=${SECRET}`,
        `SAM_KEY_AGENT_PORT=${agentPort}`,
        `CELLD_PORT=${node.port}`,
        `CELLD_INTERNAL_PORT=${node.internalPort}`,
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
    celld = node.start();
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
      async () => (await fetch(`http://127.0.0.1:${agentPort}/healthz`).catch(() => null))?.ok
    );
    await deployProbe();
    await waitFor(
      'the probe Worker',
      async () => (await adoptAndCheck()).healthy,
      120_000,
      () => celld?.output() ?? ''
    );
    const seeded = await fetch(`http://127.0.0.1:${node.port}/setup`, { method: 'POST' });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
  }, 600_000);

  afterAll(async () => {
    stopAgent();
    await celld?.stop();
    store?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('honours R2 onlyIf.etagMatches on get and put, as the library pass requires (review V1 M1)', async () => {
    // conditionalWriteProblem is the pass's own check (library-conditional.ts): a stale etag must
    // return no body on get and must not overwrite on put; a matching etag must write.
    const response = await fetch(`http://127.0.0.1:${node.port}/conditional`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ problem: null });
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
    const control = await fetch(`http://127.0.0.1:${node.port}/__sam-selfhost/key-rotation`, {
      method: 'POST',
      body: '{"op":"status"}',
    });
    expect(control.status).toBe(404);

    // No deploy manifest in the bucket holds either key (they only ever travelled sealed).
    const dump = join(root, 'bucket-dump');
    if (!store) throw new Error('the object store did not start');
    const mirror = store.mc(
      ['mirror', '--quiet', 'src/fleet/celld/deploy', dump],
      ['--user', `${uid}:${process.getgid?.() ?? 0}`, '-v', `${root}:${root}`]
    );
    expect(mirror.status, mirror.stderr).toBe(0);
    const manifests = readdirSync(dump, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'manifest.json')
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
    expect(manifests.length).toBeGreaterThanOrEqual(3);
    for (const text of manifests) {
      expect(text).not.toContain(oldKey);
      expect(text).not.toContain(head.ENCRYPTION_KEY ?? 'unset');
    }
    expect(log.join('\n')).toContain('the old value is retired from the Worker');
  }, 600_000);
});
