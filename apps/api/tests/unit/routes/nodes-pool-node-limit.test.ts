import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { AppError } from '../../../src/middleware/error';
import { nodesRoutes } from '../../../src/routes/nodes';
import { resolveCanonicalVmAllocationPlan } from '../../../src/services/canonical-vm-allocation';
import { scheduleDirectProvisioning } from '../../../src/services/direct-provisioning';
import { CapacityPoolNodeLimitExceededError, createNodeRecord } from '../../../src/services/nodes';
import { recordNodeRoutingMetric } from '../../../src/services/telemetry';
import { applySqliteMigration, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-1',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Placement selection is upstream of the insert under test. Keep the real node
// service, ORM, shipped SQLite trigger and production error handler composed.
vi.mock('../../../src/services/canonical-vm-allocation', () => ({
  resolveCanonicalVmAllocationPlan: vi.fn(),
}));
vi.mock('../../../src/services/direct-provisioning', () => ({
  scheduleDirectProvisioning: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/telemetry', () => ({ recordNodeRoutingMetric: vi.fn() }));

const snapshot: CapacityPlacementSnapshot = {
  capacityPoolId: 'pool-1',
  capacityPoolScope: 'user',
  capacityPoolRevision: 1,
  capacitySourceId: 'source-1',
  capacityPoolCandidateId: 'candidate-1',
  placementCredentialSource: 'user',
  placementCredentialReference: 'credentials:credential-1',
  placementCredentialVersion: 1,
  capacityPoolProjectId: null,
  workloadRole: 'workspace',
};

describe('POST /api/nodes pool node limit — real insert and production error handler', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.nodes, schema.capacityPools]);
    // Reapply the shipped migration, including its default and atomic trigger.
    sqlite.exec('ALTER TABLE capacity_pools DROP COLUMN max_nodes');
    applySqliteMigration(
      sqlite,
      new URL('../../../src/db/migrations/0167_capacity_pool_max_nodes.sql', import.meta.url)
    );
    sqlite.exec("INSERT INTO capacity_pools (id, max_nodes) VALUES ('pool-1', 1)");
    env = { DATABASE: createSqliteD1(sqlite), MAX_NODES_PER_USER: '10' } as Env;
    vi.mocked(resolveCanonicalVmAllocationPlan).mockResolvedValue({
      vmSize: 'small',
      vmLocation: 'fsn1',
      effectiveProvider: 'hetzner',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      quotaCredentialSource: 'user',
      capacityPlacementSnapshot: snapshot,
    } as Awaited<ReturnType<typeof resolveCanonicalVmAllocationPlan>>);
    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/nodes', nodesRoutes);
  });

  afterEach(() => sqlite.close());

  function postNode(): Promise<Response> {
    return app.request(
      '/api/nodes',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-node' }),
      },
      env
    );
  }

  async function fillPool(): Promise<void> {
    await createNodeRecord(env, {
      userId: 'user-1',
      name: 'existing-node',
      vmSize: 'small',
      vmLocation: 'fsn1',
      heartbeatStaleAfterSeconds: 180,
      capacityPlacementSnapshot: snapshot,
    });
  }

  function nodeCount(): number {
    return (sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count;
  }

  it('returns actionable 409 JSON at max_nodes without scheduling provisioning or inserting a node', async () => {
    await fillPool();

    const response = await postNode();

    expect(response.status).toBe(409);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: 'CAPACITY_POOL_NODE_LIMIT',
      message:
        'Your compute pool has reached its node limit. Delete an idle node or ask the pool owner to raise the limit in Infrastructure.',
    });
    expect(resolveCanonicalVmAllocationPlan).toHaveBeenCalledOnce();
    expect(nodeCount()).toBe(1);
    expect(scheduleDirectProvisioning).not.toHaveBeenCalled();
    expect(recordNodeRoutingMetric).not.toHaveBeenCalled();
  });

  it('converts the real trigger error through the ORM cause chain to the named AppError', async () => {
    await fillPool();
    const error = await createNodeRecord(env, {
      userId: 'user-1',
      name: 'rejected',
      vmSize: 'small',
      vmLocation: 'fsn1',
      heartbeatStaleAfterSeconds: 180,
      capacityPlacementSnapshot: snapshot,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CapacityPoolNodeLimitExceededError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      name: 'CapacityPoolNodeLimitExceededError',
      statusCode: 409,
      error: 'CAPACITY_POOL_NODE_LIMIT',
    });
    expect(nodeCount()).toBe(1);
  });

  it('creates and schedules a node below max_nodes, then rejects the next request', async () => {
    const response = await postNode();
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; status: string };
    expect(created.status).toBe('creating');
    expect(nodeCount()).toBe(1);
    expect(scheduleDirectProvisioning).toHaveBeenCalledExactlyOnceWith(env, {
      nodeId: created.id,
      userId: 'user-1',
    });

    expect((await postNode()).status).toBe(409);
    expect(nodeCount()).toBe(1);
    expect(scheduleDirectProvisioning).toHaveBeenCalledOnce();
  });

  it('keeps unrelated insert failures as redacted 500 errors without provisioning', async () => {
    sqlite.exec(`CREATE TRIGGER unrelated_insert_failure BEFORE INSERT ON nodes
      BEGIN SELECT RAISE(ABORT, 'unrelated_database_failure'); END`);

    const response = await postNode();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: expect.any(String),
    });
    expect(nodeCount()).toBe(0);
    expect(scheduleDirectProvisioning).not.toHaveBeenCalled();
    expect(recordNodeRoutingMetric).not.toHaveBeenCalled();
  });
});
