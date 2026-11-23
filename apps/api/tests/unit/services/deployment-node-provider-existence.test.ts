/**
 * Provider-existence reconciliation of running deployment nodes (idea 01M81Z9P6QFX4M9Q83K2XKGZVR),
 * through its real entry point on a real SQL engine:
 *
 *   runDeploymentNodeProviderExistenceSweep
 *     -> probeDeploymentNodeInstance -> real HetznerProvider / GcpProvider -> provider API fake
 *     -> claimAbsentNodeRelease -> cleanupDeploymentNode -> deleteNodeResourcesStrict
 *        -> releaseNodeAppRouteDnsRecords -> Cloudflare DNS fake
 *
 * Only the credential lookup is replaced: it hands the real provider adapter the token of the
 * account the credential names, so a lookup through the wrong account really gets that account's
 * 404. The Hetzner fake enforces the API contract SAM relies on (bearer auth per project, the
 * documented error envelope and codes, DELETE 404 for a missing server) and fails the test on any
 * request outside the APIs it models.
 */
import { GcpProvider, HetznerProvider } from '@simple-agent-manager/providers';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runDeploymentNodeProviderExistenceSweep } from '../../../src/services/deployment-node-provider-existence';
import { createFakeCloudflareDns } from '../../helpers/fake-cloudflare-dns';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const settings = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
const accounts = vi.hoisted(() => ({
  /** credentialReference -> provider instance built with that account's token */
  build: (_reference: string | undefined, _provider: string): unknown => null,
}));

vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn(async (_env: unknown, name: string) => settings.values.get(name)),
}));
vi.mock('../../../src/services/provider-credentials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/provider-credentials')>();
  return {
    ...actual,
    createProviderForUser: vi.fn(
      async (
        _db: unknown,
        _userId: string,
        _key: string,
        _env: unknown,
        provider: string,
        _projectId: unknown,
        exact?: { credentialReference?: string }
      ) => {
        const instance = accounts.build(exact?.credentialReference, provider);
        if (!instance) return null;
        return {
          provider: instance,
          providerName: provider,
          credentialSource: 'user',
          ...(exact ? { exactCredentialBinding: exact } : {}),
        };
      }
    ),
  };
});
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'test-key' }));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentEnvironmentLifecycleEventBestEffort: vi.fn(async () => undefined),
  recordDeploymentReleaseLifecycleEventBestEffort: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/node-log-capture', () => ({
  captureNodeLogsBeforeTeardown: vi.fn(async () => undefined),
}));

const ZONE = 'zone-1';
const CF_TOKEN = 'cf-token';
const BASE = 'example.com';
const ACCOUNT_A = 'hetzner-token-project-a';
const ACCOUNT_B = 'hetzner-token-project-b';
const ENV_ID = '01KVJDV913S8W7KK32HTZTK0H8';
const OTHER_ENV_ID = '01KVJDV913S8W7KK32HTZTK0H9';
const IP = '198.51.100.10';
const OTHER_IP = '198.51.100.30';
const T0 = new Date('2026-11-23T10:00:00.000Z');
const MINUTE = 60_000;
const routeHost = (envId: string) => `r1-web-80-${envId.toLowerCase()}.apps.${BASE}`;

/** Hetzner Cloud API fake: one project per token, each with its own servers. */
function createFakeHetzner() {
  const projects = new Map<string, Map<string, Record<string, unknown>>>([
    [ACCOUNT_A, new Map()],
    [ACCOUNT_B, new Map()],
  ]);
  /** Per server id: answer every request for it with this status instead (outage modelling). */
  const forced = new Map<string, number>();
  const requests: Array<{ method: string; path: string; token: string }> = [];
  const err = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  async function handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    const token = auth.replace(/^Bearer /, '');
    requests.push({ method, path: url.pathname, token });
    const project = projects.get(token);
    if (!project) return err(401, 'unauthorized', 'unable to authenticate');
    const match = /^\/v1\/servers\/(\d+)$/.exec(url.pathname);
    if (!match) throw new Error(`Hetzner fake: unmodelled request ${method} ${url.pathname}`);
    const id = match[1]!;
    const status = forced.get(id);
    if (status === 401) return err(401, 'unauthorized', 'unable to authenticate');
    if (status === 403) return err(403, 'forbidden', 'insufficient permissions');
    if (status === 429) return err(429, 'rate_limit_exceeded', 'limit of 3600 requests per hour');
    if (status === 503) return err(503, 'unavailable', 'service unavailable');
    if (status === -1) return new Promise<Response>(() => undefined); // never answers
    const server = project.get(id);
    if (!server) return err(404, 'not_found', `server with ID '${id}' not found`);
    if (method === 'DELETE') {
      project.delete(id);
      return new Response(JSON.stringify({ action: { id: 1, status: 'running' } }), { status: 200 });
    }
    if (method !== 'GET') throw new Error(`Hetzner fake: unmodelled ${method}`);
    return new Response(JSON.stringify({ server }), { status: 200 });
  }
  return {
    projects,
    forced,
    requests,
    handle,
    addServer(token: string, id: string, ip = IP) {
      projects.get(token)!.set(id, {
        id: Number(id),
        name: `sam-${id}`,
        status: 'running',
        public_net: { ipv4: { ip } },
        server_type: { name: 'cx23' },
        created: '2026-11-20T00:00:00Z',
        labels: {},
      });
    },
  };
}

/** GCP Compute fake for the self-host box path: zonal GET plus the aggregated list. */
function createFakeGcp(project: string, zone: string) {
  const instances = new Map<string, Record<string, unknown>>();
  async function handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const base = `/compute/v1/projects/${project}`;
    if (url.pathname === `${base}/aggregated/instances`) {
      return json({ items: { [`zones/${zone}`]: { instances: [...instances.values()] } } });
    }
    const zonal = new RegExp(`^${base}/zones/([^/]+)/instances/([^/]+)$`).exec(url.pathname);
    if (zonal) {
      const instance = zonal[1] === zone ? instances.get(zonal[2]!) : undefined;
      if (!instance) return json({ error: { code: 404, message: 'not found' } }, 404);
      if (method === 'DELETE') {
        instances.delete(zonal[2]!);
        return json({ name: 'op-1', status: 'DONE', zone });
      }
      return json(instance);
    }
    if (url.pathname.includes('/operations/')) return json({ name: 'op-1', status: 'DONE' });
    throw new Error(`GCP fake: unmodelled request ${method} ${url.pathname}`);
  }
  return {
    instances,
    handle,
    add(name: string) {
      instances.set(name, {
        id: '9001',
        name,
        zone: `zones/${zone}`,
        status: 'RUNNING',
        creationTimestamp: '2026-11-20T00:00:00Z',
        machineType: `zones/${zone}/machineTypes/e2-standard-2`,
        labels: { 'sam-managed': 'true' },
        networkInterfaces: [{ accessConfigs: [{ natIP: IP }] }],
      });
    },
  };
}

let sqlite: Database.Database;
let env: Env;
let hetzner: ReturnType<typeof createFakeHetzner>;
let gcp: ReturnType<typeof createFakeGcp>;
let zone: ReturnType<typeof createFakeCloudflareDns>;

function nodeRow(id: string) {
  return sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown>;
}
function envRow(id = ENV_ID) {
  return sqlite.prepare('SELECT * FROM deployment_environments WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}
function decisions(nodeId: string) {
  return sqlite
    .prepare(
      "SELECT decision, reason FROM node_lifecycle_decisions WHERE node_id = ? AND source = 'provider_existence' ORDER BY created_at, rowid"
    )
    .all(nodeId) as Array<{ decision: string; reason: string }>;
}

async function seedNode(id: string, overrides: Partial<schema.Node> = {}) {
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
      providerInstanceId: id,
      runtimeIncarnationId: `incarnation-${id}`,
      ipAddress: IP,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      placementCredentialSource: 'user',
      placementCredentialReference: 'credentials:account-a',
      placementCredentialVersion: 1,
      placementCredentialFingerprint: 'sha256:account-a',
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
async function seedEnvironment(id: string, nodeId: string, status = 'active') {
  await drizzle(env.DATABASE)
    .insert(schema.deploymentEnvironments)
    .values({ id, projectId: 'project', name: id, nodeId, status } as schema.NewDeploymentEnvironmentRow);
}

/** Run one sweep at `minutesAfterT0`. */
async function sweepAt(minutesAfterT0: number) {
  vi.setSystemTime(new Date(T0.getTime() + minutesAfterT0 * MINUTE));
  return await runDeploymentNodeProviderExistenceSweep(env);
}

const NODE = '4242';
const OTHER_NODE = '4343';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  settings.values.clear();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
    BASE_DOMAIN: BASE,
    CF_ZONE_ID: ZONE,
    CF_API_TOKEN: CF_TOKEN,
  } as unknown as Env;
  sqlite
    .prepare(
      "INSERT INTO projects (id, user_id, name, repository, installation_id) VALUES ('project','user','p','o/r','inst')"
    )
    .run();
  hetzner = createFakeHetzner();
  gcp = createFakeGcp('box-project', 'us-central1-a');
  accounts.build = (reference, provider) => {
    if (provider === 'gcp') return new GcpProvider('box-project', async () => 'gcp-token', 'us-central1-a');
    // The pinned account is A; any other credential the owner holds now is project B.
    return new HetznerProvider(reference === 'credentials:account-a' ? ACCOUNT_A : ACCOUNT_B);
  };
  await seedNode(NODE);
  await seedNode(OTHER_NODE, { ipAddress: OTHER_IP });
  await seedEnvironment(ENV_ID, NODE);
  await seedEnvironment(OTHER_ENV_ID, OTHER_NODE);
  hetzner.addServer(ACCOUNT_A, OTHER_NODE, OTHER_IP);
  zone = createFakeCloudflareDns({
    zoneId: ZONE,
    token: CF_TOKEN,
    seed: [
      { id: 'route', name: routeHost(ENV_ID), type: 'A', content: IP },
      { id: 'other-route', name: routeHost(OTHER_ENV_ID), type: 'A', content: OTHER_IP },
      { id: 'api', name: `api.${BASE}`, type: 'A', content: IP },
    ],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname === 'api.hetzner.cloud') return hetzner.handle(url, init);
      if (url.hostname === 'compute.googleapis.com') return gcp.handle(url, init);
      return zone.fetch(input, init);
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sqlite.close();
});

describe('a deployment VM deleted at the provider outside SAM', () => {
  it('is released after two not-found answers a confirmation interval apart, and its route DNS record is deleted', async () => {
    // NODE's server does not exist in account A (deleted in the Hetzner console).
    const first = await sweepAt(0);
    expect(first).toMatchObject({ absentObserved: 1, present: 1, released: 0 });
    expect(nodeRow(NODE)).toMatchObject({
      status: 'running',
      provider_absence_observed_at: T0.toISOString(),
      provider_absence_instance_id: NODE,
    });
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);

    // Within the confirmation interval the node is not even probed again.
    const early = await sweepAt(5);
    expect(early.probed).toBe(0);
    expect(nodeRow(NODE).status).toBe('running');

    const confirmed = await sweepAt(10);
    expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ released: 1 });
    expect(nodeRow(NODE)).toMatchObject({ status: 'deleted', ip_address: null });
    expect(nodeRow(NODE).runtime_termination_confirmed_at).not.toBeNull();
    expect(envRow()).toMatchObject({ status: 'stopped', node_id: null });
    expect(zone.byName(routeHost(ENV_ID))).toEqual([]);
    // The live environment's route and non-app records on the same IP survive.
    expect(zone.records.has('other-route')).toBe(true);
    expect(zone.records.has('api')).toBe(true);
    expect(nodeRow(OTHER_NODE).status).toBe('running');
    expect(envRow(OTHER_ENV_ID)).toMatchObject({ status: 'active', node_id: OTHER_NODE });
    // The teardown went through the pinned account only, and its DELETE met the 404 quietly.
    expect(hetzner.requests.filter((r) => r.path === `/v1/servers/${NODE}`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: 'DELETE', token: ACCOUNT_A })])
    );
    expect(hetzner.requests.every((r) => r.token === ACCOUNT_A)).toBe(true);
    expect(decisions(NODE)).toEqual([
      { decision: 'provider_instance_absent_observed', reason: 'first_not_found' },
      { decision: 'provider_instance_absent_confirmed', reason: 'released' },
    ]);
  });

  it('keeps a node after a single not-found', async () => {
    await sweepAt(0);
    expect(nodeRow(NODE)).toMatchObject({ status: 'running', ip_address: IP });
    expect(envRow()).toMatchObject({ status: 'active', node_id: NODE });
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);
    expect(hetzner.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('does not confirm across a present answer: the VM coming back clears the first not-found', async () => {
    await sweepAt(0);
    hetzner.addServer(ACCOUNT_A, NODE);
    const back = await sweepAt(10);
    expect(back.present).toBe(2);
    expect(nodeRow(NODE).provider_absence_observed_at).toBeNull();
    hetzner.projects.get(ACCOUNT_A)!.delete(NODE);
    // Due by the check interval (15 min) again, not the confirmation one.
    const again = await sweepAt(25);
    expect(again).toMatchObject({ absentObserved: 1, released: 0 });
    expect(nodeRow(NODE).status).toBe('running');
    expect((await sweepAt(35)).released).toBe(1);
  });
});

describe('absence is never inferred from a failed lookup', () => {
  it.each([
    [401, 'credential_rejected'],
    [403, 'credential_rejected'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ] as const)('a %s keeps the node, even right after a first not-found', async (status, reason) => {
    await sweepAt(0); // first not-found recorded
    hetzner.forced.set(NODE, status);
    for (let minute = 10; minute <= 120; minute += 10) await sweepAt(minute);
    expect(nodeRow(NODE)).toMatchObject({ status: 'running', ip_address: IP });
    expect(envRow()).toMatchObject({ status: 'active', node_id: NODE });
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);
    expect(hetzner.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(decisions(NODE)).toContainEqual({ decision: 'provider_check_inconclusive', reason });
    // Liveness: the lookups really ran and failed (not an empty sweep).
    expect(hetzner.requests.filter((r) => r.path === `/v1/servers/${NODE}`).length).toBeGreaterThan(1);
  });

  it('a lookup that times out keeps the node', async () => {
    settings.values.set('deploymentNodeExistence.requestTimeoutMs', 500);
    await sweepAt(0);
    hetzner.forced.set(NODE, -1);
    const result = await sweepAt(10);
    expect(result.inconclusive).toMatchObject({ timeout: 1 });
    expect(nodeRow(NODE).status).toBe('running');
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);
  });

  it('a not-found through a credential other than the pinned placement credential never counts', async () => {
    // The placement credential was rotated: it no longer resolves to its exact generation, so
    // only the owner's current credential (project B) is available, and project B cannot see
    // project A's server. That 404 is a wrong-account answer, not proof.
    hetzner.addServer(ACCOUNT_A, NODE);
    sqlite
      .prepare('UPDATE nodes SET placement_credential_fingerprint = NULL, placement_credential_version = NULL WHERE id = ?')
      .run(NODE);
    for (let minute = 0; minute <= 120; minute += 15) await sweepAt(minute);
    expect(nodeRow(NODE)).toMatchObject({ status: 'running', provider_absence_observed_at: null });
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);
    expect(decisions(NODE)).toContainEqual({
      decision: 'provider_check_inconclusive',
      reason: 'credential_not_pinned',
    });
  });

  it('a 429 stops lookups to that provider for the rest of the sweep', async () => {
    hetzner.forced.set(NODE, 429);
    hetzner.forced.set(OTHER_NODE, 429);
    const result = await sweepAt(0);
    expect(result.rateLimitedProviders).toEqual(['hetzner']);
    expect(hetzner.requests).toHaveLength(1);
    // The skipped node was not stamped, so it is first in line next sweep.
    const skipped = [NODE, OTHER_NODE].find((id) => nodeRow(id).provider_existence_checked_at === null);
    expect(skipped).toBeDefined();
  });
});

describe('what the reconciliation leaves alone', () => {
  it('a present VM is untouched and recorded once', async () => {
    hetzner.addServer(ACCOUNT_A, NODE);
    await sweepAt(0);
    await sweepAt(15);
    expect(nodeRow(NODE)).toMatchObject({ status: 'running', provider_absence_observed_at: null });
    expect(zone.byName(routeHost(ENV_ID))).toHaveLength(1);
    expect(decisions(NODE)).toEqual([{ decision: 'provider_instance_present', reason: 'present' }]);
  });

  it.each(['starting', 'stopping'])(
    'defers a confirmed absence while an environment is %s',
    async (status) => {
      await sweepAt(0);
      sqlite.prepare('UPDATE deployment_environments SET status = ? WHERE id = ?').run(status, ENV_ID);
      const result = await sweepAt(10);
      expect(result.deferred).toBe(1);
      expect(nodeRow(NODE).status).toBe('running');
      expect(envRow().status).toBe(status);
      // The absence is kept: once the other owner is done, the next confirmation releases it.
      sqlite.prepare("UPDATE deployment_environments SET status = 'active' WHERE id = ?").run(ENV_ID);
      expect((await sweepAt(20)).released).toBe(1);
    }
  );

  it('never probes a user-owned node, a workspace node, or a node not running', async () => {
    sqlite.prepare("UPDATE nodes SET node_class = 'user-owned' WHERE id = ?").run(NODE);
    await seedNode('5151', { nodeRole: 'workspace', workloadRole: 'workspace' });
    await seedNode('5252', { status: 'stopped' });
    await sweepAt(0);
    const probed = new Set(hetzner.requests.map((r) => r.path));
    expect(probed).toEqual(new Set([`/v1/servers/${OTHER_NODE}`]));
  });

  it('is off when disabled, and says so', async () => {
    settings.values.set('deploymentNodeExistence.enabled', false);
    const result = await sweepAt(0);
    expect(result).toMatchObject({ skipReason: 'disabled', probed: 0 });
    expect(hetzner.requests).toEqual([]);
  });
});

describe('bounded and resumable', () => {
  it('probes more nodes than one selection page in a single sweep', async () => {
    hetzner.addServer(ACCOUNT_A, NODE);
    for (let i = 0; i < 59; i++) {
      const id = String(6000 + i);
      await seedNode(id);
      hetzner.addServer(ACCOUNT_A, id);
    }
    const result = await sweepAt(0);
    expect(result).toMatchObject({ probed: 61, present: 61, reachedProbeCap: false });
  });

  it('stops at the probe cap and continues with the rest on the next sweep', async () => {
    settings.values.set('deploymentNodeExistence.maxProbesPerSweep', 1);
    hetzner.addServer(ACCOUNT_A, NODE);
    const first = await sweepAt(0);
    expect(first).toMatchObject({ probed: 1, reachedProbeCap: true });
    const second = await sweepAt(5);
    expect(second).toMatchObject({ probed: 1 });
    expect(nodeRow(NODE).provider_existence_checked_at).not.toBeNull();
    expect(nodeRow(OTHER_NODE).provider_existence_checked_at).not.toBeNull();
  });
});

describe('self-host box: a GCP deployment node behind the reverse tunnel', () => {
  const BOX_NODE = 'sam-box-node-1';
  beforeEach(async () => {
    sqlite.prepare('DELETE FROM deployment_environments').run();
    sqlite.prepare('DELETE FROM nodes').run();
    await seedNode(BOX_NODE, {
      cloudProvider: 'gcp',
      vmLocation: 'us-central1-a',
      transport: 'reverse-tunnel',
      providerInstanceId: BOX_NODE,
    });
    await seedEnvironment(ENV_ID, BOX_NODE);
  });

  it('leaves a present instance alone', async () => {
    gcp.add(BOX_NODE);
    await sweepAt(0);
    await sweepAt(15);
    expect(nodeRow(BOX_NODE)).toMatchObject({ status: 'running', provider_absence_observed_at: null });
    expect(envRow()).toMatchObject({ status: 'active', node_id: BOX_NODE });
  });

  it('releases an instance GCP confirms absent twice', async () => {
    await sweepAt(0);
    expect(nodeRow(BOX_NODE).status).toBe('running');
    const result = await sweepAt(10);
    expect(result.released, JSON.stringify(result)).toBe(1);
    expect(nodeRow(BOX_NODE).status).toBe('deleted');
    expect(envRow()).toMatchObject({ status: 'stopped', node_id: null });
  });
});
