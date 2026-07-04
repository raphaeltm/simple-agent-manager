import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const deploymentEnvironments = {
  id: 'deploymentEnvironments.id',
  projectId: 'deploymentEnvironments.projectId',
  nodeId: 'deploymentEnvironments.nodeId',
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
  createdBy: 'deploymentCustomDomains.createdBy',
  createdAt: 'deploymentCustomDomains.createdAt',
};
const nodes = {
  id: 'nodes.id',
  ipAddress: 'nodes.ipAddress',
};

type Condition =
  | { op: 'eq'; col: unknown; val: unknown }
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
  createdBy: string | null;
  createdAt: string;
}

const mockRequireProjectAccess = vi.fn();
const mockRequireProjectCapability = vi.fn();
const mockGetEnvironmentPublicRouteTargets = vi.fn();
const mockVerifyCustomDomainTarget = vi.fn();

let envRows: Array<{ id: string; projectId: string; nodeId: string | null }> = [];
let domainRows: DomainRow[] = [];
let nodeRows: Array<{ id: string; ipAddress: string | null }> = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
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
  getEnvironmentPublicRouteTargets: (...args: unknown[]) =>
    mockGetEnvironmentPublicRouteTargets(...args),
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
  for (const child of condition.conds) {
    const value = eqValue(child, col);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
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
    return domainRows.filter((row) => {
      return (
        (id === undefined || row.id === id) &&
        (environmentId === undefined || row.environmentId === environmentId) &&
        (hostname === undefined || row.hostname === hostname)
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

describe('deployment custom domain routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue(undefined);
    mockRequireProjectCapability.mockResolvedValue(undefined);
    mockGetEnvironmentPublicRouteTargets.mockResolvedValue([parentRoute]);
    mockVerifyCustomDomainTarget.mockResolvedValue(true);
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-1' }];
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
      cnameTarget: parentRoute.hostname,
    });
    expect(domainRows).toHaveLength(1);
    expect(domainRows[0]).toMatchObject({
      hostname: 'app.customer.example.com',
      service: 'web',
      port: 3000,
      routeIndex: 0,
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
      {
        id: 'domain-1',
        environmentId: 'env-1',
        service: 'web',
        port: 3000,
        routeIndex: 0,
        hostname: 'app.customer.example.com',
        verificationStatus: 'verified',
        verificationError: null,
        verifiedAt: '2026-06-24T00:00:00.000Z',
        createdBy: 'user-1',
        createdAt: '2026-06-24T00:00:00.000Z',
      },
    ];

    const response = await request('/api/projects/proj-1/environments/env-1/custom-domains');

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.customDomains).toEqual([
      expect.objectContaining({
        id: 'domain-1',
        hostname: 'app.customer.example.com',
        verificationStatus: 'verified',
        cnameTarget: parentRoute.hostname,
      }),
    ]);
  });

  it('marks a custom domain verified when DoH points at the route target', async () => {
    domainRows = [
      {
        id: 'domain-1',
        environmentId: 'env-1',
        service: 'web',
        port: 3000,
        routeIndex: 0,
        hostname: 'app.customer.example.com',
        verificationStatus: 'pending',
        verificationError: null,
        verifiedAt: null,
        createdBy: 'user-1',
        createdAt: '2026-06-24T00:00:00.000Z',
      },
    ];

    const response = await request(
      '/api/projects/proj-1/environments/env-1/custom-domains/domain-1/verify',
      { method: 'POST' }
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.verificationStatus).toBe('verified');
    expect(body.verificationError).toBeNull();
    expect(body.verifiedAt).toEqual(expect.any(String));
    expect(mockVerifyCustomDomainTarget).toHaveBeenCalledWith(
      'app.customer.example.com',
      parentRoute.hostname,
      '203.0.113.10',
      expect.anything()
    );
  });

  it('marks a custom domain failed and returns the exact CNAME target when DoH does not match', async () => {
    mockVerifyCustomDomainTarget.mockResolvedValueOnce(false);
    domainRows = [
      {
        id: 'domain-1',
        environmentId: 'env-1',
        service: 'web',
        port: 3000,
        routeIndex: 0,
        hostname: 'app.customer.example.com',
        verificationStatus: 'pending',
        verificationError: null,
        verifiedAt: null,
        createdBy: 'user-1',
        createdAt: '2026-06-24T00:00:00.000Z',
      },
    ];

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

  it('deletes a custom domain so it is omitted from the next apply', async () => {
    domainRows = [
      {
        id: 'domain-1',
        environmentId: 'env-1',
        service: 'web',
        port: 3000,
        routeIndex: 0,
        hostname: 'app.customer.example.com',
        verificationStatus: 'verified',
        verificationError: null,
        verifiedAt: '2026-06-24T00:00:00.000Z',
        createdBy: 'user-1',
        createdAt: '2026-06-24T00:00:00.000Z',
      },
    ];

    const response = await request(
      '/api/projects/proj-1/environments/env-1/custom-domains/domain-1',
      { method: 'DELETE' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'domain-1', deleted: true });
    expect(domainRows).toEqual([]);
  });
});
