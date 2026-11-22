/**
 * Vertical slice for app deployments on a box with its own DNS (multi-box step 1):
 *
 *   GET /api/nodes/:id/deploy-release (the real callback route, through the real
 *   upsertAppRouteDNSRecord fan-out)  ->  selfhost_dns_records in D1 (real SQLite, shipped
 *   migration)  ->  GET /api/self-host/gateway/dns-records (the real gateway route sam-dns reads),
 *   page by page.
 *
 * The release has more public routes than one sync page holds (.claude/rules/81), so the sidecar's
 * paging is exercised end to end. Cloudflare is never called. The route's own D1 reads go through
 * the same drizzle mock the route tests use; only the box zone's statements reach SQLite, which is
 * the part under test.
 */
import { buildDeploymentRouteTargets } from '@simple-agent-manager/app-deployment';
import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { boxDnsBackend, installBoxDns } from '../../../src/selfhost/dns';
import { createSelfHostGatewayRoutes } from '../../../src/selfhost/reverse-tunnel/gateway';
import { installReverseTunnelTransport } from '../../../src/selfhost/reverse-tunnel/transport';
import { resetBoxDnsBackendForTests } from '../../../src/services/dns-provider';
import { applySqliteMigration, createSqliteD1 } from '../../helpers/sqlite-d1';

const mockLimit = vi.fn();
const priorReleases = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockD1Run = vi.fn(async () => ({ meta: { changes: 1 } }));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mockLimit,
          orderBy: vi.fn().mockResolvedValue([]),
          // The release fetch's prior-release read (stale route cleanup).
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(priorReleases.rows).then(resolve),
        }),
        innerJoin: () => ({ where: () => ({ limit: mockLimit }) }),
      }),
    }),
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
  }),
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({
    workspace: 'node-deploy-1',
    type: 'callback',
    scope: 'node',
  })),
}));
vi.mock('../../../src/services/deploy-signing', () => ({
  signDeployPayload: vi.fn(async () => 'signed-payload'),
  signRouteConfigPayload: vi.fn(async () => 'signed-route-config'),
}));
vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: vi.fn(async () => ({
    registry: 'registry.example.test',
    username: 'u',
    password: 'p',
    namespace: 'n',
    expiresAt: '2026-12-01T00:00:00.000Z',
  })),
}));
vi.mock('../../../src/routes/deployment-releases', () => ({
  getEncryptionKey: () => 'test-encryption-key',
  loadResolvedSecrets: vi.fn(async () => ({})),
}));
vi.mock('../../../src/services/deployment-environment-config', () => ({
  loadDeploymentInterpolationEnv: vi.fn(async () => ({ values: {} })),
}));
vi.mock('../../../src/services/deployment-volumes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/deployment-volumes')>()),
  buildVolumeMountDescriptors: vi.fn(async () => []),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentReleaseLifecycleEventBestEffort: vi.fn(async () => undefined),
}));

const { deployReleaseCallbackRoute } = await import('../../../src/routes/deploy-release-callback');

const SECRET = 'a'.repeat(64);
const NODE_IP = '203.0.113.10';
const BOX_IP = '192.0.2.44';
const PAGE_SIZE = 10;
/** 2 * page + 3: two full pages and a remainder. */
const ROUTE_COUNT = PAGE_SIZE * 2 + 3;

let sqlite: Database.Database;

function manifest() {
  return {
    version: 1,
    services: {
      web: {
        image: {
          registry: 'docker.io',
          repository: 'example/web',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: Array.from({ length: ROUTE_COUNT }, (_, i) => ({
      service: 'web',
      port: 3000 + i,
      mode: 'public',
    })),
  };
}

/** Box zone statements go to SQLite; the route's release-claim UPDATE to the mock. */
function boxDatabase(): D1Database {
  const real = createSqliteD1(sqlite);
  return {
    prepare: (sql: string) =>
      sql.includes('selfhost_dns')
        ? real.prepare(sql)
        : {
            bind: () => ({
              run: mockD1Run,
              // The route-write fence reads the node's status (`upsertReleaseRouteRecords`).
              first: vi.fn(async () => ({
                status: 'running',
                runtime_termination_confirmed_at: null,
              })),
            }),
            run: mockD1Run,
          },
    batch: (statements: D1PreparedStatement[]) => real.batch(statements),
  } as unknown as D1Database;
}

function boxEnv(): Env {
  return {
    DATABASE: boxDatabase(),
    BASE_DOMAIN: 'box.example.test',
    SAM_DNS_PROVIDER: 'box',
    REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
    DNS_TTL_SECONDS: '120',
    DEPLOY_PAYLOAD_EXPIRY_SECONDS: '90',
    DEPLOYMENT_ROUTE_PORT_BASE: '36000',
    DEPLOYMENT_ROUTE_PORT_SPAN: '100',
    DEPLOY_SIGNING_PRIVATE_KEY: 'test-private-key',
    R2_BUCKET_NAME: 'sam-artifacts',
  } as unknown as Env;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  applySqliteMigration(
    sqlite,
    new URL('../../../src/selfhost/migrations/0267_selfhost_dns_records.sql', import.meta.url)
  );
  resetBoxDnsBackendForTests();
  installBoxDns();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no external request may be made on a box with its own DNS');
    })
  );
  mockLimit.mockReset();
  mockLimit
    .mockResolvedValueOnce([
      { userId: 'user-1', ipAddress: NODE_IP, providerInstanceId: 'provider-server-current' },
    ])
    .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
    .mockResolvedValueOnce([
      { id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7, status: 'created' },
    ]);
});

afterEach(() => {
  resetBoxDnsBackendForTests();
  vi.unstubAllGlobals();
  sqlite.close();
});

describe('app deployment routes on a box that serves its own DNS', () => {
  it('stores every route record in D1 and serves the whole zone to sam-dns across pages', async () => {
    const env = boxEnv();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/nodes', deployReleaseCallbackRoute);
    const release = await app.request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    );
    const releaseBody = (await release.json()) as { routes?: Array<{ hostname: string }> };
    expect(release.status, JSON.stringify(releaseBody)).toBe(200);
    const hostnames = (releaseBody.routes ?? []).map((route) => route.hostname).sort();
    expect(hostnames).toHaveLength(ROUTE_COUNT);

    // The sidecar's sync, through the real gateway route, page by page.
    const gateway = createSelfHostGatewayRoutes(() => new Response(null, { status: 404 }));
    const served: Array<{ name: string; type: string; content: string }> = [];
    let after: string | null = null;
    let serial: number | null = null;
    let pages = 0;
    do {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (after) query.set('after', after);
      const response = await gateway.request(
        `/api/self-host/gateway/dns-records?${query}`,
        { headers: { 'X-SAM-Gateway-Secret': SECRET } },
        env
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        serial: number;
        records: typeof served;
        nextCursor: string | null;
      };
      serial ??= page.serial;
      expect(page.serial).toBe(serial);
      served.push(...page.records);
      after = page.nextCursor;
      pages++;
    } while (after);

    expect(pages).toBe(3);
    expect(served.map((record) => record.name).sort()).toEqual(hostnames);
    expect(served.every((record) => record.type === 'A' && record.content === NODE_IP)).toBe(true);

    // Unchanged zone: one cheap answer, no records.
    const unchanged = await gateway.request(
      `/api/self-host/gateway/dns-records?serial=${serial}`,
      { headers: { 'X-SAM-Gateway-Secret': SECRET } },
      env
    );
    expect(await unchanged.json()).toEqual({ serial, unchanged: true });
  });
});

describe('app deployment routes of a deployment node on the reverse tunnel', () => {
  it('point every record at the box, which carries the app traffic, with no node IP', async () => {
    installReverseTunnelTransport(generateCloudInit);
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([
        {
          userId: 'user-1',
          ipAddress: null,
          transport: 'reverse-tunnel',
          providerInstanceId: 'provider-server-current',
        },
      ])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([
        { id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7, status: 'created' },
      ]);
    const env = { ...boxEnv(), SAM_DNS_PUBLIC_IPV4: BOX_IP } as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/nodes', deployReleaseCallbackRoute);
    const release = await app.request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    );
    const body = (await release.json()) as { routes?: Array<{ hostname: string }> };
    expect(release.status, JSON.stringify(body)).toBe(200);
    expect(body.routes).toHaveLength(ROUTE_COUNT);

    const zone = sqlite
      .prepare(`SELECT name, content FROM selfhost_dns_records ORDER BY name`)
      .all() as Array<{ name: string; content: string }>;
    expect(zone.map((record) => record.name).sort()).toEqual(
      (body.routes ?? []).map((route) => route.hostname).sort()
    );
    expect(zone.every((record) => record.content === BOX_IP)).toBe(true);
  });
});

describe('stale route records while a release applies', () => {
  function manifestWith(ports: number[]) {
    return {
      ...manifest(),
      routes: ports.map((port) => ({ service: 'web', port, mode: 'public' })),
    };
  }

  async function fetchRelease(transport: string | null) {
    installReverseTunnelTransport(generateCloudInit);
    const applied = manifestWith([3000, 9999]);
    priorReleases.rows = [{ manifest: JSON.stringify(applied), status: 'applied', version: 6 }];
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([
        {
          userId: 'user-1',
          ipAddress: NODE_IP,
          transport,
          providerInstanceId: 'provider-server-current',
        },
      ])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([
        {
          id: 'rel-7',
          manifest: JSON.stringify(manifestWith([3000])),
          version: 7,
          status: 'created',
        },
      ]);
    const env = { ...boxEnv(), SAM_DNS_PUBLIC_IPV4: BOX_IP } as Env;
    // The applied release's dropped route already has its record in the box zone.
    const dropped = buildDeploymentRouteTargets(applied as never, {
      environmentId: 'env-1',
      baseDomain: 'box.example.test',
      routePortBase: '36000',
      routePortSpan: '100',
    }).find((route) => route.containerPort === 9999)!.hostname;
    await boxDnsBackend.upsertARecord(dropped, BOX_IP, env);
    const background: Promise<unknown>[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/nodes', deployReleaseCallbackRoute);
    const release = await app.request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env,
      { waitUntil: (p: Promise<unknown>) => background.push(p), passThroughOnException: vi.fn() }
    );
    expect(release.status).toBe(200);
    await Promise.all(background);
    const names = (
      sqlite.prepare(`SELECT name FROM selfhost_dns_records`).all() as Array<{ name: string }>
    ).map((row) => row.name);
    return { names, dropped };
  }

  afterEach(() => {
    priorReleases.rows = [];
  });

  it('a tunnel node keeps the applied release route record until that release is replaced', async () => {
    const { names, dropped } = await fetchRelease('reverse-tunnel');
    expect(names).toContain(dropped);
  });

  it('control: a public-ingress node still drops it at fetch time, as before', async () => {
    const { names, dropped } = await fetchRelease(null);
    expect(names).not.toContain(dropped);
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('the dns-records gateway route fails closed', () => {
  async function get(env: Env, headers: Record<string, string>, query = '') {
    const gateway = createSelfHostGatewayRoutes(() => new Response(null, { status: 404 }));
    return gateway.request(`/api/self-host/gateway/dns-records${query}`, { headers }, env);
  }

  it('answers 404 without a gateway secret or with the box zone off, 401 for a wrong secret', async () => {
    const env = boxEnv();
    const secret = { 'X-SAM-Gateway-Secret': SECRET };
    expect(
      (await get({ ...env, REVERSE_TUNNEL_GATEWAY_SECRET: undefined } as Env, secret)).status
    ).toBe(404);
    expect(
      (await get({ ...env, SAM_DNS_PROVIDER: undefined } as unknown as Env, secret)).status
    ).toBe(404);
    expect((await get(env, { 'X-SAM-Gateway-Secret': 'b'.repeat(64) })).status).toBe(401);
    expect((await get(env, {})).status).toBe(401);
    // Owner control: the right secret with the zone on is served.
    expect((await get(env, secret)).status).toBe(200);
  });

  it('refuses an out-of-range page size and a malformed cursor', async () => {
    const env = boxEnv();
    const secret = { 'X-SAM-Gateway-Secret': SECRET };
    expect((await get(env, secret, '?limit=0')).status).toBe(400);
    expect((await get(env, secret, '?limit=1001')).status).toBe(400);
    expect((await get(env, secret, '?limit=abc')).status).toBe(400);
    expect((await get(env, secret, '?after=nocursor')).status).toBe(400);
  });
});
