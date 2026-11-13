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
 * join grace, then read for themselves (packages/worker-core/src/shared-flight.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS } from '../../../apps/api/src/lib/shared-flight';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from '../../../apps/api/src/services/config-read-deadline';
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
const SHARED_FLIGHT = join(REPO_ROOT, 'apps/api/src/lib/shared-flight.ts');
const PLATFORM_CONFIG = join(REPO_ROOT, 'apps/api/src/services/platform-config.ts');
const SETTINGS_RESOLUTION = join(REPO_ROOT, 'apps/api/src/services/admin-settings-resolution.ts');
// Moved into the ProjectData package by the worker split (#2681); both import worker-core's
// shared-flight, the same module instance the apps/api shim re-exports.
const ENSURE_MEMO = join(REPO_ROOT, 'packages/project-data/src/client/project-data-ensure-memo.ts');
const COMPACT_R2 = join(REPO_ROOT, 'packages/project-data/src/archive/compact-r2.ts');
/** The settings flight's own deadline in the probe: longer than one slow read. */
const SETTINGS_READ_TIMEOUT_MS = 3000;
/** The legacy platform-config read's deadline: performance.configReadTimeoutMs at its default. */
const PLATFORM_CONFIG_READ_TIMEOUT_MS = DEFAULT_CONFIG_READ_TIMEOUT_MS;
const JOIN_GRACE_MS = DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS;
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
import { resumeSharedFlightJoinsOnOwnTimer, settleSharedFlight } from ${JSON.stringify(SHARED_FLIGHT)};
import { resolvePlatformConfig } from ${JSON.stringify(PLATFORM_CONFIG)};
import { resolveAdminSetting } from ${JSON.stringify(SETTINGS_RESOLUTION)};
import { ensureOncePerIsolate } from ${JSON.stringify(ENSURE_MEMO)};
import { writeImmutableJson } from ${JSON.stringify(COMPACT_R2)};
// What the generated celld entry does at startup (scripts/selfhost/celld-project.ts).
resumeSharedFlightJoinsOnOwnTimer();
const DB = {};
const isolate = crypto.randomUUID().slice(0, 8);
let settings;
let slowUrl = '';
let delayUrl = '';
/** One slow read: the proxied agent (slow per connection) or the delay server (slow per request). */
const slowRead = async (url) => void (await (await fetch(url)).arrayBuffer());
const LEGACY_READ = /WHERE key = \\?|AS encryptedToken/;
/** A stand-in D1 whose statements matching \`slow\` wait on a slow read (a slow D1 read). */
function stubDb(slow, onSlow = () => undefined, url = () => slowUrl) {
  const statement = (sql) => {
    const wait = async () => {
      if (!slow.test(sql)) return;
      onSlow();
      await slowRead(url());
    };
    const api = {
      bind: () => api,
      first: async () => { await wait(); return null; },
      all: async () => { await wait(); return { results: [], success: true, meta: {} }; },
      run: async () => { await wait(); return { success: true, meta: {} }; },
      raw: async () => { await wait(); return []; },
    };
    return api;
  };
  return { prepare: statement, batch: async () => [] };
}
const CONFIG_DB = stubDb(LEGACY_READ);
// The join cases below: one stand-in per kind, so each joins a flight of its own. Their slow reads
// go to the delay server, which holds EVERY request (the agent proxy holds only new connections,
// so a pooled connection would make a "slow" read instant and the second request start its own).
const loads = { settings: 0, platform: 0, credentials: 0, kv: 0, ensure: 0, r2: 0 };
const count = (kind) => () => loads[kind]++;
const delayed = () => delayUrl;
let ioSettings;
const IO_PLATFORM_DB = stubDb(LEGACY_READ, count('platform'), delayed);
const IO_CREDENTIALS_DB = stubDb(/FROM platform_credentials/, count('credentials'), delayed);
const IO_KV_DB = stubDb(/^$/);
const IO_KV = { get: async () => { loads.kv++; await slowRead(delayUrl); return null; } };
// A stand-in R2 bucket whose PUT is a slow provider write.
const r2Objects = new Map();
const IO_R2 = {
  head: async (key) => {
    const stored = r2Objects.get(key);
    return stored ? { size: stored.size, customMetadata: stored.customMetadata } : null;
  },
  put: async (key, bytes, options) => {
    loads.r2++;
    await slowRead(delayUrl);
    r2Objects.set(key, { size: bytes.byteLength, customMetadata: options.customMetadata });
    return {};
  },
  get: async () => null,
};
/** Each kind: the real shared read, as a request reaches it. */
const JOINS = {
  settings: () => {
    ioSettings ??= new AdminSettingsCache(60_000, Date.now, async () => {
      loads.settings++;
      await slowRead(delayUrl);
      return [];
    });
    return ioSettings.read(DB, false, 60_000, ${SETTINGS_READ_TIMEOUT_MS});
  },
  platform: () => resolvePlatformConfig({ DATABASE: IO_PLATFORM_DB, GITHUB_APP_SLUG: 'live-app' }),
  credentials: () =>
    resolveAdminSetting({ DATABASE: IO_CREDENTIALS_DB }, 'integration.github.clientSecret'),
  kv: () => resolveAdminSetting({ DATABASE: IO_KV_DB, KV: IO_KV }, 'operations.cronSweepsEnabled'),
  ensure: () =>
    ensureOncePerIsolate({}, 'live-join-probe', async () => {
      loads.ensure++;
      await slowRead(delayUrl);
    }),
  // The archive cron's immutable write: B's HEAD waits on A's PUT, then HEADs again.
  r2: () => writeImmutableJson(IO_R2, 'live-join-probe.json', { ok: true }, 10_000),
};
/** The request's own I/O after the join: what every auth path does next (D1, fetch, timer). */
async function ownIo(env) {
  await (await fetch(env.FAST_URL)).arrayBuffer();
  await new Promise((resume) => setTimeout(resume, 50));
}
class Probe {
  constructor(_ctx, env) {
    this.env = env;
    this.joinLoads = 0;
    this.cleanupInFlight = null;
  }
  async fetch(request) {
    if (new URL(request.url).pathname !== '/join') {
      return Response.json({ doSecret: typeof this.env.LIVE_SECRET });
    }
    // A Durable Object field joined by a second request, as CredentialSetupSession's alarm joins
    // an inline cleanup another request started (resumeCleanup).
    const inline = this.cleanupInFlight;
    if (inline) {
      const joined = await settleSharedFlight(inline.promise, inline.startedAt + 5000);
      if (joined.abandoned) return Response.json({ abandoned: true }, { status: 500 });
    } else {
      this.joinLoads++;
      const flight = {
        startedAt: Date.now(),
        promise: slowRead(this.env.DELAY_URL),
      };
      this.cleanupInFlight = flight;
      try {
        await flight.promise;
      } finally {
        if (this.cleanupInFlight === flight) this.cleanupInFlight = null;
      }
    }
    await ownIo(this.env);
    return Response.json({ isolate, loads: this.joinLoads });
  }
}
export const ProbeDO = wrapDurableObject(Probe);
const withSecrets = wrapWorker({
  async fetch(_request, env) { return Response.json({ secret: typeof env.LIVE_SECRET }); },
});
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    slowUrl = env.SLOW_URL;
    delayUrl = env.DELAY_URL;
    if (url.pathname === '/settings') {
      settings ??= new AdminSettingsCache(60_000, Date.now, async () => {
        await (await fetch(env.SLOW_URL)).arrayBuffer();
        return [];
      });
      const rows = await settings.read(DB, false, 60_000, ${SETTINGS_READ_TIMEOUT_MS});
      return Response.json({ rows: rows.length });
    }
    if (url.pathname === '/join-io') {
      const kind = url.searchParams.get('kind') ?? '';
      if (kind === 'do') {
        const stub = env.PROBE_DO.get(env.PROBE_DO.idFromName('live-join-probe'));
        return await stub.fetch('https://do/join');
      }
      await JOINS[kind](env);
      await ownIo(env);
      return Response.json({ isolate, loads: loads[kind] });
    }
    if (url.pathname === '/platform-config') {
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
let delayServer: ReturnType<typeof createHttpServer> | undefined;
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
    const delayPort = await freePort();
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
      // As the API runs (apps/api/wrangler.toml): the archive code imports node:crypto.
      bindings: { compatibility_flags: ['nodejs_compat'] },
      vars: {
        // The Worker talks to the slow proxy; the proxy talks to the real agent.
        SAM_KEY_AGENT_URL: `http://127.0.0.1:${proxyPort}/v1/secrets`,
        SAM_SECRET_BUNDLE_ID: bundle.bundleId,
        SAM_KEY_AGENT_VERIFY_KEY: bundle.verifyKey,
        SAM_INSTALLATION_ID: 'd'.repeat(32),
        // Longer than the proxy delay: a healthy load finishes; only a dropped one hangs.
        SAM_KEY_AGENT_TIMEOUT_MS: '5000',
        SLOW_URL: `http://127.0.0.1:${proxyPort}/healthz`,
        FAST_URL: `http://127.0.0.1:${agentPort}/healthz`,
        DELAY_URL: `http://127.0.0.1:${delayPort}/`,
      },
    });
    agent = startKeyAgent(bundle, agentPort, process.getuid?.() ?? 0);
    await waitFor(
      'the agent',
      async () => (await fetch(`http://127.0.0.1:${agentPort}/healthz`).catch(() => null))?.ok
    );
    proxy = startDelayProxy(proxyPort, agentPort, AGENT_DELAY_MS);
    // Holds every request, pooled connection or not: the join cases' slow read.
    delayServer = createHttpServer((_req, res) => {
      setTimeout(() => res.end('ok'), AGENT_DELAY_MS);
    }).listen(delayPort, '127.0.0.1');
    const node = await celldNode(await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')), store);
    celldPort = node.port;
    celld = await node.serve(project);
  }, 300_000);

  afterAll(async () => {
    await celld?.stop();
    await agent?.stop();
    await new Promise<void>((done) => (proxy ? proxy.close(() => done()) : done()));
    delayServer?.closeAllConnections();
    await new Promise<void>((done) => (delayServer ? delayServer.close(() => done()) : done()));
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
  /**
   * Every kind of join the API makes, driven through its real code. No client gives up here: B
   * joins A's healthy shared read, then makes its own fetch and timer. Without the own-timer
   * resume B continues as part of A's request, celld drops B's later ops when A answers, and B
   * hangs to the client cap (task R6: authenticated requests after #2706). `loadsPerFlight` is the
   * number of slow reads one flight makes; both answers reporting it proves B really joined.
   *
   * Verified discriminating (task R7): with the startup switch removed, the six stateless kinds
   * go red (B hangs to CLIENT_CAP_MS) and the Durable Object kind stays green. On celld 0.6.3 an
   * object's ops are not dropped when one of its requests answers, so that case is a control: it
   * proves the own-timer join also works inside an object, and that B joined (one load).
   */
  it.each([
    { kind: 'settings', site: 'AdminSettingsCache.read (joinSharedFlight)', loadsPerFlight: 1 },
    { kind: 'platform', site: 'resolveLegacyPlatformConfig', loadsPerFlight: 5 },
    { kind: 'credentials', site: 'admin-settings credentialRows', loadsPerFlight: 1 },
    { kind: 'kv', site: 'admin-settings legacyKv', loadsPerFlight: 1 },
    { kind: 'ensure', site: 'ensureOncePerIsolate', loadsPerFlight: 1 },
    { kind: 'r2', site: 'compact-r2 timedR2 (archive cron)', loadsPerFlight: 1 },
    {
      kind: 'do',
      site: 'Durable Object field (CredentialSetupSession.resumeCleanup)',
      loadsPerFlight: 1,
    },
  ])(
    'a request that joined $site keeps its own I/O after the starter answers',
    async ({ kind, loadsPerFlight }) => {
      if (kind === 'do') {
        // Warm the object first, so neither request waits on its secrets load.
        expect((await request('/do?name=live-join-probe', CLIENT_CAP_MS)).status).toBe(200);
      }
      const path = `/join-io?kind=${kind}`;
      const first = request(path, CLIENT_CAP_MS);
      await sleep(200);
      const second = request(path, CLIENT_CAP_MS);
      const both = [await first, await second];
      const report = JSON.stringify(both) + (celld?.output().slice(-3000) ?? '');
      expect(
        both.map((o) => o.status),
        report
      ).toEqual([200, 200]);
      // Liveness of the scenario: one isolate and ONE flight, so the second request really joined.
      const bodies = both.map((o) => o.body as { isolate: string; loads: number });
      expect(bodies[1]?.isolate, report).toBe(bodies[0]?.isolate);
      expect(
        bodies.map((b) => b.loads),
        report
      ).toEqual([loadsPerFlight, loadsPerFlight]);
      for (const outcome of both)
        expect(outcome.ms, report).toBeLessThan(2 * AGENT_DELAY_MS + 2000);
    },
    60_000
  );
});
