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
const nodes = {
  id: 'nodes.id',
  ipAddress: 'nodes.ipAddress',
};

type Condition =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'isNull'; col: unknown }
  | { op: 'and'; conds: Condition[] }
  | undefined;

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
  routingStatus:
    | 'pending_dns'
    | 'failed'
    | 'activating'
    | 'active'
    | 'deactivating'
    | 'deactivated'
    | 'route_missing'
    | 'dns_recheck_required'
    | 'inactive_environment_stopped';
  activationRoutingRevision: number | null;
  deactivationRoutingRevision: number | null;
  deletedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

const mockRequireProjectAccess = vi.fn();
const mockRequireProjectCapability = vi.fn();
const mockGetEnvironmentPublicRouteTargets = vi.fn();
const mockRecordCustomDomainEvent = vi.fn();
const mockRequestRoutingRevision = vi.fn();
const mockVerifyCustomDomainTarget = vi.fn();

interface EnvironmentRow {
  id: string;
  projectId: string;
  nodeId: string | null;
  status: 'active' | 'starting' | 'stopped' | 'error';
  desiredRoutingRevision: number;
  observedRoutingRevision: number;
  observedRoutingStatus: string | null;
  observedRoutingError: string | null;
}

let envRows: EnvironmentRow[] = [];
let domainRows: DomainRow[] = [];
let nodeRows: Array<{ id: string; ipAddress: string | null }> = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentEnvironments,
  deploymentCustomDomains,
  nodes,
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

vi.mock('../../../src/services/deployment-custom-domains', () => ({
  customDomainExpectedTargetChanged: (domain: { verifiedCnameTarget?: string | null }, parent: { hostname: string } | null) =>
    !!domain.verifiedCnameTarget && !!parent && domain.verifiedCnameTarget !== parent.hostname,
  findRouteTargetForDomain: (routes: Array<{ service: string; containerPort: number }>, domain: { service: string; port: number }) =>
    routes.find((route) => route.service === domain.service && route.containerPort === domain.port) ?? null,
  getEnvironmentPublicRouteTargets: (...args: unknown[]) =>
    mockGetEnvironmentPublicRouteTargets(...args),
  recordCustomDomainEvent: (...args: unknown[]) => mockRecordCustomDomainEvent(...args),
  requestRoutingRevision: (...args: unknown[]) => mockRequestRoutingRevision(...args),
}));

vi.mock('../../../src/services/deployment-domain-verify', () => ({
  verifyCustomDomainTarget: (...args: unknown[]) => mockVerifyCustomDomainTarget(...args),
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

const { deploymentCustomDomainRoutes } =
  await import('../../../src/routes/deployment-custom-domains');

function eqValue(condition: Condition, col: unknown): unknown {
  if (!condition) {
    return undefined;
  }
  if (condition.op === 'eq') {
    return condition.col === col ? condition.val : undefined;
  }
  if (condition.op === 'isNull') {
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

function requiresNull(condition: Condition, col: unknown): boolean {
  if (!condition) {
    return false;
  }
  if (condition.op === 'isNull') {
    return condition.col === col;
  }
  if (condition.op === 'and') {
    return condition.conds.some((child) => requiresNull(child, col));
  }
  return false;
}

function selectRows(table: unknown, condition: Condition) {
  if (table === deploymentEnvironments) {
    const id = eqValue(condition, deploymentEnvironments.id);
    const projectId = eqValue(condition, deploymentEnvironments.projectId);
    return envRows.filter((row) => {
      return (
        (id === undefined || row.id === id) &&
        (projectId === undefined || row.projectId === projectId)
      );
    });
  }
  if (table === deploymentCustomDomains) {
    const id = eqValue(condition, deploymentCustomDomains.id);
    const environmentId = eqValue(condition, deploymentCustomDomains.environmentId);
    const hostname = eqValue(condition, deploymentCustomDomains.hostname);
    const deletedAtIsNull = requiresNull(condition, deploymentCustomDomains.deletedAt);
    return domainRows.filter((row) => {
      return (
        (id === undefined || row.id === id) &&
        (environmentId === undefined || row.environmentId === environmentId) &&
        (hostname === undefined || row.hostname === hostname) &&
        (!deletedAtIsNull || row.deletedAt === null)
      );
    });
  }
  if (table === nodes) {
    const id = eqValue(condition, nodes.id);
    return nodeRows.filter((row) => id === undefined || row.id === id);
  }
  return [];
}

function createMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: Condition) => ({
          limit: vi.fn(async () => selectRows(table, condition)),
          orderBy: vi.fn(async () => selectRows(table, condition)),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Partial<DomainRow>) => {
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
      set: vi.fn((values: Partial<DomainRow>) => ({
        where: vi.fn(async (condition: Condition) => {
          if (table === deploymentCustomDomains) {
            const rows = selectRows(table, condition) as DomainRow[];
            for (const row of rows) {
              Object.assign(row, values);
            }
          }
          if (table === deploymentEnvironments) {
            const rows = selectRows(table, condition) as EnvironmentRow[];
            for (const row of rows) {
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
  return app;
}

function request(path: string, init: RequestInit = {}) {
  return createApp().request(path, init, {
    DATABASE: {},
    BASE_DOMAIN: 'sammy.party',
  } as Env);
}

const parentRoute = {
  hostname: 'r1-web-3000-env-1.apps.sammy.party',
  service: 'web',
  containerPort: 3000,
  hostPort: 36000,
};

function makeDomainRow(overrides: Partial<DomainRow> = {}): DomainRow {
  return {
    id: 'domain-1',
    environmentId: 'env-1',
    service: 'web',
    port: 3000,
    routeIndex: 0,
    hostname: 'app.customer.example.com',
    verificationStatus: 'pending',
    verificationError: null,
    verifiedAt: null,
    verifiedCnameTarget: null,
    desiredState: 'active',
    routingStatus: 'pending_dns',
    activationRoutingRevision: null,
    deactivationRoutingRevision: null,
    deletedAt: null,
    createdBy: 'user-1',
    createdAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('deployment custom domain routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue(undefined);
    mockRequireProjectCapability.mockResolvedValue(undefined);
    mockGetEnvironmentPublicRouteTargets.mockResolvedValue([parentRoute]);
    mockRecordCustomDomainEvent.mockResolvedValue(undefined);
    mockRequestRoutingRevision.mockImplementation(async (_db: unknown, environmentId: string) => {
      const environment = envRows.find((row) => row.id === environmentId);
      if (!environment) {
        return 0;
      }
      environment.desiredRoutingRevision += 1;
      return environment.desiredRoutingRevision;
    });
    mockVerifyCustomDomainTarget.mockResolvedValue(true);
    envRows = [
      {
        id: 'env-1',
        projectId: 'proj-1',
        nodeId: 'node-1',
        status: 'active',
        desiredRoutingRevision: 0,
        observedRoutingRevision: 0,
        observedRoutingStatus: null,
        observedRoutingError: null,
      },
    ];
    domainRows = [];
    nodeRows = [{ id: 'node-1', ipAddress: '203.0.113.10' }];
  });

  it('attaches a pending custom domain to an existing public route', async () => {
    const response = await request('/api/projects/proj-1/environments/env-1/custom-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: 'web',
        port: 3000,
        hostname: ' App.Customer.Example.com ',
      }),
    });

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({
      id: 'domain-1',
      environmentId: 'env-1',
      service: 'web',
      port: 3000,
      routeIndex: 0,
      hostname: 'app.customer.example.com',
      verificationStatus: 'pending',
      desiredState: 'active',
      routingStatus: 'pending_dns',
      servingStatus: 'pending_dns',
      verifiedCnameTarget: null,
      cnameTarget: parentRoute.hostname,
    });
    expect(domainRows).toHaveLength(1);
    expect(domainRows[0]).toMatchObject({
      hostname: 'app.customer.example.com',
      service: 'web',
      port: 3000,
      routeIndex: 0,
      desiredState: 'active',
      routingStatus: 'pending_dns',
      createdBy: 'user-1',
    });
  });

  it('rejects a custom domain when no matching public route exists', async () => {
    mockGetEnvironmentPublicRouteTargets.mockResolvedValueOnce([parentRoute]);

    const response = await request('/api/projects/proj-1/environments/env-1/custom-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: 'worker',
        port: 9000,
        hostname: 'worker.customer.example.com',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message:
        'No public route found for service "worker" on port 9000 in this environment\'s latest release',
    });
    expect(domainRows).toEqual([]);
  });

  it('lists custom domains with the current expected CNAME target', async () => {
    domainRows = [
      makeDomainRow({
        verificationStatus: 'verified',
        verifiedAt: '2026-06-24T00:00:00.000Z',
        verifiedCnameTarget: parentRoute.hostname,
        routingStatus: 'active',
      }),
    ];

    const response = await request('/api/projects/proj-1/environments/env-1/custom-domains');

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.customDomains).toEqual([
      expect.objectContaining({
        id: 'domain-1',
        hostname: 'app.customer.example.com',
        verificationStatus: 'verified',
        verifiedCnameTarget: parentRoute.hostname,
        servingStatus: 'active',
        cnameTarget: parentRoute.hostname,
      }),
    ]);
  });

  it('marks a custom domain verified when DoH points at the route target', async () => {
    domainRows = [makeDomainRow()];

    const response = await request(
      '/api/projects/proj-1/environments/env-1/custom-domains/domain-1/verify',
      { method: 'POST' }
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.verificationStatus).toBe('verified');
    expect(body.verificationError).toBeNull();
    expect(body.verifiedAt).toEqual(expect.any(String));
    expect(body.verifiedCnameTarget).toBe(parentRoute.hostname);
    expect(body.activationRoutingRevision).toBe(1);
    expect(body.servingStatus).toBe('activating');
    expect(mockRequestRoutingRevision).toHaveBeenCalled();
    expect(mockVerifyCustomDomainTarget).toHaveBeenCalledWith(
      'app.customer.example.com',
      parentRoute.hostname,
      '203.0.113.10',
      expect.anything()
    );
  });

  it('marks a custom domain failed and returns the exact CNAME target when DoH does not match', async () => {
    mockVerifyCustomDomainTarget.mockResolvedValueOnce(false);
    domainRows = [makeDomainRow()];

    const response = await request(
      '/api/projects/proj-1/environments/env-1/custom-domains/domain-1/verify',
      { method: 'POST' }
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      verificationStatus: 'failed',
      verifiedAt: null,
      verificationError:
        'app.customer.example.com does not resolve to r1-web-3000-env-1.apps.sammy.party or 203.0.113.10. Set a CNAME record pointing app.customer.example.com at r1-web-3000-env-1.apps.sammy.party.',
      cnameTarget: parentRoute.hostname,
    });
  });

  it('requests deactivation for a verified custom domain instead of deleting immediately', async () => {
    domainRows = [
      makeDomainRow({
        verificationStatus: 'verified',
        verifiedAt: '2026-06-24T00:00:00.000Z',
        verifiedCnameTarget: parentRoute.hostname,
        routingStatus: 'active',
      }),
    ];

    const response = await request(
      '/api/projects/proj-1/environments/env-1/custom-domains/domain-1',
      { method: 'DELETE' }
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(202);
    expect(body).toMatchObject({
      id: 'domain-1',
      desiredState: 'deactivating',
      routingStatus: 'deactivating',
      servingStatus: 'deactivating',
      deactivationRoutingRevision: 1,
    });
    expect(domainRows).toHaveLength(1);
    expect(domainRows[0]).toMatchObject({
      desiredState: 'deactivating',
      routingStatus: 'deactivating',
      deactivationRoutingRevision: 1,
      deletedAt: null,
    });
  });
});
