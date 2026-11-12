/**
 * Sealed secrets on the real runtime: a celld 0.6.3 node (pinned, checksum-verified) over the
 * box's object store (the MinIO image pinned in docker-compose.yml), the real key agent
 * (deploy/selfhost/key-agent/server.ts, file provider) and a Worker built from the same
 * runtime-secrets module the API's celld entry uses. Proves, end to end:
 *
 * - the Worker and a Durable Object get the secrets at runtime, and no deploy var carries one;
 * - a copy of the fleet bucket holds none of them, while a plain var is stored in plaintext
 *   there (the control: this is why secrets cannot be vars on celld);
 * - with the agent down a fresh isolate answers 503 SECRETS_UNAVAILABLE, and serves again as
 *   soon as the agent is back;
 * - the agent refuses a peer uid it does not allow, on real loopback sockets.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sealSecrets } from '../../../deploy/selfhost/key-agent/bundle.ts';
import {
  createFileProvider,
  generateFileKek,
} from '../../../deploy/selfhost/key-agent/provider-file.ts';
import { OBJECTSTORE_IMAGE } from '../backup-lib';
import { ensureCelldBinary, resolveEsbuild } from '../celld-binary.js';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, sleep, start, waitFor } from './harness';

const KEY = 'sam-live-keyagent';
const SECRET = 'live-keyagent-store-0123456789';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const RUNTIME_SECRETS = join(REPO_ROOT, 'apps/api/src/selfhost/runtime-secrets.ts');
const AGENT = join(REPO_ROOT, 'deploy/selfhost/key-agent/server.ts');

const WORKER = `
import { wrapDurableObject, wrapWorker } from ${JSON.stringify(RUNTIME_SECRETS)};
const isolateId = crypto.randomUUID();
let served = 0;
class Probe {
  constructor(_ctx, env) { this.env = env; }
  async fetch() { return Response.json({ doSecret: typeof this.env.LIVE_SECRET }); }
}
export const ProbeDO = wrapDurableObject(Probe);
export default wrapWorker({
  async fetch(request, env) {
    served += 1;
    if (new URL(request.url).pathname === '/do') {
      return await env.PROBE_DO.get(env.PROBE_DO.idFromName('one')).fetch('https://do/');
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.LIVE_SECRET ?? '')));
    return Response.json({ isolateId, served, secretSha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') });
  },
});
`;

let root = '';
let container = '';
let celld: Running | undefined;
let agent: Running | undefined;
let ports: { store: number; celld: number; internal: number; agent: number };
let binary = '';
let canary = '';
let bundleId = '';
const storeEnv = () => ({
  AWS_ACCESS_KEY_ID: KEY,
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_REGION: 'us-east-1',
});
const bucketArgs = () => [
  '--bucket',
  's3://fleet',
  '--endpoint',
  `http://127.0.0.1:${ports.store}`,
];

function startAgent(allowedUid: number, port = ports.agent): Running {
  return start('node', [AGENT], {
    SAM_KEY_PROVIDER: 'file',
    SAM_KEY_FILE: join(root, 'state/kek'),
    SAM_KEY_AGENT_PORT: String(port),
    SAM_KEY_AGENT_BUNDLE_DIR: join(root, 'state/bundles'),
    SAM_KEY_AGENT_ALLOWED_UIDS: String(allowedUid),
  });
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${ports.celld}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe.skipIf(!hasDocker && !process.env.CI)('sealed secrets on celld', () => {
  beforeAll(async () => {
    ports = {
      store: await freePort(),
      celld: await freePort(),
      internal: await freePort(),
      agent: await freePort(),
    };
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'key-agent-'));
    mkdirSync(join(root, 'state/bundles'), { recursive: true, mode: 0o700 });
    const consolePort = await freePort();
    const run = spawnSync(
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
        `127.0.0.1:${consolePort}`,
      ],
      { encoding: 'utf8' }
    );
    expect(run.status, run.stderr).toBe(0);
    container = run.stdout.trim();
    await waitFor(
      'object store',
      async () =>
        (await fetch(`http://127.0.0.1:${ports.store}/minio/health/live`).catch(() => null))?.ok
    );
    const mc = (args: string[], extra: string[] = []) =>
      spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'host',
          ...extra,
          '-e',
          `MC_HOST_src=http://${KEY}:${SECRET}@127.0.0.1:${ports.store}`,
          '-e',
          'MC_CONFIG_DIR=/tmp/mc',
          '--entrypoint',
          'mc',
          OBJECTSTORE_IMAGE,
          ...args,
        ],
        { encoding: 'utf8' }
      );
    expect(mc(['mb', 'src/fleet']).status).toBe(0);

    // Seal a canary the way the deploy does (scripts/selfhost/key-service.ts), file provider.
    writeFileSync(join(root, 'state/kek'), generateFileKek(), { mode: 0o600 });
    canary = `live-canary-${randomBytes(16).toString('hex')}`;
    const bundle = await sealSecrets(
      { LIVE_SECRET: canary },
      createFileProvider({ SAM_KEY_FILE: join(root, 'state/kek') }),
      { installationId: 'c'.repeat(32) }
    );
    bundleId = bundle.bundleId;
    writeFileSync(join(root, 'state/bundles', `${bundleId}.json`), JSON.stringify(bundle), {
      mode: 0o600,
    });

    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'worker.js'), WORKER);
    writeFileSync(
      join(project, 'wrangler.json'),
      JSON.stringify({
        name: 'key-agent-probe',
        main: 'worker.js',
        compatibility_date: '2026-01-01',
        durable_objects: { bindings: [{ name: 'PROBE_DO', class_name: 'ProbeDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['ProbeDO'] }],
        vars: {
          SAM_KEY_AGENT_URL: `http://127.0.0.1:${ports.agent}/v1/secrets`,
          SAM_SECRET_BUNDLE_ID: bundleId,
          PLAIN_VAR_CONTROL: 'plain-var-control-value',
        },
      })
    );
    agent = startAgent(process.getuid?.() ?? 0);
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
    const deployed = spawnSync(binary, ['deploy', project, ...bucketArgs()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...storeEnv(),
        CELLD_ESBUILD: resolveEsbuild(join(REPO_ROOT, 'apps/api')),
      },
    });
    expect(deployed.status, deployed.stderr + deployed.stdout).toBe(0);
    await waitFor(
      'celld to serve the Worker',
      async () =>
        (await fetch(`http://127.0.0.1:${ports.celld}/`).catch(() => null))?.status === 200,
      120_000,
      () => celld?.output() ?? ''
    );
  }, 300_000);

  afterAll(async () => {
    await celld?.stop();
    await agent?.stop();
    if (container) spawnSync('docker', ['rm', '-f', container]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('delivers the secrets to the Worker and to a Durable Object at runtime', async () => {
    const worker = await get('/');
    expect(worker.status).toBe(200);
    expect(worker.body.secretSha256).toBe(sha256(canary));
    const object = await get('/do');
    expect(object).toEqual({ status: 200, body: { doSecret: 'string' } });
  });

  it('leaves no secret in the fleet bucket, while a plain var is stored there in plaintext', () => {
    const copy = join(root, 'bucket-copy');
    mkdirSync(copy);
    const mirrored = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '-u',
        `${process.getuid?.()}:${process.getgid?.()}`,
        '-v',
        `${copy}:/out`,
        '-e',
        `MC_HOST_src=http://${KEY}:${SECRET}@127.0.0.1:${ports.store}`,
        '-e',
        'MC_CONFIG_DIR=/tmp/mc',
        '--entrypoint',
        'mc',
        OBJECTSTORE_IMAGE,
        'mirror',
        '--quiet',
        'src/fleet',
        '/out',
      ],
      { encoding: 'utf8' }
    );
    expect(mirrored.status, mirrored.stderr).toBe(0);
    const files = filesUnder(copy);
    expect(files.length).toBeGreaterThan(3);
    const contents = files.map((file) => readFileSync(file).toString('latin1'));
    // Control: celld stores deployed vars in plaintext, so a secret var would be here.
    expect(contents.some((text) => text.includes('plain-var-control-value'))).toBe(true);
    for (const form of [canary, Buffer.from(canary).toString('base64')]) {
      expect(contents.filter((text) => text.includes(form))).toEqual([]);
    }
  });

  it('fails closed with 503 while the agent is down, and recovers when it is back', async () => {
    await agent?.stop();
    // Past one 30 s pool tick, so the request lands on a fresh isolate with no cached copy.
    await sleep(40_000);
    const down = await get('/');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({
      error: 'SECRETS_UNAVAILABLE',
      code: 'KEY_AGENT_UNREACHABLE',
    });
    expect(JSON.stringify(down.body)).not.toContain(canary);
    agent = startAgent(process.getuid?.() ?? 0);
    await waitFor(
      'the agent',
      async () => (await fetch(`http://127.0.0.1:${ports.agent}/healthz`).catch(() => null))?.ok
    );
    const back = await get('/');
    expect(back.status).toBe(200);
    expect(back.body.secretSha256).toBe(sha256(canary));
  }, 90_000);

  it('refuses a caller whose uid it does not allow, on real loopback sockets', async () => {
    const port = await freePort();
    const strict = startAgent((process.getuid?.() ?? 0) + 1, port);
    try {
      await waitFor(
        'strict agent',
        async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok
      );
      const refused = await fetch(`http://127.0.0.1:${port}/v1/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
        body: JSON.stringify({ bundleId }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain(canary);
    } finally {
      await strict.stop();
    }
  });
});
