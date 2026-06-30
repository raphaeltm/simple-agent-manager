/**
 * Cross-boundary vertical-slice test for the deployment environment stop/start
 * lifecycle (deployment-environment-lifecycle.ts).
 *
 * This proves the data-persistence contract that unit tests of individual
 * helpers cannot: a provider-backed volume's `providerVolumeId` survives a full
 * stop -> start round-trip. On stop the linked node is torn down BEFORE volumes
 * are detached (live-teardown ordering, required so the VM releases the block
 * device cleanly), and the volume row is detached. On start a fresh node is
 * provisioned with the provider/location placement constraint derived from the
 * volumes, and the SAME volume row is re-attached to the new node.
 *
 * The test mounts the real Hono routes via registerDeploymentEnvironmentLifecycleRoutes
 * and drives them through app.request(). Only the service boundaries
 * (provisioning, node-agent teardown, volume attach/detach, summary builder) are
 * mocked, each carrying realistic mutable in-memory state. The in-file
 * resolveVolumePlacementConstraint and the real AppError/middleware error module
 * are intentionally NOT mocked.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const deploymentEnvironments = {
  id: 'deploymentEnvironments.id',
  projectId: 'deploymentEnvironments.projectId',
  nodeId: 'deploymentEnvironments.nodeId',
  status: 'deploymentEnvironments.status',
  requiresVolumes: 'deploymentEnvironments.requiresVolumes',
};
const deploymentReleases = {
  id: 'deploymentReleases.id',
  environmentId: 'deploymentReleases.environmentId',
  version: 'deploymentReleases.version',
  status: 'deploymentReleases.status',
};
const deploymentVolumes = {
  id: 'deploymentVolumes.id',
  environmentId: 'deploymentVolumes.environmentId',
  providerVolumeId: 'deploymentVolumes.providerVolumeId',
  providerName: 'deploymentVolumes.providerName',
  location: 'deploymentVolumes.location',
  attachedServerId: 'deploymentVolumes.attachedServerId',
  createdAt: 'deploymentVolumes.createdAt',
};
const nodes = {
  id: 'nodes.id',
  userId: 'nodes.userId',
  status: 'nodes.status',
  providerInstanceId: 'nodes.providerInstanceId',
};

type Condition =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'lt'; col: unknown; val: unknown }
  | { op: 'and'; conds: Condition[] }
  | undefined;

interface EnvironmentRow {
  id: string;
  projectId: string;
  nodeId: string | null;
  status: string;
  requiresVolumes: boolean;
}

interface ReleaseRow {
  id: string;
  environmentId: string;
  version: number;
  status: string;
}

interface VolumeRow {
  id: string;
  environmentId: string;
  providerVolumeId: string;
  providerName: string;
  location: string;
  attachedServerId: string | null;
  createdAt: string;
}

interface NodeRow {
  id: string;
  userId: string;
  status: string;
  providerInstanceId: string | null;
}

const mockRequireOwnedProject = vi.fn();
const mockProvisionDeploymentNode = vi.fn();
const mockTeardownDeploymentEnvironmentOnNode = vi.fn();
const mockListEnvironmentVolumes = vi.fn();
const mockAttachEnvironmentVolumesToLinkedNode = vi.fn();
const mockDetachEnvironmentVolumes = vi.fn();
const mockDeleteNodeResources = vi.fn();
const mockBuildDeploymentEnvironmentResponse = vi.fn();

let envRows: EnvironmentRow[] = [];
let releaseRows: ReleaseRow[] = [];
let volumeRows: VolumeRow[] = [];
let nodeRows: NodeRow[] = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentEnvironments,
  deploymentReleases,
  deploymentVolumes,
  nodes,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: (...args: unknown[]) => mockRequireOwnedProject(...args),
}));

vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: (...args: unknown[]) => mockProvisionDeploymentNode(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  teardownDeploymentEnvironmentOnNode: (...args: unknown[]) =>
    mockTeardownDeploymentEnvironmentOnNode(...args),
}));

vi.mock('../../../src/services/deployment-volumes', () => ({
  listEnvironmentVolumes: (...args: unknown[]) => mockListEnvironmentVolumes(...args),
  attachEnvironmentVolumesToLinkedNode: (...args: unknown[]) =>
    mockAttachEnvironmentVolumesToLinkedNode(...args),
  detachEnvironmentVolumes: (...args: unknown[]) => mockDetachEnvironmentVolumes(...args),
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: (...args: unknown[]) => mockDeleteNodeResources(...args),
}));

vi.mock('../../../src/services/deployment-environment-summary', () => ({
  buildDeploymentEnvironmentResponse: (...args: unknown[]) =>
    mockBuildDeploymentEnvironmentResponse(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

const { registerDeploymentEnvironmentLifecycleRoutes } = await import(
  '../../../src/routes/deployment-environment-lifecycle'
);

function eqValue(condition: Condition, col: unknown): unknown {
  if (!condition) {
    return undefined;
  }
  if (condition.op === 'eq') {
    return condition.col === col ? condition.val : undefined;
  }
  if (condition.op === 'lt') {
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
    const userId = eqValue(condition, nodes.userId);
    rows = nodeRows.filter(
      (row) => (id === undefined || row.id === id) && (userId === undefined || row.userId === userId)
    );
  } else if (table === deploymentEnvironments) {
    const id = eqValue(condition, deploymentEnvironments.id);
    const projectId = eqValue(condition, deploymentEnvironments.projectId);
    rows = envRows.filter(
      (row) =>
        (id === undefined || row.id === id) &&
        (projectId === undefined || row.projectId === projectId)
    );
  } else if (table === deploymentReleases) {
    const environmentId = eqValue(condition, deploymentReleases.environmentId);
    rows = releaseRows
      .filter((row) => environmentId === undefined || row.environmentId === environmentId)
      .sort((a, b) => (b.version as number) - (a.version as number));
  } else if (table === deploymentVolumes) {
    const environmentId = eqValue(condition, deploymentVolumes.environmentId);
    rows = volumeRows.filter((row) => environmentId === undefined || row.environmentId === environmentId);
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
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async (condition: Condition) => {
          for (const row of selectRows(table, condition)) {
            Object.assign(row, values);
          }
        }),
      })),
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
  const subRouter = new Hono<{ Bindings: Env }>();
  registerDeploymentEnvironmentLifecycleRoutes(subRouter);
  app.route('/api/projects', subRouter);
  return app;
}

function env(): Env {
  return {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'sammy.party',
  } as Env;
}

function stop(app: ReturnType<typeof createApp>) {
  return app.request(
    '/api/projects/proj-1/environments/env-1/stop',
    { method: 'POST' },
    env()
  );
}

function start(app: ReturnType<typeof createApp>) {
  return app.request(
    '/api/projects/proj-1/environments/env-1/start',
    { method: 'POST' },
    env()
  );
}

describe('deployment environment stop/start lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireOwnedProject.mockResolvedValue(undefined);
    mockBuildDeploymentEnvironmentResponse.mockImplementation(
      async (_db: unknown, _env: unknown, row: EnvironmentRow) => ({
        id: row.id,
        status: row.status,
        nodeId: row.nodeId,
      })
    );
    mockTeardownDeploymentEnvironmentOnNode.mockResolvedValue(undefined);
    mockDeleteNodeResources.mockResolvedValue({ nodeFound: false });
    mockListEnvironmentVolumes.mockImplementation(async (_db: unknown, environmentId: string) =>
      volumeRows.filter((row) => row.environmentId === environmentId)
    );
    mockDetachEnvironmentVolumes.mockImplementation(
      async (_db: unknown, _env: unknown, _userId: unknown, environmentId: string, serverId: string) => {
        const detached = volumeRows.filter(
          (row) => row.environmentId === environmentId && row.attachedServerId === serverId
        );
        for (const row of detached) {
          row.attachedServerId = null;
        }
        return detached;
      }
    );
    mockAttachEnvironmentVolumesToLinkedNode.mockImplementation(
      async (_db: unknown, _env: unknown, _userId: unknown, environmentId: string) => {
        const attached = volumeRows.filter((row) => row.environmentId === environmentId);
        for (const row of attached) {
          row.attachedServerId = 'srv-2';
        }
        return attached;
      }
    );
    mockProvisionDeploymentNode.mockImplementation(async () => {
      const target = envRows.find((row) => row.id === 'env-1');
      if (target) {
        target.nodeId = 'node-2';
      }
      return { nodeId: 'node-2', provisioningStarted: false, provisioningPromise: Promise.resolve() };
    });

    envRows = [
      { id: 'env-1', projectId: 'proj-1', nodeId: 'node-1', status: 'active', requiresVolumes: true },
    ];
    releaseRows = [{ id: 'rel-1', environmentId: 'env-1', version: 7, status: 'created' }];
    volumeRows = [
      {
        id: 'vol-1',
        environmentId: 'env-1',
        providerVolumeId: 'prov-vol-persistent',
        providerName: 'hetzner',
        location: 'nbg1',
        attachedServerId: 'srv-1',
        createdAt: '2026-06-30T00:00:00Z',
      },
    ];
    nodeRows = [{ id: 'node-1', userId: 'user-1', status: 'running', providerInstanceId: 'srv-1' }];
  });

  it('preserves the provider volume across a full stop -> start round-trip', async () => {
    const app = createApp();

    // --- STOP ---
    const stopResponse = await stop(app);
    const stopBody = (await stopResponse.json()) as {
      lifecycle: { stopped: boolean; volumesDetached: number; nodeId: string | null };
    };
    expect(stopResponse.status, JSON.stringify(stopBody)).toBe(200);

    // Live node teardown must run BEFORE volume detach so the VM releases the
    // block device cleanly.
    const teardownOrder = mockTeardownDeploymentEnvironmentOnNode.mock.invocationCallOrder[0];
    const detachOrder = mockDetachEnvironmentVolumes.mock.invocationCallOrder[0];
    expect(teardownOrder).toBeLessThan(detachOrder);
    expect(mockTeardownDeploymentEnvironmentOnNode).toHaveBeenCalledWith(
      'node-1',
      'env-1',
      expect.anything(),
      'user-1'
    );

    // Volume detached from the old server; env stopped and unlinked.
    expect(stopBody.lifecycle.stopped).toBe(true);
    expect(stopBody.lifecycle.volumesDetached).toBe(1);
    expect(volumeRows[0].attachedServerId).toBeNull();
    expect(volumeRows[0].providerVolumeId).toBe('prov-vol-persistent');
    const stoppedEnv = envRows.find((row) => row.id === 'env-1');
    expect(stoppedEnv?.status).toBe('stopped');
    expect(stoppedEnv?.nodeId).toBeNull();

    // --- START ---
    const startResponse = await start(app);
    const startBody = (await startResponse.json()) as {
      lifecycle: { started: boolean; nodeId: string | null; alreadyActive: boolean };
    };
    expect(startResponse.status, JSON.stringify(startBody)).toBe(200);

    // Provisioning uses the placement constraint derived from the volumes.
    expect(mockProvisionDeploymentNode).toHaveBeenCalledWith(
      'env-1',
      'proj-1',
      'user-1',
      expect.anything(),
      expect.objectContaining({
        requiresVolumes: true,
        providerOverride: 'hetzner',
        vmLocationOverride: 'nbg1',
      })
    );

    // The SAME volume (unchanged providerVolumeId) is re-attached to the new node.
    expect(mockAttachEnvironmentVolumesToLinkedNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user-1',
      'env-1'
    );
    expect(volumeRows[0].providerVolumeId).toBe('prov-vol-persistent');
    expect(volumeRows[0].attachedServerId).toBe('srv-2');
    expect(startBody.lifecycle.started).toBe(true);
    expect(startBody.lifecycle.alreadyActive).toBe(false);
    expect(startBody.lifecycle.nodeId).toBe('node-2');
  });

  it('returns 409 when stopping an environment that is already stopping', async () => {
    envRows[0].status = 'stopping';
    const app = createApp();
    const response = await stop(app);
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(409);
    expect(body.error).toBe('CONFLICT');
    expect(mockTeardownDeploymentEnvironmentOnNode).not.toHaveBeenCalled();
  });

  it('propagates a 409 when live node teardown fails on stop', async () => {
    mockTeardownDeploymentEnvironmentOnNode.mockRejectedValue(new Error('agent unreachable'));
    const app = createApp();
    const response = await stop(app);
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(409);
    expect(body.error).toBe('CONFLICT');
    // Volume must NOT be detached when teardown failed.
    expect(mockDetachEnvironmentVolumes).not.toHaveBeenCalled();
    expect(volumeRows[0].attachedServerId).toBe('srv-1');
    expect(envRows.find((row) => row.id === 'env-1')?.status).toBe('error');
  });

  it('returns started:true with alreadyActive when starting an already-active environment', async () => {
    const app = createApp();
    const response = await start(app);
    const body = (await response.json()) as {
      lifecycle: { started: boolean; alreadyActive: boolean; provisioningStarted: boolean };
    };
    expect(response.status).toBe(200);
    expect(body.lifecycle.alreadyActive).toBe(true);
    expect(body.lifecycle.provisioningStarted).toBe(false);
    expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
  });

  it('does not strand the environment in starting when provisioning fails', async () => {
    envRows[0].status = 'stopped';
    envRows[0].nodeId = null;
    volumeRows[0].attachedServerId = null;
    mockProvisionDeploymentNode.mockResolvedValue(null);
    const app = createApp();
    const response = await start(app);
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(409);
    expect(body.error).toBe('CONFLICT');
    const failed = envRows.find((row) => row.id === 'env-1');
    expect(failed?.status).not.toBe('starting');
    expect(failed?.status).toBe('error');
    expect(mockAttachEnvironmentVolumesToLinkedNode).not.toHaveBeenCalled();
  });

  it('returns 409 when requiresVolumes is set but no volume records exist', async () => {
    envRows[0].status = 'stopped';
    envRows[0].nodeId = null;
    volumeRows = [];
    const app = createApp();
    const response = await start(app);
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(409);
    expect(body.error).toBe('CONFLICT');
    expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
  });
});
