import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const projects = {
  id: 'projects.id',
  userId: 'projects.userId',
};

const projectMembers = {
  projectId: 'projectMembers.projectId',
  userId: 'projectMembers.userId',
  role: 'projectMembers.role',
  status: 'projectMembers.status',
};

const deploymentEnvironments = {
  id: 'deploymentEnvironments.id',
  projectId: 'deploymentEnvironments.projectId',
  nodeId: 'deploymentEnvironments.nodeId',
  name: 'deploymentEnvironments.name',
  status: 'deploymentEnvironments.status',
  createdAt: 'deploymentEnvironments.createdAt',
  updatedAt: 'deploymentEnvironments.updatedAt',
  createdByUserId: 'deploymentEnvironments.createdByUserId',
  creationSource: 'deploymentEnvironments.creationSource',
};

const nodes = {
  id: 'nodes.id',
  userId: 'nodes.userId',
  status: 'nodes.status',
  lastMetrics: 'nodes.lastMetrics',
  providerInstanceId: 'nodes.providerInstanceId',
};

type Condition =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'and'; conds: Condition[] }
  | undefined;

interface ProjectRow {
  id: string;
  userId: string;
}

interface ProjectMemberRow {
  projectId: string;
  userId: string;
  role: string;
  status: string;
}

interface EnvironmentRow {
  id: string;
  projectId: string;
  nodeId?: string | null;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  creationSource: string;
}

interface NodeRow {
  id: string;
  userId: string;
  status: string;
  lastMetrics: string | null;
}

const mockCurrentUserId = vi.hoisted(() => ({ value: 'admin-user' }));
const mockGetNodeLogsFromNode = vi.hoisted(() => vi.fn());

let projectRows: ProjectRow[] = [];
let memberRows: ProjectMemberRow[] = [];
let environmentRows: EnvironmentRow[] = [];
let nodeRows: NodeRow[] = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('../../../src/db/schema', () => ({
  projects,
  projectMembers,
  deploymentEnvironments,
  deploymentReleases: {
    manifest: 'deploymentReleases.manifest',
    environmentId: 'deploymentReleases.environmentId',
  },
  nodes,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => mockCurrentUserId.value,
}));

vi.mock('../../../src/services/deployment-control', () => ({
  DEPLOYMENT_ENVIRONMENT_NAME_RE: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  encodeAllowedDeployProfileIds: vi.fn(() => null),
  uniqueDeployProfileIds: vi.fn((ids: string[] | null | undefined) => ids ?? []),
  validateAllowedDeployProfiles: vi.fn(),
}));

vi.mock('../../../src/services/deployment-environment-summary', () => ({
  buildDeploymentEnvironmentResponse: vi.fn(async (_db, _env, row: EnvironmentRow) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    createdByUserId: row.createdByUserId,
  })),
}));

vi.mock('../../../src/services/deployment-custom-domains', () => ({
  getEnvironmentPublicRouteTargets: vi.fn(async () => []),
}));

vi.mock('../../../src/services/deployment-volumes', () => ({
  deleteEnvironmentVolume: vi.fn(),
  detachEnvironmentVolumes: vi.fn(async () => []),
  listEnvironmentVolumes: vi.fn(async () => []),
}));

vi.mock('../../../src/services/dns', () => ({
  cleanupAppRouteDNSRecords: vi.fn(async () => 0),
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: vi.fn(async () => ({ nodeFound: false, errors: [] })),
}));

vi.mock('../../../src/services/node-agent', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
  getNodeSystemInfoFromNode: vi.fn(),
  listNodeContainersFromNode: vi.fn(),
  teardownDeploymentEnvironmentOnNode: vi.fn(),
}));

vi.mock('../../../src/services/node-agent-diagnostics', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
  getNodeSystemInfoFromNode: vi.fn(),
  listNodeContainersFromNode: vi.fn(),
}));

vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: vi.fn(),
}));

vi.mock('../../../src/services/deployment-routing', () => ({
  collectEnvironmentRouteHostnames: vi.fn(() => []),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'env-created-by-admin',
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

const { deploymentEnvironmentRoutes } = await import('../../../src/routes/deployment-environments');

function eqValue(condition: Condition, col: unknown): unknown {
  if (!condition) return undefined;
  if (condition.op === 'eq') {
    return condition.col === col ? condition.val : undefined;
  }
  for (const child of condition.conds) {
    const value = eqValue(child, col);
    if (value !== undefined) return value;
  }
  return undefined;
}

function selectRows(table: unknown, condition: Condition): unknown[] {
  if (table === projects) {
    const id = eqValue(condition, projects.id);
    return projectRows.filter((row) => id === undefined || row.id === id);
  }

  if (table === projectMembers) {
    const projectId = eqValue(condition, projectMembers.projectId);
    const userId = eqValue(condition, projectMembers.userId);
    const status = eqValue(condition, projectMembers.status);
    return memberRows.filter(
      (row) =>
        (projectId === undefined || row.projectId === projectId) &&
        (userId === undefined || row.userId === userId) &&
        (status === undefined || row.status === status)
    );
  }

  if (table === deploymentEnvironments) {
    const id = eqValue(condition, deploymentEnvironments.id);
    const projectId = eqValue(condition, deploymentEnvironments.projectId);
    const name = eqValue(condition, deploymentEnvironments.name);
    return environmentRows.filter(
      (row) =>
        (id === undefined || row.id === id) &&
        (projectId === undefined || row.projectId === projectId) &&
        (name === undefined || row.name === name)
    );
  }

  if (table === nodes) {
    const id = eqValue(condition, nodes.id);
    const userId = eqValue(condition, nodes.userId);
    return nodeRows.filter(
      (row) =>
        (id === undefined || row.id === id) &&
        (userId === undefined || row.userId === userId)
    );
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
      values: vi.fn(async (values: EnvironmentRow) => {
        if (table === deploymentEnvironments) {
          environmentRows.push(values);
        }
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
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
  app.route('/api/projects', deploymentEnvironmentRoutes);
  return app;
}

function request(path: string, init: RequestInit = {}) {
  return createApp().request(path, init, { DATABASE: {} } as Env);
}

describe('deployment route membership authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentUserId.value = 'admin-user';
    projectRows = [{ id: 'proj-1', userId: 'owner-user' }];
    memberRows = [
      { projectId: 'proj-1', userId: 'owner-user', role: 'owner', status: 'active' },
      { projectId: 'proj-1', userId: 'admin-user', role: 'admin', status: 'active' },
    ];
    environmentRows = [
      {
        id: 'env-1',
        projectId: 'proj-1',
        nodeId: 'node-owner-created',
        name: 'production',
        status: 'active',
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        createdByUserId: 'owner-user',
        creationSource: 'user',
      },
    ];
    nodeRows = [
      {
        id: 'node-owner-created',
        userId: 'owner-user',
        status: 'running',
        lastMetrics: null,
      },
    ];
    mockGetNodeLogsFromNode.mockResolvedValue({
      entries: [{ timestamp: '2026-07-04T00:00:00.000Z', message: 'ready' }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('allows an active admin member to list deployment environments in a non-owned project', async () => {
    const response = await request('/api/projects/proj-1/environments');
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({
      environments: [
        {
          id: 'env-1',
          projectId: 'proj-1',
          name: 'production',
          status: 'active',
          createdByUserId: 'owner-user',
        },
      ],
    });
  });

  it('allows an active admin member to create a deployment environment as the actor', async () => {
    const response = await request('/api/projects/proj-1/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'staging' }),
    });
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({
      id: 'env-created-by-admin',
      projectId: 'proj-1',
      name: 'staging',
      createdByUserId: 'admin-user',
    });
    expect(environmentRows.at(-1)).toMatchObject({
      projectId: 'proj-1',
      name: 'staging',
      createdByUserId: 'admin-user',
      creationSource: 'user',
    });
  });

  it('allows an active admin member to read logs from an owner-created deployment node', async () => {
    const response = await request('/api/projects/proj-1/environments/env-1/logs?limit=20');
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      entries: [{ timestamp: '2026-07-04T00:00:00.000Z', message: 'ready' }],
      source: 'deployment-node',
      nodeId: 'node-owner-created',
    });
    expect(mockGetNodeLogsFromNode).toHaveBeenCalledWith(
      'node-owner-created',
      expect.anything(),
      'admin-user',
      'limit=20'
    );
  });

  it('rejects non-members from deployment environment routes', async () => {
    mockCurrentUserId.value = 'non-member-user';

    const response = await request('/api/projects/proj-1/environments');
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(404);
    expect(body).toMatchObject({ error: 'NOT_FOUND' });
  });
});
