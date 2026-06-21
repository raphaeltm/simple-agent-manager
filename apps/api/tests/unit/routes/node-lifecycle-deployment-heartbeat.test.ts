import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Condition = { op: 'eq'; col: string; val: unknown } | { op: 'and'; conds: Condition[] };

const updates: Array<{ table: unknown; values: Record<string, unknown>; where: unknown }> = [];
const latestByEnvironment = new Map<string, { version: number; status: string }>();
let deploymentPlacements: Array<{ envId: string }> = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  desc: (col: unknown) => col,
  eq: (col: string, val: unknown) => ({ op: 'eq', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  sql: (strings: TemplateStringsArray) => ({ sql: strings.join('') }),
}));

vi.mock('../../../src/db/schema', () => ({
  nodes: {
    id: 'nodes.id',
    status: 'nodes.status',
    healthStatus: 'nodes.healthStatus',
    lastHeartbeatAt: 'nodes.lastHeartbeatAt',
    updatedAt: 'nodes.updatedAt',
    lastMetrics: 'nodes.lastMetrics',
    ipAddress: 'nodes.ipAddress',
    errorMessage: 'nodes.errorMessage',
    backendDnsRecordId: 'nodes.backendDnsRecordId',
  },
  workspaces: {
    id: 'workspaces.id',
    projectId: 'workspaces.projectId',
    nodeId: 'workspaces.nodeId',
    status: 'workspaces.status',
  },
  deploymentEnvironments: {
    id: 'deployment_environments.id',
    nodeId: 'deployment_environments.nodeId',
    observedDeployment: 'deployment_environments.observedDeployment',
    observedDeploymentAt: 'deployment_environments.observedDeploymentAt',
  },
  deploymentReleases: {
    environmentId: 'deployment_releases.environmentId',
    version: 'deployment_releases.version',
    status: 'deployment_releases.status',
  },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

vi.mock('../../../src/services/jwt', () => ({
  shouldRefreshCallbackToken: vi.fn().mockReturnValue(false),
  signCallbackToken: vi.fn(),
  signNodeCallbackToken: vi.fn(),
  signNodeManagementToken: vi.fn(),
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'node-deploy-1', scope: 'node', type: 'callback' }),
}));

vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn(),
  updateDNSRecord: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  updateNodeHeartbeats: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../../src/services/deployment-control', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/deployment-control')>(
    '../../../src/services/deployment-control'
  );
  return {
    ...actual,
    reconcileDeploymentReleaseStatuses: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/lib/logger', () => ({
  createModuleLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: vi.fn().mockReturnValue('user-1'),
}));

function findEq(condition: unknown, col: string): unknown {
  if (!condition || typeof condition !== 'object') return undefined;
  const c = condition as Condition;
  if (c.op === 'eq' && c.col === col) return c.val;
  if (c.op === 'and') {
    for (const child of c.conds) {
      const found = findEq(child, col);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function createMockDb() {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation((condition: unknown) => {
          if (table && typeof table === 'object' && 'ipAddress' in table) {
            return {
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'node-deploy-1',
                  status: 'running',
                  healthStatus: 'healthy',
                  nodeRole: 'deployment',
                  ipAddress: null,
                  errorMessage: null,
                  backendDnsRecordId: null,
                },
              ]),
            };
          }
          if (table && typeof table === 'object' && 'projectId' in table) {
            return Promise.resolve([]);
          }
          if (table && typeof table === 'object' && 'observedDeployment' in table) {
            return Promise.resolve(deploymentPlacements);
          }
          if (table && typeof table === 'object' && 'version' in table) {
            const envId = String(findEq(condition, 'deployment_releases.environmentId') ?? '');
            const release = latestByEnvironment.get(envId) ?? { version: 0, status: 'created' };
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([release]),
              }),
            };
          }
          return { limit: vi.fn().mockResolvedValue([]) };
        }),
      })),
    })),
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation((where: unknown) => {
          updates.push({ table, values, where });
          return Promise.resolve();
        }),
      })),
    })),
  };
}

describe('node lifecycle deployment heartbeat contract', () => {
  beforeEach(() => {
    updates.length = 0;
    deploymentPlacements = [{ envId: 'env-a' }, { envId: 'env-b' }];
    latestByEnvironment.clear();
    latestByEnvironment.set('env-a', { version: 5, status: 'created' });
    latestByEnvironment.set('env-b', { version: 8, status: 'applied' });
  });

  it('returns per-environment pending releases and explicit retirement for reported environments not placed on the node', async () => {
    const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
    const app = new Hono();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const res = await app.request(
      '/api/nodes/node-deploy-1/heartbeat',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer node-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deployment: {
            environments: [
              { environmentId: 'env-a', appliedSeq: 4, status: 'applied' },
              { environmentId: 'env-b', appliedSeq: 8, status: 'applied' },
              { environmentId: 'env-evil', appliedSeq: 0, status: 'applied' },
            ],
          },
        }),
      },
      {
        DATABASE: {},
        DEPLOY_SIGNING_PUBLIC_KEY: 'pub-key',
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.environments).toEqual([
      { environmentId: 'env-a' },
      { environmentId: 'env-b' },
    ]);
    expect(body.deployment.retireEnvironments).toEqual([{ environmentId: 'env-evil' }]);
    expect(body.deployment.pendingReleases).toEqual([{ environmentId: 'env-a', seq: 5 }]);
    expect(body.deployment.deployPubKey).toBe('pub-key');

    const deploymentUpdates = updates.filter(
      (update) =>
        update.table && typeof update.table === 'object' && 'observedDeployment' in update.table
    );
    expect(deploymentUpdates).toHaveLength(2);
    expect(
      deploymentUpdates.some((update) => JSON.stringify(update.where).includes('env-evil'))
    ).toBe(false);
  });

  it('does not reissue a failed newer release after the node reports rollback', async () => {
    latestByEnvironment.set('env-a', { version: 6, status: 'failed' });
    const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
    const app = new Hono();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const res = await app.request(
      '/api/nodes/node-deploy-1/heartbeat',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer node-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deployment: {
            environments: [
              { environmentId: 'env-a', appliedSeq: 5, status: 'reverted' },
              { environmentId: 'env-b', appliedSeq: 8, status: 'applied' },
            ],
          },
        }),
      },
      {
        DATABASE: {},
        DEPLOY_SIGNING_PUBLIC_KEY: 'pub-key',
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toBeUndefined();
    expect(body.pendingReleaseSeq).toBeUndefined();
  });

  it('does not reissue an applying release while the node reports it is already applying', async () => {
    latestByEnvironment.set('env-a', { version: 6, status: 'applying' });
    const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
    const app = new Hono();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const res = await app.request(
      '/api/nodes/node-deploy-1/heartbeat',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer node-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deployment: {
            environments: [
              { environmentId: 'env-a', appliedSeq: 5, status: 'applying' },
              { environmentId: 'env-b', appliedSeq: 8, status: 'applied' },
            ],
          },
        }),
      },
      {
        DATABASE: {},
        DEPLOY_SIGNING_PUBLIC_KEY: 'pub-key',
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toBeUndefined();
    expect(body.pendingReleaseSeq).toBeUndefined();
  });

  it('reissues an applying release when the node reports no state for that environment', async () => {
    latestByEnvironment.set('env-a', { version: 6, status: 'applying' });
    const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
    const app = new Hono();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const res = await app.request(
      '/api/nodes/node-deploy-1/heartbeat',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer node-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deployment: {
            environments: [{ environmentId: 'env-b', appliedSeq: 8, status: 'applied' }],
          },
        }),
      },
      {
        DATABASE: {},
        DEPLOY_SIGNING_PUBLIC_KEY: 'pub-key',
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toEqual([{ environmentId: 'env-a', seq: 6 }]);
  });

  it('ignores legacy top-level deployment state without an environment id', async () => {
    deploymentPlacements = [{ envId: 'env-a' }];
    latestByEnvironment.set('env-a', { version: 5, status: 'applied' });
    const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
    const app = new Hono();
    app.route('/api/nodes', nodeLifecycleRoutes);

    const res = await app.request(
      '/api/nodes/node-deploy-1/heartbeat',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer node-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deployment: {
            appliedSeq: 5,
            status: 'applied',
          },
        }),
      },
      {
        DATABASE: {},
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      }
    );

    expect(res.status).toBe(200);
    const deploymentUpdates = updates.filter(
      (update) =>
        update.table && typeof update.table === 'object' && 'observedDeployment' in update.table
    );
    expect(deploymentUpdates).toHaveLength(0);
  });
});
