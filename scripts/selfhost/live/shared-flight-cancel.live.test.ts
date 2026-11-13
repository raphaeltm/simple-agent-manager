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
 *
 * The same holds for the per-isolate reads every request's auth/config path joins: the admin
 * settings cache and the legacy platform-config read (resolvePlatformConfig, reached for example
 * by every MCP tool listing). Their joiners may wait out the dropped read's deadline plus the
 * join grace, then read for themselves (apps/api/src/lib/shared-flight.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureCelldBinary } from '../celld-binary.js';
import {
  celldNode,
  hasDocker,
  type ObjectStore,
  sealBundle,
  startKeyAgent,
  startObjectStore,
  writeProject,
} from './celld-lab';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, sleep, waitFor } from './harness';

const RUNTIME_SECRETS = join(REPO_ROOT, 'apps/api/src/selfhost/runtime-secrets.ts');
const SETTINGS_CACHE = join(REPO_ROOT, 'apps/api/src/services/admin-settings-cache.ts');
const PLATFORM_CONFIG = join(REPO_ROOT, 'apps/api/src/services/platform-config.ts');
/** The settings flight's own deadline in the probe: longer than one slow read. */
const SETTINGS_READ_TIMEOUT_MS = 3000;
/** The legacy platform-config read's deadline: performance.configReadTimeoutMs at its default. */
const PLATFORM_CONFIG_READ_TIMEOUT_MS = 5000;
/** lib/shared-flight.ts DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS */
const JOIN_GRACE_MS = 1000;
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
// `/platform-config` runs the real resolvePlatformConfig over a stand-in D1 whose settings reads
// answer at once and whose five legacy platform-config reads wait on the slow proxy, so an
// aborted first request is mid legacy read when its client leaves.
const WORKER = `
import { wrapDurableObject, wrapWorker } from ${JSON.stringify(RUNTIME_SECRETS)};
import { AdminSettingsCache } from ${JSON.stringify(SETTINGS_CACHE)};
import { resolvePlatformConfig } from ${JSON.stringify(PLATFORM_CONFIG)};
const DB = {};
let settings;
let slowUrl = '';
const LEGACY_READ = /WHERE key = \\?|AS encryptedToken/;
function statement(sql) {
  const wait = async () => {
    if (LEGACY_READ.test(sql)) await (await fetch(slowUrl)).arrayBuffer();
  };
  const api = {
    bind: () => api,
    first: async () => { await wait(); return null; },
    all: async () => { await wait(); return { results: [], success: true, meta: {} }; },
    run: async () => { await wait(); return { success: true, meta: {} }; },
    raw: async () => { await wait(); return []; },
  };
  return api;
}
const CONFIG_DB = { prepare: statement, batch: async () => [] };
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
    if (url.pathname === '/platform-config') {
      slowUrl = env.SLOW_URL;
      const config = await resolvePlatformConfig({ DATABASE: CONFIG_DB, GITHUB_APP_SLUG: 'live-app' });
      return Response.json({ appSlug: config.github.appSlug.value });
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
let store: ObjectStore | undefined;
let celld: Running | undefined;
let agent: Running | undefined;
let proxy: Server | undefined;
let celldPort = 0;

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
    const response = await fetch(`http://127.0.0.1:${celldPort}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, ms: Date.now() - started, body: await response.json() };
  } catch {
    return { status: 0, ms: Date.now() - started };
  }
}

/** Abort the first request to a fresh isolate, then require the next two to answer in `bound`. */
async function expectJoinersAnswer(path: string, bound: number): Promise<Outcome[]> {
  await sleep(IDLE_FOR_FRESH_ISOLATE_MS);
  expect((await request(path, ABORT_AFTER_MS)).status).toBe(0);
  // The next reads join the dropped flight. They may wait out its deadline plus the join grace,
  // then read for themselves: bounded, never the client cap.
  const next = await Promise.all([request(path, CLIENT_CAP_MS), request(path, CLIENT_CAP_MS)]);
  const report = JSON.stringify(next) + (celld?.output().slice(-3000) ?? '');
  expect(
    next.map((o) => o.status),
    report
  ).toEqual([200, 200]);
  for (const outcome of next) expect(outcome.ms, report).toBeLessThan(bound);
  return next;
}

describe.skipIf(!hasDocker && !process.env.CI)('an aborted request does not poison celld', () => {
  beforeAll(async () => {
    const agentPort = await freePort();
    const proxyPort = await freePort();
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'shared-flight-'));
    store = await startObjectStore('sam-live-sharedflight', 'live-sharedflight-store-0123456789');
    const bundle = await sealBundle(
      join(root, 'state'),
      { LIVE_SECRET: `live-${randomBytes(8).toString('hex')}` },
      'd'.repeat(32)
    );
    const project = writeProject(join(root, 'project'), {
      name: 'shared-flight-probe',
      worker: WORKER,
      probeObject: true,
      vars: {
        // The Worker talks to the slow proxy; the proxy talks to the real agent.
        SAM_KEY_AGENT_URL: `http://127.0.0.1:${proxyPort}/v1/secrets`,
        SAM_SECRET_BUNDLE_ID: bundle.bundleId,
        SAM_KEY_AGENT_VERIFY_KEY: bundle.verifyKey,
        SAM_INSTALLATION_ID: 'd'.repeat(32),
        // Longer than the proxy delay: a healthy load finishes; only a dropped one hangs.
        SAM_KEY_AGENT_TIMEOUT_MS: '5000',
        SLOW_URL: `http://127.0.0.1:${proxyPort}/healthz`,
      },
    });
    agent = startKeyAgent(bundle, agentPort, process.getuid?.() ?? 0);
    await waitFor(
      'the agent',
      async () => (await fetch(`http://127.0.0.1:${agentPort}/healthz`).catch(() => null))?.ok
    );
    proxy = startDelayProxy(proxyPort, agentPort, AGENT_DELAY_MS);
    const node = await celldNode(await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')), store);
    celldPort = node.port;
    celld = node.start();
    const deployed = node.deploy(project);
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
    store?.stop();
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
    await expectJoinersAnswer(
      '/settings',
      SETTINGS_READ_TIMEOUT_MS + JOIN_GRACE_MS + 2 * AGENT_DELAY_MS + 2000
    );
  }, 150_000);

  it('serves platform-config reads after the request that started the shared read was aborted', async () => {
    const next = await expectJoinersAnswer(
      '/platform-config',
      PLATFORM_CONFIG_READ_TIMEOUT_MS + JOIN_GRACE_MS + 2 * AGENT_DELAY_MS + 2000
    );
    for (const outcome of next) expect(outcome.body).toEqual({ appSlug: 'live-app' });
  }, 150_000);
});
