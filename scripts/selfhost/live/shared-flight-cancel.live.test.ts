/**
 * The one-minute hangs on the celld box (task H2): an aborted request must not poison its isolate.
 *
 * celld 0.6.3 gives every async op (fetch, setTimeout, AbortSignal.timeout) to the request that
 * started it, and drops the op when that request's client disconnects (runtime.rs: the cancel
 * path clears the request's pending ops and deletes their resolvers). A promise one request
 * starts and later requests join therefore never settles once the first client goes away, and
 * every joiner hangs until its own client gives up or the 300 s handler budget runs out.
 *
 * Runs on the real runtime: celld 0.6.3 (pinned) over the pinned object store, the real key
 * agent (file provider) behind a loopback proxy that holds each connection for a moment (a slow
 * agent, as on a loaded box), and a Worker built from the same runtime-secrets module the API's
 * celld entry uses. The first request to a fresh isolate is aborted while its secrets fetch is
 * in flight; the next requests must answer.
 *
 * The control: a request that starts its own load (the fix) answers even though the aborted
 * request's fetch was dropped; before the fix every later request joined the dropped fetch.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
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

const KEY = 'sam-live-sharedflight';
const SECRET = 'live-sharedflight-store-0123456789';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const RUNTIME_SECRETS = join(REPO_ROOT, 'apps/api/src/selfhost/runtime-secrets.ts');
const SETTINGS_CACHE = join(REPO_ROOT, 'apps/api/src/services/admin-settings-cache.ts');
const SHARED_FLIGHT = join(REPO_ROOT, 'apps/api/src/lib/shared-flight.ts');
/** The settings flight's own deadline in the probe: longer than one slow read. */
const SETTINGS_READ_TIMEOUT_MS = 3000;
const AGENT = join(REPO_ROOT, 'deploy/selfhost/key-agent/server.ts');
/** How long the proxy holds each agent connection: wide enough to abort the first request in. */
const AGENT_DELAY_MS = 1500;
/** The first client gives up while the secrets fetch is still in flight. */
const ABORT_AFTER_MS = 400;
/** Past two 30 s pool ticks, so the next request builds a fresh isolate with no secrets. */
const IDLE_FOR_FRESH_ISOLATE_MS = 65_000;
/** A healthy answer takes ~AGENT_DELAY_MS; a poisoned isolate holds a request until this cap. */
const CLIENT_CAP_MS = 15_000;

// `/do?name=` reaches the Durable Object without loading secrets in the stateless handler, so the
// object's own load (wrapDurableObject, under blockConcurrencyWhile) is the only one.
// `/settings` reads through the real AdminSettingsCache (the shared per-isolate flight every
// request's auth path joins), with a loader that waits on the slow proxy like a slow D1 read.
const WORKER = `
import { wrapDurableObject, wrapWorker } from ${JSON.stringify(RUNTIME_SECRETS)};
import { AdminSettingsCache } from ${JSON.stringify(SETTINGS_CACHE)};
import { resumeSharedFlightJoinsOnOwnTimer } from ${JSON.stringify(SHARED_FLIGHT)};
// What the generated celld entry does at startup (scripts/selfhost/celld-project.ts).
resumeSharedFlightJoinsOnOwnTimer();
const DB = {};
const isolate = crypto.randomUUID().slice(0, 8);
let settings;
let ioSettings;
let ioLoads = 0;
class Probe {
  constructor(_ctx, env) { this.env = env; }
  async fetch() { return Response.json({ doSecret: typeof this.env.LIVE_SECRET }); }
}
export const ProbeDO = wrapDurableObject(Probe);
const withSecrets = wrapWorker({
  async fetch(_request, env) { return Response.json({ secret: typeof env.LIVE_SECRET }); },
});
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/settings') {
      settings ??= new AdminSettingsCache(60_000, Date.now, async () => {
        await (await fetch(env.SLOW_URL)).arrayBuffer();
        return [];
      });
      const rows = await settings.read(DB, false, 60_000, ${SETTINGS_READ_TIMEOUT_MS});
      return Response.json({ rows: rows.length });
    }
    if (url.pathname === '/settings-io') {
      // A healthy shared read, then I/O of the request's own: what every auth path does next.
      ioSettings ??= new AdminSettingsCache(60_000, Date.now, async () => {
        ioLoads++;
        await (await fetch(env.SLOW_URL)).arrayBuffer();
        return [];
      });
      await ioSettings.read(DB, false, 60_000, ${SETTINGS_READ_TIMEOUT_MS});
      await (await fetch(env.FAST_URL)).arrayBuffer();
      await new Promise((resume) => setTimeout(resume, 50));
      return Response.json({ isolate, loads: ioLoads });
    }
    if (url.pathname === '/do') {
      const stub = env.PROBE_DO.get(env.PROBE_DO.idFromName(url.searchParams.get('name') ?? 'x'));
      return await stub.fetch('https://do/');
    }
    return await withSecrets.fetch(request, env, ctx);
  },
};
`;

let root = '';
let container = '';
let celld: Running | undefined;
let agent: Running | undefined;
let proxy: Server | undefined;
let ports: { store: number; celld: number; internal: number; agent: number; proxy: number };
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

/** A loopback TCP proxy to the agent that waits before connecting: a slow key agent. */
function startDelayProxy(listenPort: number, targetPort: number, delayMs: number): Server {
  const server = createServer((client) => {
    client.pause();
    const timer = setTimeout(() => {
      const upstream = connect(targetPort, '127.0.0.1', () => {
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    }, delayMs);
    client.on('close', () => clearTimeout(timer));
  });
  server.listen(listenPort, '127.0.0.1');
  return server;
}

interface Outcome {
  status: number;
  ms: number;
  body?: unknown;
}

async function request(path: string, timeoutMs: number): Promise<Outcome> {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${ports.celld}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, ms: Date.now() - started, body: await response.json() };
  } catch {
    return { status: 0, ms: Date.now() - started };
  }
}

describe.skipIf(!hasDocker && !process.env.CI)('an aborted request does not poison celld', () => {
  beforeAll(async () => {
    ports = {
      store: await freePort(),
      celld: await freePort(),
      internal: await freePort(),
      agent: await freePort(),
      proxy: await freePort(),
    };
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'shared-flight-'));
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

    writeFileSync(join(root, 'state/kek'), generateFileKek(), { mode: 0o600 });
    const agentKey = generateKeyPairSync('ed25519');
    const verifyKey = Buffer.from(
      String(agentKey.publicKey.export({ format: 'jwk' }).x),
      'base64url'
    ).toString('base64');
    const signing = agentKey.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const bundle = await sealSecrets(
      {
        LIVE_SECRET: `live-${randomBytes(8).toString('hex')}`,
        SAM_KEY_AGENT_SIGNING_KEY: signing,
      },
      createFileProvider({ SAM_KEY_FILE: join(root, 'state/kek') }),
      { installationId: 'd'.repeat(32) }
    );
    writeFileSync(join(root, 'state/bundles', `${bundle.bundleId}.json`), JSON.stringify(bundle), {
      mode: 0o600,
    });

    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'worker.js'), WORKER);
    writeFileSync(
      join(project, 'wrangler.json'),
      JSON.stringify({
        name: 'shared-flight-probe',
        main: 'worker.js',
        compatibility_date: '2026-01-01',
        durable_objects: { bindings: [{ name: 'PROBE_DO', class_name: 'ProbeDO' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['ProbeDO'] }],
        vars: {
          // The Worker talks to the slow proxy; the proxy talks to the real agent.
          SAM_KEY_AGENT_URL: `http://127.0.0.1:${ports.proxy}/v1/secrets`,
          SAM_SECRET_BUNDLE_ID: bundle.bundleId,
          SAM_KEY_AGENT_VERIFY_KEY: verifyKey,
          SAM_INSTALLATION_ID: 'd'.repeat(32),
          // Longer than the proxy delay: a healthy load finishes; only a dropped one hangs.
          SAM_KEY_AGENT_TIMEOUT_MS: '5000',
          SLOW_URL: `http://127.0.0.1:${ports.proxy}/healthz`,
          FAST_URL: `http://127.0.0.1:${ports.agent}/healthz`,
        },
      })
    );
    agent = start('node', [AGENT], {
      SAM_KEY_PROVIDER: 'file',
      SAM_KEY_FILE: join(root, 'state/kek'),
      SAM_KEY_AGENT_PORT: String(ports.agent),
      SAM_KEY_AGENT_BUNDLE_DIR: join(root, 'state/bundles'),
      SAM_KEY_AGENT_ALLOWED_UIDS: String(process.getuid?.() ?? 0),
    });
    await waitFor(
      'the agent',
      async () => (await fetch(`http://127.0.0.1:${ports.agent}/healthz`).catch(() => null))?.ok
    );
    proxy = startDelayProxy(ports.proxy, ports.agent, AGENT_DELAY_MS);
    const binary = await ensureCelldBinary(join(LIVE_TMP, 'celld-bin'));
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
      async () => (await request('/', 10_000)).status === 200,
      120_000,
      () => celld?.output() ?? ''
    );
  }, 300_000);

  afterAll(async () => {
    await celld?.stop();
    await agent?.stop();
    await new Promise<void>((done) => (proxy ? proxy.close(() => done()) : done()));
    if (container) spawnSync('docker', ['rm', '-f', container]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('serves the requests after one aborted mid-load on a fresh isolate', async () => {
    await sleep(IDLE_FOR_FRESH_ISOLATE_MS);
    const object = `fresh-${randomBytes(4).toString('hex')}`;
    // Both first clients give up while their secrets fetch waits on the slow agent.
    const aborted = await Promise.all([
      request('/', ABORT_AFTER_MS),
      request(`/do?name=${object}`, ABORT_AFTER_MS),
    ]);
    expect(aborted.map((o) => o.status)).toEqual([0, 0]);
    // Liveness: the next requests reach the same (still warm) isolate and must answer.
    const next = await Promise.all([
      request('/', CLIENT_CAP_MS),
      request('/', CLIENT_CAP_MS),
      request(`/do?name=${object}`, CLIENT_CAP_MS),
    ]);
    const report = JSON.stringify(next) + (celld?.output().slice(-3000) ?? '');
    expect(
      next.map((o) => o.status),
      report
    ).toEqual([200, 200, 200]);
    expect(next[0]?.body, report).toEqual({ secret: 'string' });
    expect(next[2]?.body, report).toEqual({ doSecret: 'string' });
    // Each answer costs about one slow agent round trip, nowhere near the client cap.
    for (const outcome of next) expect(outcome.ms, report).toBeLessThan(CLIENT_CAP_MS / 2);
  }, 150_000);
  it('serves settings reads after the request that started the shared read was aborted', async () => {
    await sleep(IDLE_FOR_FRESH_ISOLATE_MS);
    expect((await request('/settings', ABORT_AFTER_MS)).status).toBe(0);
    // The next reads join the dropped flight. They may wait out its deadline plus the join grace,
    // then read for themselves: bounded, never the client cap.
    const next = await Promise.all([
      request('/settings', CLIENT_CAP_MS),
      request('/settings', CLIENT_CAP_MS),
    ]);
    const report = JSON.stringify(next) + (celld?.output().slice(-3000) ?? '');
    expect(
      next.map((o) => o.status),
      report
    ).toEqual([200, 200]);
    const bound = SETTINGS_READ_TIMEOUT_MS + 1000 + 2 * AGENT_DELAY_MS + 2000;
    for (const outcome of next) expect(outcome.ms, report).toBeLessThan(bound);
  }, 150_000);
  it('a request that joined a healthy shared read keeps its own I/O after the starter answers', async () => {
    // No client gives up here. B joins A's settings read, then makes its own fetch and timer.
    // Before the fix B resumed on A's settlement, so celld counted B's later ops as A's and
    // dropped them when A answered: B hung to the client cap (R6, authenticated requests).
    const first = request('/settings-io', CLIENT_CAP_MS);
    await sleep(200);
    const second = request('/settings-io', CLIENT_CAP_MS);
    const both = [await first, await second];
    const report = JSON.stringify(both) + (celld?.output().slice(-3000) ?? '');
    expect(
      both.map((o) => o.status),
      report
    ).toEqual([200, 200]);
    // Liveness of the scenario: one isolate and ONE load, so the second request really joined.
    const bodies = both.map((o) => o.body as { isolate: string; loads: number });
    expect(bodies[1]?.isolate, report).toBe(bodies[0]?.isolate);
    expect(
      bodies.map((b) => b.loads),
      report
    ).toEqual([1, 1]);
    for (const outcome of both) expect(outcome.ms, report).toBeLessThan(2 * AGENT_DELAY_MS + 2000);
  }, 60_000);
});
