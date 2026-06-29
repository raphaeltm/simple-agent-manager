import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mockRequireOwnedProject = vi.fn();
const mockGetEnvironmentPublicRouteTargets = vi.fn();
const mockGetNodeLogsFromNode = vi.fn();
const mockGetNodeSystemInfoFromNode = vi.fn();
const mockListNodeContainersFromNode = vi.fn();
const mockBuildDeploymentEnvironmentResponse = vi.fn();
const mockProvisionDeploymentNode = vi.fn();
const mockListEnvironmentVolumes = vi.fn();

const selectRows: unknown[][] = [];
const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const mockLimit = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({ select: mockSelect, update: mockUpdate }),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (a: unknown, b: unknown) => [a, b],
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentEnvironments: {
    id: 'deploymentEnvironments.id',
    projectId: 'deploymentEnvironments.projectId',
    nodeId: 'deploymentEnvironments.nodeId',
    status: 'deploymentEnvironments.status',
  },
  deploymentReleases: {
    id: 'deploymentReleases.id',
    environmentId: 'deploymentReleases.environmentId',
    version: 'deploymentReleases.version',
    status: 'deploymentReleases.status',
  },
  nodes: {
    id: 'nodes.id',
    status: 'nodes.status',
    userId: 'nodes.userId',
    lastMetrics: 'nodes.lastMetrics',
  },
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: (...args: unknown[]) => mockRequireOwnedProject(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
  getNodeSystemInfoFromNode: (...args: unknown[]) => mockGetNodeSystemInfoFromNode(...args),
  listNodeContainersFromNode: (...args: unknown[]) => mockListNodeContainersFromNode(...args),
  teardownDeploymentEnvironmentOnNode: vi.fn(),
}));

vi.mock('../../../src/services/deployment-control', () => ({
  encodeAllowedDeployProfileIds: vi.fn(() => null),
  uniqueDeployProfileIds: vi.fn((ids) => ids ?? []),
  validateAllowedDeployProfiles: vi.fn(),
}));

vi.mock('../../../src/services/deployment-custom-domains', () => ({
  getEnvironmentPublicRouteTargets: (...args: unknown[]) =>
    mockGetEnvironmentPublicRouteTargets(...args),
}));

vi.mock('../../../src/services/deployment-environment-summary', () => ({
  buildDeploymentEnvironmentResponse: (...args: unknown[]) =>
    mockBuildDeploymentEnvironmentResponse(...args),
}));

vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: (...args: unknown[]) => mockProvisionDeploymentNode(...args),
}));

vi.mock('../../../src/services/deployment-routing', () => ({
  collectEnvironmentRouteHostnames: vi.fn(() => []),
}));

vi.mock('../../../src/services/deployment-volumes', () => ({
  attachEnvironmentVolumesToLinkedNode: vi.fn(),
  deleteEnvironmentVolume: vi.fn(),
  detachEnvironmentVolumes: vi.fn(),
  listEnvironmentVolumes: (...args: unknown[]) => mockListEnvironmentVolumes(...args),
}));

vi.mock('../../../src/services/dns', () => ({
  cleanupAppRouteDNSRecords: vi.fn(),
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'generated-id',
}));

const { deploymentEnvironmentRoutes } = await import('../../../src/routes/deployment-environments');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number') {
      return c.json(
        { error: appError.error, message: appError.message },
        appError.statusCode as any
      );
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  app.route('/api/projects', deploymentEnvironmentRoutes);
  return app;
}

function mockSelectRows(...rows: unknown[][]) {
  selectRows.splice(0, selectRows.length, ...rows);
}

function createEnv(): Env {
  return { DATABASE: {} } as Env;
}

describe('deployment environment observability routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls.length = 0;
    mockRequireOwnedProject.mockResolvedValue(undefined);
    mockGetEnvironmentPublicRouteTargets.mockResolvedValue([]);
    mockBuildDeploymentEnvironmentResponse.mockImplementation((_db, _env, row) => row);
    mockProvisionDeploymentNode.mockResolvedValue({
      nodeId: 'node-started',
      provisioningStarted: false,
      provisioningPromise: Promise.resolve(),
    });
    mockListEnvironmentVolumes.mockResolvedValue([]);
    mockLimit.mockImplementation(() => Promise.resolve(selectRows.shift() ?? []));
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });
    mockUpdate.mockImplementation((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ table, values });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
  });

  it('forwards docker log queries to the deployment node agent', async () => {
    mockSelectRows([{ id: 'env-1', nodeId: 'node-1' }], [{ id: 'node-1', status: 'running' }]);
    mockGetNodeLogsFromNode.mockResolvedValue({
      entries: [
        {
          timestamp: '2026-06-18T10:00:00Z',
          level: 'info',
          source: 'docker:web-1',
          message: 'ready',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });

    const response = await createApp().request(
      '/api/projects/project-1/environments/env-1/logs?source=docker&container=web-1&limit=80',
      {},
      createEnv()
    );

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.entries).toHaveLength(1);
    expect(body.nodeId).toBe('node-1');
    expect(mockGetNodeLogsFromNode).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      'user-1',
      'source=docker&container=web-1&limit=80'
    );
  });

  it('returns deployment-node system and container metrics', async () => {
    mockSelectRows(
      [{ id: 'env-1', nodeId: 'node-1' }],
      [{ id: 'node-1', status: 'running', lastMetrics: '{"memoryPercent":42}' }]
    );
    mockGetNodeSystemInfoFromNode.mockResolvedValue({
      cpu: { loadAvg1: 0.12, loadAvg5: 0.2, loadAvg15: 0.3, numCpu: 2 },
      memory: { totalBytes: 1000, usedBytes: 420, availableBytes: 580, usedPercent: 42 },
      disk: {
        totalBytes: 2000,
        usedBytes: 500,
        availableBytes: 1500,
        usedPercent: 25,
        mountPath: '/',
      },
      network: { interface: 'eth0', rxBytes: 1, txBytes: 2 },
      uptime: { seconds: 60, humanFormat: '1m' },
      docker: {
        version: '25.0.0',
        containers: 1,
        containerList: [
          {
            id: 'abc',
            name: 'web-1',
            image: 'nginx',
            status: 'Up',
            state: 'running',
            cpuPercent: 1.5,
            memUsage: '3.5MiB / 256MiB',
            memPercent: 1.36,
            createdAt: '2026-06-18T10:00:00Z',
          },
        ],
      },
      software: {
        goVersion: 'go1.25',
        nodeVersion: 'v22',
        dockerVersion: '25',
        devcontainerCliVersion: 'n/a',
      },
      agent: { version: 'test', uptime: '1m' },
    });

    const response = await createApp().request(
      '/api/projects/project-1/environments/env-1/metrics',
      {},
      createEnv()
    );

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.nodeId).toBe('node-1');
    expect(body.fallbackMetrics).toEqual({ memoryPercent: 42 });
    expect(body.systemInfo.docker.containerList[0]).toMatchObject({
      name: 'web-1',
      cpuPercent: 1.5,
      memPercent: 1.36,
      state: 'running',
    });
    expect(mockGetNodeSystemInfoFromNode).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      'user-1'
    );
  });

  it('lists public route metadata for custom-domain attach', async () => {
    mockSelectRows([{ id: 'env-1', projectId: 'project-1', nodeId: 'node-1' }]);
    mockGetEnvironmentPublicRouteTargets.mockResolvedValue([
      {
        hostname: 'r1-web-8080-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 8080,
        hostPort: 36120,
      },
      {
        hostname: 'r2-api-3000-env-1.apps.sammy.party',
        service: 'api',
        containerPort: 3000,
        hostPort: 36121,
      },
    ]);

    const response = await createApp().request(
      '/api/projects/project-1/environments/env-1/public-routes',
      {},
      createEnv()
    );

    const body = await response.json<any>();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.publicRoutes).toEqual([
      {
        id: 'web:8080:0',
        service: 'web',
        port: 8080,
        hostname: 'r1-web-8080-env-1.apps.sammy.party',
        hostPort: 36120,
        routeIndex: 0,
      },
      {
        id: 'api:3000:1',
        service: 'api',
        port: 3000,
        hostname: 'r2-api-3000-env-1.apps.sammy.party',
        hostPort: 36121,
        routeIndex: 1,
      },
    ]);
    expect(mockRequireOwnedProject).toHaveBeenCalledWith(expect.anything(), 'project-1', 'user-1');
    expect(mockGetEnvironmentPublicRouteTargets).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'env-1'
    );
  });

  it('returns 404 for public routes when the environment is missing', async () => {
    mockSelectRows([]);

    const response = await createApp().request(
      '/api/projects/project-1/environments/missing-env/public-routes',
      {},
      createEnv()
    );

    expect(response.status).toBe(404);
    expect(await response.json<any>()).toMatchObject({
      message: 'Deployment environment not found',
    });
    expect(mockGetEnvironmentPublicRouteTargets).not.toHaveBeenCalled();
  });

  it('marks the latest preserved release pending when starting a stopped environment', async () => {
    mockSelectRows(
      [
        {
          id: 'env-1',
          projectId: 'project-1',
          name: 'staging',
          status: 'stopped',
          nodeId: null,
          requiresVolumes: true,
        },
      ],
      [{ id: 'release-1', version: 3 }],
      [{ nodeId: 'node-started' }],
      [
        {
          id: 'env-1',
          projectId: 'project-1',
          name: 'staging',
          status: 'starting',
          nodeId: 'node-started',
          requiresVolumes: true,
        },
      ]
    );

    const response = await createApp().request(
      '/api/projects/project-1/environments/env-1/start',
      { method: 'POST' },
      createEnv()
    );

    const body = await response.json<any>();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(mockProvisionDeploymentNode).toHaveBeenCalledWith(
      'env-1',
      'project-1',
      'user-1',
      expect.anything(),
      { requiresVolumes: true, providerOverride: undefined, vmLocationOverride: undefined }
    );
    expect(updateCalls).toContainEqual({
      table: expect.objectContaining({ id: 'deploymentReleases.id' }),
      values: { status: 'created' },
    });
    expect(body.lifecycle).toMatchObject({
      started: true,
      nodeId: 'node-started',
      latestReleaseVersion: 3,
    });
  });
});
