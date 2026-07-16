import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const deploymentEnvironments = {
  id: 'deploymentEnvironments.id',
  projectId: 'deploymentEnvironments.projectId',
  nodeId: 'deploymentEnvironments.nodeId',
  status: 'deploymentEnvironments.status',
  desiredRoutingRevision: 'deploymentEnvironments.desiredRoutingRevision',
  observedRoutingRevision: 'deploymentEnvironments.observedRoutingRevision',
  observedRoutingStatus: 'deploymentEnvironments.observedRoutingStatus',
  observedRoutingError: 'deploymentEnvironments.observedRoutingError',
  configUpdatedAt: 'deploymentEnvironments.configUpdatedAt',
};
const deploymentCustomDomains = {
  id: 'deploymentCustomDomains.id',
  environmentId: 'deploymentCustomDomains.environmentId',
  service: 'deploymentCustomDomains.service',
  port: 'deploymentCustomDomains.port',
  routeIndex: 'deploymentCustomDomains.routeIndex',
  hostname: 'deploymentCustomDomains.hostname',
  verificationStatus: 'deploymentCustomDomains.verificationStatus',
  verificationError: 'deploymentCustomDomains.verificationError',
  verifiedAt: 'deploymentCustomDomains.verifiedAt',
  verifiedCnameTarget: 'deploymentCustomDomains.verifiedCnameTarget',
  desiredState: 'deploymentCustomDomains.desiredState',
  routingStatus: 'deploymentCustomDomains.routingStatus',
  activationRoutingRevision: 'deploymentCustomDomains.activationRoutingRevision',
  deactivationRoutingRevision: 'deploymentCustomDomains.deactivationRoutingRevision',
  deletedAt: 'deploymentCustomDomains.deletedAt',
  createdBy: 'deploymentCustomDomains.createdBy',
  createdAt: 'deploymentCustomDomains.createdAt',
};
const deploymentCustomDomainEvents = {
  id: 'deploymentCustomDomainEvents.id',
};
const deploymentReleases = {
  id: 'deploymentReleases.id',
  environmentId: 'deploymentReleases.environmentId',
  version: 'deploymentReleases.version',
  manifest: 'deploymentReleases.manifest',
  source: 'deploymentReleases.source',
  status: 'deploymentReleases.status',
};
const deploymentVolumes = {
  id: 'deploymentVolumes.id',
  environmentId: 'deploymentVolumes.environmentId',
  name: 'deploymentVolumes.name',
  providerVolumeId: 'deploymentVolumes.providerVolumeId',
  providerName: 'deploymentVolumes.providerName',
  linuxDevice: 'deploymentVolumes.linuxDevice',
  attachedServerId: 'deploymentVolumes.attachedServerId',
  createdAt: 'deploymentVolumes.createdAt',
};
const nodes = {
  id: 'nodes.id',
  userId: 'nodes.userId',
  ipAddress: 'nodes.ipAddress',
};
const projects = {
  id: 'projects.id',
  userId: 'projects.userId',
};

type Condition =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'lt'; col: unknown; val: unknown }
  | { op: 'isNull'; col: unknown }
  | { op: 'and'; conds: Condition[] }
  | undefined;

interface EnvironmentRow {
  id: string;
  projectId: string;
  nodeId: string | null;
  status: string;
  desiredRoutingRevision: number;
  observedRoutingRevision: number;
  observedRoutingStatus: string | null;
  observedRoutingError: string | null;
  configUpdatedAt: string | null;
}

interface ProjectRow {
  id: string;
  userId: string;
}

interface NodeRow {
  id: string;
  userId: string;
  ipAddress: string | null;
}

interface ReleaseRow {
  id: string;
  environmentId: string;
  version: number;
  manifest: string;
  source: string | null;
  status: string;
}

interface DomainRow {
  id: string;
  environmentId: string;
  service: string;
  port: number;
  routeIndex: number;
  hostname: string;
  verificationStatus: 'pending' | 'verified' | 'failed';
  verificationError: string | null;
  verifiedAt: string | null;
  verifiedCnameTarget: string | null;
  desiredState: 'active' | 'deactivating' | 'deleted';
  routingStatus: string;
  activationRoutingRevision: number | null;
  deactivationRoutingRevision: number | null;
  deletedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface VolumeRow {
  id: string;
  environmentId: string;
  name: string;
  providerVolumeId: string;
  providerName: string;
  linuxDevice: string | null;
  attachedServerId: string | null;
  createdAt: string;
}

const mockRequireProjectAccess = vi.fn();
const mockRequireProjectCapability = vi.fn();
const mockSignDeployPayload = vi.fn();
const mockVerifyCallbackToken = vi.fn();
const mockMintProjectRegistryCredential = vi.fn();
const mockLoadResolvedSecrets = vi.fn();
const mockLoadDeploymentInterpolationEnv = vi.fn();

let envRows: EnvironmentRow[] = [];
let projectRows: ProjectRow[] = [];
let nodeRows: NodeRow[] = [];
let releaseRows: ReleaseRow[] = [];
let domainRows: DomainRow[] = [];
let volumeRows: VolumeRow[] = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  lte: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  }),
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentCustomDomainEvents,
  deploymentCustomDomains,
  deploymentEnvironments,
  deploymentReleases,
  deploymentVolumes,
  nodes,
  projects,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  requireProjectCapability: (...args: unknown[]) => mockRequireProjectCapability(...args),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: unknown[]) => mockVerifyCallbackToken(...args),
}));

vi.mock('../../../src/services/deploy-signing', () => ({
  signDeployPayload: (...args: unknown[]) => mockSignDeployPayload(...args),
}));

vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: (...args: unknown[]) => mockMintProjectRegistryCredential(...args),
}));

vi.mock('../../../src/routes/deployment-releases', () => ({
  getEncryptionKey: () => 'test-encryption-key',
  loadResolvedSecrets: (...args: unknown[]) => mockLoadResolvedSecrets(...args),
}));

vi.mock('../../../src/services/deployment-environment-config', () => ({
  loadDeploymentInterpolationEnv: (...args: unknown[]) =>
    mockLoadDeploymentInterpolationEnv(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'domain-1',
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

const { deployReleaseCallbackRoute } = await import('../../../src/routes/deploy-release-callback');
const { deploymentCustomDomainRoutes } =
  await import('../../../src/routes/deployment-custom-domains');

function eqValue(condition: Condition, col: unknown): unknown {
  if (!condition) {
    return undefined;
  }
  if (condition.op === 'eq') {
    return condition.col === col ? condition.val : undefined;
  }
  if (condition.op === 'lt' || condition.op === 'isNull') {
    return undefined;
  }
  for (const child of condition.conds) {
    const value = eqValue(child, col);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function ltValue(condition: Condition, col: unknown): unknown {
  if (!condition) {
    return undefined;
  }
  if (condition.op === 'lt') {
    return condition.col === col ? condition.val : undefined;
  }
  if (condition.op === 'eq' || condition.op === 'isNull') {
    return undefined;
  }
  for (const child of condition.conds) {
    const value = ltValue(child, col);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function projectSelection<T extends Record<string, unknown>>(
  row: T,
  selection?: Record<string, unknown>
): T | Record<string, unknown> {
  if (!selection) {
    return row;
  }
  return Object.fromEntries(
    Object.entries(selection).map(([key, column]) => {
      const prop = String(column).split('.').at(-1) ?? '';
      return [key, row[prop]];
    })
  );
}

function selectRows(table: unknown, condition: Condition, selection?: Record<string, unknown>) {
  let rows: Record<string, unknown>[] = [];
  if (table === nodes) {
    const id = eqValue(condition, nodes.id);
    rows = nodeRows.filter((row) => id === undefined || row.id === id);
  } else if (table === deploymentEnvironments) {
    const id = eqValue(condition, deploymentEnvironments.id);
    const projectId = eqValue(condition, deploymentEnvironments.projectId);
    const nodeId = eqValue(condition, deploymentEnvironments.nodeId);
    const projectUserId = eqValue(condition, projects.userId);
    rows = envRows.filter((row) => {
      const project = projectRows.find((candidate) => candidate.id === row.projectId);
      return (
        (id === undefined || row.id === id) &&
        (projectId === undefined || row.projectId === projectId) &&
        (nodeId === undefined || row.nodeId === nodeId) &&
        (projectUserId === undefined || project?.userId === projectUserId)
      );
    });
  } else if (table === deploymentReleases) {
    const environmentId = eqValue(condition, deploymentReleases.environmentId);
    const version = eqValue(condition, deploymentReleases.version);
    const versionLt = ltValue(condition, deploymentReleases.version);
    rows = releaseRows
      .filter((row) => {
        return (
          (environmentId === undefined || row.environmentId === environmentId) &&
          (version === undefined || row.version === version) &&
          (versionLt === undefined || row.version < Number(versionLt))
        );
      })
      .sort((a, b) => (b.version as number) - (a.version as number));
  } else if (table === deploymentCustomDomains) {
    const id = eqValue(condition, deploymentCustomDomains.id);
    const environmentId = eqValue(condition, deploymentCustomDomains.environmentId);
    const hostname = eqValue(condition, deploymentCustomDomains.hostname);
    const verificationStatus = eqValue(condition, deploymentCustomDomains.verificationStatus);
    rows = domainRows.filter((row) => {
      return (
        (id === undefined || row.id === id) &&
        (environmentId === undefined || row.environmentId === environmentId) &&
        (hostname === undefined || row.hostname === hostname) &&
        (verificationStatus === undefined || row.verificationStatus === verificationStatus)
      );
    });
  } else if (table === deploymentVolumes) {
    const environmentId = eqValue(condition, deploymentVolumes.environmentId);
    rows = volumeRows.filter((row) => {
      return environmentId === undefined || row.environmentId === environmentId;
    });
  }
  return rows.map((row) => projectSelection(row, selection));
}

function createQueryChain(table: unknown, selection?: Record<string, unknown>) {
  let condition: Condition;
  const chain = {
    innerJoin: () => chain,
    where: (nextCondition: Condition) => {
      condition = nextCondition;
      return chain;
    },
    orderBy: () => chain,
    limit: async (count: number) => selectRows(table, condition, selection).slice(0, count),
    then: (
      resolve: (value: Record<string, unknown>[]) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(selectRows(table, condition, selection)).then(resolve, reject),
  };
  return chain;
}

function createMockDb() {
  return {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => createQueryChain(table, selection)),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Partial<DomainRow>) => {
        if (table === deploymentCustomDomainEvents) {
          return;
        }
        if (table === deploymentCustomDomains) {
          domainRows.push({
            id: values.id ?? 'domain-1',
            environmentId: values.environmentId ?? 'env-1',
            service: values.service ?? 'web',
            port: values.port ?? 3000,
            routeIndex: values.routeIndex ?? 0,
            hostname: values.hostname ?? 'app.customer.example.com',
            verificationStatus: values.verificationStatus ?? 'pending',
            verificationError: values.verificationError ?? null,
            verifiedAt: values.verifiedAt ?? null,
            verifiedCnameTarget: values.verifiedCnameTarget ?? null,
            desiredState: values.desiredState ?? 'active',
            routingStatus: values.routingStatus ?? 'pending_dns',
            activationRoutingRevision: values.activationRoutingRevision ?? null,
            deactivationRoutingRevision: values.deactivationRoutingRevision ?? null,
            deletedAt: values.deletedAt ?? null,
            createdBy: values.createdBy ?? 'user-1',
            createdAt: values.createdAt ?? '2026-06-24T00:00:00.000Z',
          });
        }
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Partial<DomainRow> | Partial<ReleaseRow> | Partial<EnvironmentRow>) => ({
        where: vi.fn(async (condition: Condition) => {
          const rows =
            table === deploymentCustomDomains
              ? (selectRows(table, condition) as DomainRow[])
              : (selectRows(table, condition) as ReleaseRow[]);
          for (const row of rows) {
            if (
              table === deploymentEnvironments &&
              'desiredRoutingRevision' in values &&
              typeof values.desiredRoutingRevision !== 'number'
            ) {
              (row as EnvironmentRow).desiredRoutingRevision += 1;
              const rest = { ...values };
              delete rest.desiredRoutingRevision;
              Object.assign(row, rest);
            } else {
              Object.assign(row, values);
            }
          }
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async (condition: Condition) => {
        if (table === deploymentCustomDomains) {
          const rowsToDelete = new Set(selectRows(table, condition) as DomainRow[]);
          domainRows = domainRows.filter((row) => !rowsToDelete.has(row));
        }
      }),
    })),
  };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', deploymentCustomDomainRoutes);
  app.route('/api/nodes', deployReleaseCallbackRoute);
  return app;
}

function env(): Env {
  return {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'sammy.party',
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
    DNS_TTL_SECONDS: '120',
    DEPLOY_PAYLOAD_EXPIRY_SECONDS: '90',
    DEPLOYMENT_ROUTE_PORT_BASE: '36000',
    DEPLOYMENT_ROUTE_PORT_SPAN: '10',
    DEPLOY_SIGNING_PRIVATE_KEY: 'test-private-key',
    CF_ACCOUNT_ID: 'account-1',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET_NAME: 'sam-artifacts',
    DOH_RESOLVER_URL: 'https://cloudflare-dns.com/dns-query',
    DOH_TIMEOUT_MS: '10000',
  } as Env;
}

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
    routes: [{ service: 'web', port: 3000, mode: 'public' }],
  };
}

describe('deployment custom domain attach verify apply flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockRequireProjectAccess.mockResolvedValue(undefined);
    mockRequireProjectCapability.mockResolvedValue(undefined);
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-deploy-1',
      type: 'callback',
      scope: 'node',
    });
    mockSignDeployPayload.mockResolvedValue('signed-payload');
    mockMintProjectRegistryCredential.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'cf-mint-user',
      password: 'cf-mint-secret',
      namespace: 'account-1/sam-proj-1',
      expiresAt: '2026-06-24T00:10:00.000Z',
    });
    mockLoadResolvedSecrets.mockResolvedValue({});
    mockLoadDeploymentInterpolationEnv.mockResolvedValue({ values: {} });
    projectRows = [{ id: 'proj-1', userId: 'user-1' }];
    nodeRows = [{ id: 'node-deploy-1', userId: 'user-1', ipAddress: '203.0.113.10' }];
    envRows = [
      {
        id: 'env-1',
        projectId: 'proj-1',
        nodeId: 'node-deploy-1',
        status: 'active',
        desiredRoutingRevision: 0,
        observedRoutingRevision: 0,
        observedRoutingStatus: null,
        observedRoutingError: null,
        configUpdatedAt: null,
      },
    ];
    releaseRows = [
      {
        id: 'rel-1',
        environmentId: 'env-1',
        version: 7,
        manifest: JSON.stringify(manifest()),
        source: null,
        status: 'created',
      },
    ];
    domainRows = [];
    volumeRows = [];
  });

  it('attaches, verifies, and signs a custom domain route without upserting user DNS', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [
              {
                name: 'app.customer.example.com.',
                type: 5,
                data: 'r1-web-3000-env-1.apps.sammy.party.',
              },
              { name: 'r1-web-3000-env-1.apps.sammy.party.', type: 1, data: '203.0.113.10' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/dns_records?')) {
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      if (url.endsWith('/dns_records') && init?.method === 'POST') {
        return new Response(JSON.stringify({ result: { id: 'dns-route-1' } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp();
    const attachResponse = await app.request(
      '/api/projects/proj-1/environments/env-1/custom-domains',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: 'web',
          port: 3000,
          hostname: 'App.Customer.Example.com',
        }),
      },
      env()
    );
    const attached = (await attachResponse.json()) as {
      cnameTarget: string;
      verificationStatus: string;
    };

    expect(attachResponse.status, JSON.stringify(attached)).toBe(201);
    expect(attached).toMatchObject({
      cnameTarget: 'r1-web-3000-env-1.apps.sammy.party',
      verificationStatus: 'pending',
    });

    const verifyResponse = await app.request(
      '/api/projects/proj-1/environments/env-1/custom-domains/domain-1/verify',
      { method: 'POST' },
      env()
    );
    const verified = (await verifyResponse.json()) as { verificationStatus: string };

    expect(verifyResponse.status, JSON.stringify(verified)).toBe(200);
    expect(verified.verificationStatus).toBe('verified');
    expect(domainRows).toContainEqual(
      expect.objectContaining({
        hostname: 'app.customer.example.com',
        service: 'web',
        port: 3000,
        verificationStatus: 'verified',
      })
    );

    const applyResponse = await app.request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );
    const applyBody = (await applyResponse.json()) as {
      routes: Array<{ hostname: string; service: string; containerPort: number; hostPort: number }>;
    };

    expect(applyResponse.status, JSON.stringify(applyBody)).toBe(200);
    const parentRoute = applyBody.routes.find(
      (route) => route.hostname === 'r1-web-3000-env-1.apps.sammy.party'
    );
    expect(parentRoute).toBeDefined();
    expect(applyBody.routes).toContainEqual({
      hostname: 'app.customer.example.com',
      service: 'web',
      containerPort: 3000,
      hostPort: parentRoute?.hostPort,
    });
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({ routes: applyBody.routes }),
      expect.anything()
    );

    const cloudflareCreates = fetchMock.mock.calls.filter(([input, init]) => {
      return String(input).includes('api.cloudflare.com') && init?.method === 'POST';
    });
    expect(cloudflareCreates).toHaveLength(1);
    const [, createInit] = cloudflareCreates[0] as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(createInit.body as string)).toMatchObject({
      name: 'r1-web-3000-env-1.apps.sammy.party',
      content: '203.0.113.10',
      proxied: false,
    });
    expect(JSON.stringify(createInit.body)).not.toContain('app.customer.example.com');
  });
});
