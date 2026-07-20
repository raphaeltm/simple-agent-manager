import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Condition = { op: 'eq'; col: string; val: unknown } | { op: 'and'; conds: Condition[] };

const updates: Array<{ table: unknown; values: Record<string, unknown>; where: unknown }> = [];
const latestByEnvironment = new Map<string, { version: number; status: string }>();
let deploymentPlacements: Array<{
  envId: string;
  status?: string;
  requiresVolumes?: boolean;
  observedAppliedSeq?: number | null;
  desiredRoutingRevision?: number;
  observedRoutingRevision?: number;
}> = [];
const volumeReadinessByEnvironment = new Map<string, { total: number; attached: number }>();
const currentProviderServerId = 'provider-server-current';

function volumeReadinessKey(serverId: string, environmentId: string): string {
  return `${serverId}:${environmentId}`;
}

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
    providerInstanceId: 'nodes.providerInstanceId',
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
    status: 'deployment_environments.status',
    requiresVolumes: 'deployment_environments.requiresVolumes',
    observedAppliedSeq: 'deployment_environments.observedAppliedSeq',
    desiredRoutingRevision: 'deployment_environments.desiredRoutingRevision',
    observedRoutingRevision: 'deployment_environments.observedRoutingRevision',
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

vi.mock('../../../src/services/deployment-custom-domains', () => ({
  reconcileCustomDomainRoutingObservation: vi.fn().mockResolvedValue(undefined),
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
                  providerInstanceId: currentProviderServerId,
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

async function postHeartbeat(
  payload: unknown,
  env: Record<string, unknown> = {
    DATABASE: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((serverId: string, environmentId: string) => ({
          first: vi.fn(async () => {
            if (sql.includes('FROM deployment_volumes')) {
              return (
                volumeReadinessByEnvironment.get(volumeReadinessKey(serverId, environmentId)) ?? {
                  total: 0,
                  attached: 0,
                }
              );
            }
            return null;
          }),
        })),
      })),
    },
    DEPLOY_SIGNING_PUBLIC_KEY: 'pub-key',
  }
) {
  const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
  const app = new Hono();
  app.route('/api/nodes', nodeLifecycleRoutes);
  return app.request(
    '/api/nodes/node-deploy-1/heartbeat',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer node-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  );
}

describe('node lifecycle deployment heartbeat contract', () => {
  beforeEach(() => {
    updates.length = 0;
    volumeReadinessByEnvironment.clear();
    deploymentPlacements = [
      { envId: 'env-a', status: 'active', requiresVolumes: false },
      { envId: 'env-b', status: 'active', requiresVolumes: false },
    ];
    latestByEnvironment.clear();
    latestByEnvironment.set('env-a', { version: 5, status: 'created' });
    latestByEnvironment.set('env-b', { version: 8, status: 'applied' });
  });

  it('withholds pending releases for volume environments until all volumes are attached', async () => {
    deploymentPlacements = [{ envId: 'env-a', status: 'active', requiresVolumes: true }];
    latestByEnvironment.set('env-a', { version: 5, status: 'created' });
    volumeReadinessByEnvironment.set(volumeReadinessKey(currentProviderServerId, 'env-a'), {
      total: 2,
      attached: 1,
    });

    const waiting = await postHeartbeat({
      deployment: {
        environments: [{ environmentId: 'env-a', appliedSeq: 4, status: 'applied' }],
      },
    });

    expect(waiting.status).toBe(200);
    expect((await waiting.json()).deployment.pendingReleases).toBeUndefined();

    volumeReadinessByEnvironment.set(volumeReadinessKey(currentProviderServerId, 'env-a'), {
      total: 2,
      attached: 2,
    });
    const ready = await postHeartbeat({
      deployment: {
        environments: [{ environmentId: 'env-a', appliedSeq: 4, status: 'applied' }],
      },
    });

    expect(ready.status).toBe(200);
    expect((await ready.json()).deployment.pendingReleases).toEqual([
      { environmentId: 'env-a', seq: 5 },
    ]);
  });

  it('does not treat volumes attached to a stale provider server as ready', async () => {
    deploymentPlacements = [{ envId: 'env-a', status: 'active', requiresVolumes: true }];
    latestByEnvironment.set('env-a', { version: 5, status: 'created' });
    volumeReadinessByEnvironment.set(volumeReadinessKey('provider-server-old', 'env-a'), {
      total: 2,
      attached: 2,
    });
    volumeReadinessByEnvironment.set(volumeReadinessKey(currentProviderServerId, 'env-a'), {
      total: 2,
      attached: 0,
    });

    const res = await postHeartbeat({
      deployment: {
        environments: [{ environmentId: 'env-a', appliedSeq: 4, status: 'applied' }],
      },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).deployment.pendingReleases).toBeUndefined();
  });

  it('returns per-environment pending releases and explicit retirement for reported environments not placed on the node', async () => {
    const res = await postHeartbeat({
      deployment: {
        environments: [
          { environmentId: 'env-a', appliedSeq: 4, status: 'applied' },
          { environmentId: 'env-b', appliedSeq: 8, status: 'applied' },
          { environmentId: 'env-evil', appliedSeq: 0, status: 'applied' },
        ],
      },
    });

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

  it('advertises pending route configs after an app release is already applied', async () => {
    deploymentPlacements = [
      {
        envId: 'env-a',
        status: 'active',
        requiresVolumes: false,
        observedAppliedSeq: 5,
        desiredRoutingRevision: 3,
        observedRoutingRevision: 2,
      },
    ];
    latestByEnvironment.set('env-a', { version: 5, status: 'applied' });

    const res = await postHeartbeat({
      deployment: {
        environments: [
          {
            environmentId: 'env-a',
            appliedSeq: 5,
            status: 'applied',
            routingRevision: 2,
            routingStatus: 'active',
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toBeUndefined();
    expect(body.deployment.pendingRouteConfigs).toEqual([{ environmentId: 'env-a', revision: 3 }]);
  });

  it('retires stopped environments without issuing pending releases', async () => {
    deploymentPlacements = [{ envId: 'env-a', status: 'stopped', requiresVolumes: false }];

    const res = await postHeartbeat({
      deployment: {
        environments: [{ environmentId: 'env-a', appliedSeq: 4, status: 'applied' }],
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.environments).toEqual([]);
    expect(body.deployment.retireEnvironments).toEqual([{ environmentId: 'env-a' }]);
    expect(body.deployment.pendingReleases).toBeUndefined();
  });

  it('promotes starting environments to active after an applied heartbeat', async () => {
    deploymentPlacements = [{ envId: 'env-a', status: 'starting', requiresVolumes: false }];
    latestByEnvironment.set('env-a', { version: 4, status: 'applied' });

    const res = await postHeartbeat({
      deployment: {
        environments: [{ environmentId: 'env-a', appliedSeq: 4, status: 'applied' }],
      },
    });

    expect(res.status).toBe(200);
    expect(updates.some((update) => update.values.status === 'active')).toBe(true);
  });

  it('does not reissue a failed newer release after the node reports rollback', async () => {
    latestByEnvironment.set('env-a', { version: 6, status: 'failed' });

    const res = await postHeartbeat({
      deployment: {
        environments: [
          { environmentId: 'env-a', appliedSeq: 5, status: 'reverted' },
          { environmentId: 'env-b', appliedSeq: 8, status: 'applied' },
        ],
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toBeUndefined();
    expect(body.pendingReleaseSeq).toBeUndefined();
  });

  it('does not reissue an applying release while the node reports it is already applying', async () => {
    latestByEnvironment.set('env-a', { version: 6, status: 'applying' });

    const res = await postHeartbeat({
      deployment: {
        environments: [
          { environmentId: 'env-a', appliedSeq: 5, status: 'applying' },
          { environmentId: 'env-b', appliedSeq: 8, status: 'applied' },
        ],
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toBeUndefined();
    expect(body.pendingReleaseSeq).toBeUndefined();
  });

  it('reissues an applying release when the node reports no state for that environment', async () => {
    latestByEnvironment.set('env-a', { version: 6, status: 'applying' });

    const res = await postHeartbeat({
      deployment: {
        environments: [{ environmentId: 'env-b', appliedSeq: 8, status: 'applied' }],
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployment.pendingReleases).toEqual([{ environmentId: 'env-a', seq: 6 }]);
  });

  it('ignores legacy top-level deployment state without an environment id', async () => {
    deploymentPlacements = [{ envId: 'env-a', status: 'active' }];
    latestByEnvironment.set('env-a', { version: 5, status: 'applied' });

    const res = await postHeartbeat(
      {
        deployment: {
          appliedSeq: 5,
          status: 'applied',
        },
      },
      { DATABASE: {} }
    );

    expect(res.status).toBe(200);
    const deploymentUpdates = updates.filter(
      (update) =>
        update.table && typeof update.table === 'object' && 'observedDeployment' in update.table
    );
    expect(deploymentUpdates).toHaveLength(0);
  });
});
