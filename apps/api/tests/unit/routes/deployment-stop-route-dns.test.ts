/**
 * Vertical slice for the dangling app-route DNS fix (hosted SAM, Cloudflare):
 *
 *   POST .../environments/:id/stop (real route, real SQL, real strict node deletion)
 *     -> deleteNodeResourcesStrict -> releaseNodeAppRouteDnsRecords -> Cloudflare DNS (contract fake)
 *   POST .../environments/:id/start, then GET /api/nodes/:id/deploy-release (the real release fetch)
 *     -> upsertAppRouteDNSRecord recreates the record at the new node's IP
 *
 * plus the other release paths that reach the same choke point: a failed start, the scheduled
 * deployment-node backstop, and a failed DNS delete that must keep the node retryable.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { deployReleaseCallbackRoute } from '../../../src/routes/deploy-release-callback';
import { registerDeploymentEnvironmentLifecycleRoutes } from '../../../src/routes/deployment-environment-lifecycle';
import { runDeploymentNodeCleanup } from '../../../src/scheduled/deployment-node-cleanup';
import { provisionDeploymentNode } from '../../../src/services/deployment-provisioning';
import { deleteNodeResources } from '../../../src/services/node-resource-deletion';
import { exactProviderCredentialBindingFromPlacementSnapshot } from '../../../src/services/provider-credential-exact';
import { createFakeCloudflareDns, type FakeDnsRecord } from '../../helpers/fake-cloudflare-dns';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const provider = vi.hoisted(() => ({
  deleteVM: vi.fn(),
  listVMs: vi.fn(),
  getVM: vi.fn(),
  detachVolume: vi.fn(),
  attachVolume: vi.fn(),
}));
vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: vi.fn(),
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: vi.fn(async () => ({ provider, providerName: 'hetzner' })),
  exactProviderCredentialBindingFromPlacementSnapshot: (
    snapshot: Parameters<typeof exactProviderCredentialBindingFromPlacementSnapshot>[0]
  ) => exactProviderCredentialBindingFromPlacementSnapshot(snapshot),
}));
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'test-key' }));
vi.mock('../../../src/services/workspace-lifecycle-finalizer', () => ({
  finalizeWorkspaceLifecycleClosure: vi.fn(),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentEnvironmentLifecycleEventBestEffort: vi.fn(),
  recordDeploymentReleaseLifecycleEventBestEffort: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/node-agent', () => ({
  teardownDeploymentEnvironmentOnNode: vi.fn(),
  getNodeAgentBackgroundRequestTimeoutMs: () => 5000,
}));
vi.mock('../../../src/services/deployment-environment-summary', () => ({
  buildDeploymentEnvironmentResponse: vi.fn(async (_db, _env, row) => row),
}));
vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/middleware/project-auth', async (original) => ({
  ...(await original<typeof import('../../../src/middleware/project-auth')>()),
  requireProjectCapability: vi.fn(),
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn(async () => undefined),
}));
// The release fetch's own collaborators that are not under test.
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async (token: string) => ({
    workspace: token.replace('callback-', ''),
    type: 'callback',
    scope: 'node',
  })),
}));
vi.mock('../../../src/services/deploy-signing', () => ({
  signDeployPayload: vi.fn(async () => 'signed-payload'),
  signRouteConfigPayload: vi.fn(async () => 'signed-route-config'),
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

const ZONE = 'zone-1';
const TOKEN = 'cf-token';
const BASE = 'example.com';
const ENV_ID = '01KVJDV913S8W7KK32HTZTK0H8';
const OTHER_ENV_ID = '01KVJDV913S8W7KK32HTZTK0H9';
const OLD_IP = '198.51.100.10';
const NEW_IP = '198.51.100.20';
const OTHER_IP = '198.51.100.30';
const routeHost = (envId: string) => `r1-web-80-${envId.toLowerCase()}.apps.${BASE}`;

let sqlite: Database.Database;
let env: Env;
let zone: ReturnType<typeof createFakeCloudflareDns>;

function nodeRow(id: string) {
  return sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown>;
}
function environmentRow() {
  return sqlite.prepare('SELECT * FROM deployment_environments WHERE id = ?').get(ENV_ID) as Record<
    string,
    unknown
  >;
}

async function seedNode(id: string, ip: string, overrides: Partial<schema.Node> = {}) {
  await drizzle(env.DATABASE)
    .insert(schema.nodes)
    .values({
      id,
      userId: 'user',
      name: id,
      status: 'running',
      runtime: 'vm',
      nodeClass: 'managed',
      nodeRole: 'deployment',
      workloadRole: 'deployment',
      vmSize: 'small',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      providerInstanceId: `vm-${id}`,
      runtimeIncarnationId: `incarnation-${id}`,
      ipAddress: ip,
      createdAt: '2026-10-22T08:53:43.601Z',
      updatedAt: '2026-10-22T08:53:43.601Z',
      placementCredentialSource: 'user',
      placementCredentialReference: 'credentials:original',
      placementCredentialVersion: 1,
      placementCredentialFingerprint: 'sha256:original',
      capacityPoolId: 'pool',
      capacityPoolScope: 'user',
      capacityPoolRevision: 1,
      capacitySourceId: 'source',
      capacitySourceGeneration: 1,
      capacityPoolCandidateId: 'candidate',
      providerInstanceType: 'cx23',
      providerInstanceVcpuCount: 2,
      providerInstanceMemoryMb: 4096,
      ...overrides,
    });
}

function manifest() {
  return JSON.stringify({
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
    routes: [{ service: 'web', port: 80, mode: 'public' }],
  });
}

async function seedWorld(): Promise<FakeDnsRecord[]> {
  sqlite
    .prepare(
      "INSERT INTO projects (id, user_id, name, repository, installation_id) VALUES ('project','user','p','o/r','inst')"
    )
    .run();
  await seedNode('node', OLD_IP);
  await seedNode('other-node', OTHER_IP);
  for (const [id, nodeId] of [
    [ENV_ID, 'node'],
    [OTHER_ENV_ID, 'other-node'],
  ] as const) {
    await drizzle(env.DATABASE)
      .insert(schema.deploymentEnvironments)
      .values({
        id,
        projectId: 'project',
        name: id,
        nodeId,
        status: 'active',
      } as schema.NewDeploymentEnvironmentRow);
  }
  sqlite
    .prepare(
      "INSERT INTO deployment_releases (id, environment_id, version, manifest, status) VALUES ('release-1', ?, 1, ?, 'applied')"
    )
    .run(ENV_ID, manifest());
  return [
    { id: 'route', name: routeHost(ENV_ID), type: 'A', content: OLD_IP },
    { id: 'other-route', name: routeHost(OTHER_ENV_ID), type: 'A', content: OTHER_IP },
    // Outside the app-route namespace, on the same IP: must survive.
    { id: 'api', name: `api.${BASE}`, type: 'A', content: OLD_IP },
    { id: 'ws', name: `ws-abc.${BASE}`, type: 'A', content: OLD_IP },
  ];
}

function lifecycleApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((e, c) => c.json({ message: e.message }, e instanceof AppError ? e.statusCode : 500));
  registerDeploymentEnvironmentLifecycleRoutes(app);
  return app;
}
const stop = () =>
  lifecycleApp().request(`/project/environments/${ENV_ID}/stop`, { method: 'POST' }, env);
const start = () =>
  lifecycleApp().request(`/project/environments/${ENV_ID}/start`, { method: 'POST' }, env);

async function releaseFetch(nodeId: string, seq: number) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((e, c) => c.json({ message: e.message }, e instanceof AppError ? e.statusCode : 500));
  app.route('/api/nodes', deployReleaseCallbackRoute);
  return app.request(
    `/api/nodes/${nodeId}/deploy-release?seq=${seq}&environmentId=${ENV_ID}`,
    { headers: { Authorization: `Bearer callback-${nodeId}` } },
    env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
  );
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
    BASE_DOMAIN: BASE,
    CF_ZONE_ID: ZONE,
    CF_API_TOKEN: TOKEN,
    DNS_TTL_SECONDS: '120',
    DEPLOY_PAYLOAD_EXPIRY_SECONDS: '90',
    DEPLOYMENT_ROUTE_PORT_BASE: '36000',
    DEPLOYMENT_ROUTE_PORT_SPAN: '100',
    DEPLOY_SIGNING_PRIVATE_KEY: 'test-private-key',
    R2_BUCKET_NAME: 'sam-artifacts',
  } as unknown as Env;
  vi.clearAllMocks();
  provider.deleteVM.mockResolvedValue(undefined);
  provider.listVMs.mockResolvedValue([]);
  zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
  vi.stubGlobal('fetch', vi.fn(zone.fetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

describe('stopping a deployment environment releases its app-route DNS', () => {
  it('deletes the route record with the node, and Start recreates it through the release fetch', async () => {
    const stopped = await stop();
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    expect(nodeRow('node')).toMatchObject({ status: 'deleted', ip_address: null });
    expect(environmentRow()).toMatchObject({ status: 'stopped', node_id: null });
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    // Another environment's live route and every non-app record on the same IP are untouched.
    expect(zone.records.has('other-route')).toBe(true);
    expect(zone.records.has('api')).toBe(true);
    expect(zone.records.has('ws')).toBe(true);

    vi.mocked(provisionDeploymentNode).mockImplementation(async () => {
      await seedNode('replacement', NEW_IP);
      sqlite
        .prepare("UPDATE deployment_environments SET node_id = 'replacement' WHERE id = ?")
        .run(ENV_ID);
      return {
        nodeId: 'replacement',
        provisioningStarted: false,
        provisioningPromise: Promise.resolve(),
      };
    });
    const started = await start();
    expect(started.status, await started.clone().text()).toBe(200);
    const pending = sqlite
      .prepare(
        "SELECT version FROM deployment_releases WHERE environment_id = ? AND status = 'created'"
      )
      .get(ENV_ID) as { version: number } | undefined;
    expect(pending).toBeDefined();

    // The replacement node boots and fetches its release, which upserts the route record.
    const fetched = await releaseFetch('replacement', pending!.version);
    expect(fetched.status, await fetched.clone().text()).toBe(200);
    expect(zone.byName(routeHost(ENV_ID)).map((r) => r.content)).toEqual([NEW_IP]);
  });

  it('keeps the node retryable when the route record cannot be deleted, then finishes on retry', async () => {
    let failDeletes = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        failDeletes && init?.method === 'DELETE'
          ? new Response(JSON.stringify({ errors: [{ code: 10000, message: 'dns down' }] }), {
              status: 500,
            })
          : zone.fetch(input, init)
      )
    );
    expect((await stop()).status).toBe(409);
    // The records go before the VM: with DNS down, the VM (and the IP its records name) is kept.
    expect(provider.deleteVM).not.toHaveBeenCalled();
    expect(nodeRow('node')).toMatchObject({ status: 'destroying', ip_address: OLD_IP });
    expect(nodeRow('node').runtime_termination_confirmed_at).toBeNull();
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);

    expect(environmentRow()).toMatchObject({ status: 'error', node_id: 'node' });

    failDeletes = false;
    const retried = await stop();
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    expect(nodeRow('node')).toMatchObject({ status: 'deleted', ip_address: null });
    expect(provider.deleteVM).toHaveBeenCalledTimes(1);
  });
});

describe('a release fetch that lands during the provider deletion', () => {
  it('cannot leave a route record pointing at the released IP', async () => {
    // A fetch admitted before the claim upserts the record after the pre-deletion pass listed.
    provider.deleteVM.mockImplementation(async () => {
      await zone.fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'A',
          name: routeHost(ENV_ID),
          content: OLD_IP,
          proxied: false,
        }),
      });
    });
    const stopped = await stop();
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    expect(provider.deleteVM).toHaveBeenCalledTimes(1);
    expect(nodeRow('node')).toMatchObject({ status: 'deleted', ip_address: null });
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    expect(zone.records.has('other-route')).toBe(true);
  });
});

describe('every other deployment-node release path reaches the same cleanup', () => {
  it('a failed start removes the record its replacement node served', async () => {
    sqlite
      .prepare("UPDATE deployment_environments SET status = 'stopped', node_id = NULL WHERE id = ?")
      .run(ENV_ID);
    sqlite
      .prepare("UPDATE nodes SET status = 'deleted', ip_address = NULL WHERE id = 'node'")
      .run();
    zone.records.delete('route');
    vi.mocked(provisionDeploymentNode).mockImplementation(async () => {
      await seedNode('replacement', NEW_IP);
      sqlite
        .prepare("UPDATE deployment_environments SET node_id = 'replacement' WHERE id = ?")
        .run(ENV_ID);
      // The node came up far enough to fetch its release before the start failed.
      zone.records.set('replacement-route', {
        id: 'replacement-route',
        name: routeHost(ENV_ID),
        type: 'A',
        content: NEW_IP,
      });
      return {
        nodeId: 'replacement',
        provisioningStarted: false,
        provisioningPromise: Promise.reject(new Error('volume attach failed')),
      };
    });
    const started = await start();
    expect(started.status).toBeGreaterThanOrEqual(400);
    // Whatever the start path leaves for the backstop, the backstop finishes it.
    await runDeploymentNodeCleanup(env);
    expect(nodeRow('replacement').status).toBe('deleted');
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    expect(zone.records.has('other-route')).toBe(true);
  });

  it('the scheduled backstop deletes the records of an interrupted teardown', async () => {
    sqlite.prepare("UPDATE nodes SET status = 'destroying' WHERE id = 'node'").run();
    sqlite
      .prepare("UPDATE deployment_environments SET status = 'stopping' WHERE id = ?")
      .run(ENV_ID);
    expect(await runDeploymentNodeCleanup(env)).toMatchObject({ deleted: 1, failed: 0 });
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    expect(zone.records.has('other-route')).toBe(true);
    expect(zone.records.has('api')).toBe(true);
  });

  it('node and environment delete (deleteNodeResources) remove the records of the deleted node', async () => {
    const result = await deleteNodeResources('node', 'user', env);
    expect(result).toMatchObject({ runtimeTerminationConfirmed: true, errors: [] });
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    expect(zone.records.has('other-route')).toBe(true);
    expect(zone.records.has('api')).toBe(true);
    expect(zone.records.has('ws')).toBe(true);
  });
});
