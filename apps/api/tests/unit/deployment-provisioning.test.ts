/**
 * Behavioral tests for deployment node provisioning.
 *
 * Tests the provisionDeploymentNode() service function which:
 * 1. Resolves cloud provider credentials (user → platform fallback)
 * 2. Creates a node record with nodeRole='deployment'
 * 3. Links the environment to the node with placement constraints (conditional on nodeId IS NULL)
 * 4. Returns a provisioning promise for waitUntil()
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the dependencies before importing the module under test
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(),
}));

vi.mock('../../src/services/nodes', () => ({
  createNodeRecord: vi.fn(),
  provisionNode: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ error: String(e) })),
}));

// Structurally mock the drizzle SQL operators so we can assert WHERE-clause
// *content* (which column, which value) rather than just "a WHERE exists".
// Safe because all SQL execution is mocked in this test — the operator return
// values are never handed to a real query engine.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
    isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
    and: vi.fn((...conds: unknown[]) => ({ op: 'and', conds })),
  };
});

import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../src/db/schema';
import {
  DEPLOYMENT_DEFAULT_VM_SIZE,
  provisionDeploymentNode,
} from '../../src/services/deployment-provisioning';
import { createNodeRecord, provisionNode } from '../../src/services/nodes';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Tracks which queries and updates the mock DB received. */
interface MockDbTracker {
  selectCalls: number;
  updateSetValues: Record<string, unknown>[];
  updateWhereArgs: unknown[][];
}

function createMockDb(options: {
  userCredProvider?: string | null;
  platformCredProvider?: string | null;
}) {
  const tracker: MockDbTracker = {
    selectCalls: 0,
    updateSetValues: [],
    updateWhereArgs: [],
  };

  // Build credential rows
  const userCredRows = options.userCredProvider ? [{ provider: options.userCredProvider }] : [];
  const platformCredRows = options.platformCredProvider
    ? [{ provider: options.platformCredProvider }]
    : [];

  const mockDb = {
    select: vi.fn().mockImplementation(() => {
      tracker.selectCalls++;
      const callIdx = tracker.selectCalls;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              if (callIdx <= 1) return Promise.resolve(userCredRows);
              return Promise.resolve(platformCredRows);
            }),
          }),
        }),
      };
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        tracker.updateSetValues.push(values);
        return {
          where: vi.fn().mockImplementation((...args: unknown[]) => {
            tracker.updateWhereArgs.push(args);
            return Promise.resolve();
          }),
        };
      }),
    })),
    _tracker: tracker,
  };

  return mockDb;
}

function makeNodeResult(
  overrides: Partial<{
    id: string;
    userId: string;
    name: string;
    cloudProvider: string;
    vmLocation: string;
  }> = {}
) {
  return {
    id: overrides.id ?? 'node-deploy-1',
    userId: overrides.userId ?? 'user-1',
    name: overrides.name ?? 'deploy-env12345',
    status: 'creating' as const,
    vmSize: 'small',
    vmLocation: overrides.vmLocation ?? 'fsn1',
    cloudProvider: overrides.cloudProvider ?? 'hetzner',
    ipAddress: null,
    lastHeartbeatAt: null,
    healthStatus: 'stale' as const,
    heartbeatStaleAfterSeconds: 300,
    errorMessage: null,
    createdAt: '2026-06-13T00:00:00Z',
    updatedAt: '2026-06-13T00:00:00Z',
  };
}

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE: {} as D1Database,
    ...overrides,
  } as any;
}

function createRawMockEnv(steps: Array<{ all?: unknown; run?: unknown }>) {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    env: {
      DATABASE: {
        prepare: vi.fn().mockImplementation((sql: string) => {
          const step = steps.shift();
          const statement = {
            sql,
            binds: [] as unknown[],
            bind: vi.fn().mockImplementation((...binds: unknown[]) => {
              statement.binds = binds;
              statements.push({ sql, binds });
              return statement;
            }),
            all: vi.fn().mockResolvedValue(step?.all ?? { results: [] }),
            run: vi.fn().mockResolvedValue(step?.run ?? { meta: { changes: 0 } }),
          };
          return statement;
        }),
      } as unknown as D1Database,
    } as any,
    statements,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provisionDeploymentNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a node with nodeRole=deployment using user cloud credential', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult());
    vi.mocked(provisionNode).mockResolvedValue();

    const result = await provisionDeploymentNode(
      'env-12345678-abcd',
      'proj-1',
      'user-1',
      createMockEnv()
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('node-deploy-1');
    expect(result!.provisioningPromise).toBeInstanceOf(Promise);

    // Verify createNodeRecord was called with deployment role
    expect(createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        nodeRole: 'deployment',
        vmSize: DEPLOYMENT_DEFAULT_VM_SIZE,
        cloudProvider: 'hetzner',
        heartbeatStaleAfterSeconds: 300,
      })
    );

    // Verify provisionNode was called with deployment context
    expect(provisionNode).toHaveBeenCalledWith(
      'node-deploy-1',
      expect.anything(),
      undefined, // no taskContext
      undefined, // no options
      { environmentId: 'env-12345678-abcd' } // deployment context
    );
  });

  it('links environment to node via conditional UPDATE', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult());
    vi.mocked(provisionNode).mockResolvedValue();

    await provisionDeploymentNode('env-link-test', 'proj-1', 'user-1', createMockEnv());

    // The environment should be linked to the node
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb._tracker.updateSetValues.length).toBe(1);

    const setValues = mockDb._tracker.updateSetValues[0]!;
    expect(setValues).toHaveProperty('nodeId', 'node-deploy-1');
    expect(setValues).toHaveProperty('provider', 'hetzner');
    expect(setValues).toHaveProperty('location', 'fsn1');
    expect(setValues).toHaveProperty('updatedAt');
  });

  it('does not link to a selected existing node unless it is still running', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-fresh-after-race' }));
    vi.mocked(provisionNode).mockResolvedValue();

    const { env, statements } = createRawMockEnv([
      {
        all: {
          results: [
            { id: 'node-existing', vm_size: 'small', vm_location: 'fsn1', last_metrics: null },
          ],
        },
      },
      { all: { results: [] } },
      { run: { meta: { changes: 0 } } },
      { run: { meta: { changes: 1 } } },
    ]);

    const result = await provisionDeploymentNode('env-race', 'proj-1', 'user-1', env);

    expect(result?.nodeId).toBe('node-fresh-after-race');
    expect(createNodeRecord).toHaveBeenCalledTimes(1);
    expect(provisionNode).toHaveBeenCalledWith(
      'node-fresh-after-race',
      expect.anything(),
      undefined,
      undefined,
      { environmentId: 'env-race' }
    );

    const updateStatements = statements.filter((statement) =>
      statement.sql.includes('UPDATE deployment_environments')
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[0]!.sql).toContain('AND EXISTS');
    expect(updateStatements[0]!.binds).toContain('running');
    expect(updateStatements[1]!.binds).toContain('creating');
  });

  it('falls back to platform credentials when user has none', async () => {
    const mockDb = createMockDb({
      userCredProvider: null,
      platformCredProvider: 'scaleway',
    });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(
      makeNodeResult({ id: 'node-deploy-2', cloudProvider: 'scaleway', vmLocation: 'par1' })
    );
    vi.mocked(provisionNode).mockResolvedValue();

    const result = await provisionDeploymentNode(
      'env-abcdefgh',
      'proj-1',
      'user-1',
      createMockEnv()
    );

    expect(result).not.toBeNull();
    expect(createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudProvider: 'scaleway',
        nodeRole: 'deployment',
      })
    );
  });

  it('returns null when no cloud credentials exist', async () => {
    const mockDb = createMockDb({
      userCredProvider: null,
      platformCredProvider: null,
    });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);

    const result = await provisionDeploymentNode(
      'env-nocreds',
      'proj-1',
      'user-1',
      createMockEnv()
    );

    expect(result).toBeNull();
    expect(createNodeRecord).not.toHaveBeenCalled();
  });

  it('uses DEPLOYMENT_DEFAULT_VM_SIZE (small)', () => {
    expect(DEPLOYMENT_DEFAULT_VM_SIZE).toBe('small');
  });

  it('uses DEPLOYMENT_DEFAULT_VM_SIZE env override when creating a deployment node', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-deploy-medium' }));
    vi.mocked(provisionNode).mockResolvedValue();

    await provisionDeploymentNode(
      'env-medium',
      'proj-1',
      'user-1',
      createMockEnv({ DEPLOYMENT_DEFAULT_VM_SIZE: 'medium' })
    );

    expect(createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ vmSize: 'medium' })
    );
  });

  it('provisioning promise catches errors without throwing', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-deploy-err' }));
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));

    const result = await provisionDeploymentNode('env-fail', 'proj-1', 'user-1', createMockEnv());

    expect(result).not.toBeNull();
    // The provisioning promise should not throw — it has a .catch()
    await expect(result!.provisioningPromise).resolves.toBeUndefined();
  });

  it('rolls back nodeId to NULL when provisioning fails (Gap 7)', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-rollback-1' }));
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));

    const result = await provisionDeploymentNode(
      'env-rollback',
      'proj-1',
      'user-1',
      createMockEnv()
    );

    expect(result).not.toBeNull();

    // Wait for the provisioning promise (catch handler runs the rollback)
    await result!.provisioningPromise;

    // There should be 2 update calls:
    // 1. Initial link: set nodeId = 'node-rollback-1'
    // 2. Rollback: set nodeId = null
    expect(mockDb._tracker.updateSetValues).toHaveLength(2);

    // First update sets nodeId to the new node
    expect(mockDb._tracker.updateSetValues[0]).toHaveProperty('nodeId', 'node-rollback-1');

    // Second update rolls back nodeId to null
    expect(mockDb._tracker.updateSetValues[1]).toHaveProperty('nodeId', null);
    expect(mockDb._tracker.updateSetValues[1]).toHaveProperty('updatedAt');

    // Both updates must have WHERE clauses (tracked via updateWhereArgs)
    expect(mockDb._tracker.updateWhereArgs).toHaveLength(2);

    // ---- WHERE-clause CONTENT assertions (T4: nodeId-scoped, not just "exists") ----

    // Initial link WHERE: and(eq(id, envId), isNull(nodeId)) — conditional link
    // only applies when the env is not already bound to a node.
    const linkWhere = mockDb._tracker.updateWhereArgs[0]![0] as {
      op: string;
      conds: Array<{ op: string; col: unknown; val?: unknown }>;
    };
    expect(linkWhere.op).toBe('and');
    expect(linkWhere.conds).toHaveLength(2);
    const linkIdCond = linkWhere.conds.find((cond) => cond.op === 'eq')!;
    expect(linkIdCond.col).toBe(schema.deploymentEnvironments.id);
    expect(linkIdCond.val).toBe('env-rollback');
    const linkNodeCond = linkWhere.conds.find((cond) => cond.op === 'isNull')!;
    expect(linkNodeCond.col).toBe(schema.deploymentEnvironments.nodeId);

    // Rollback WHERE: and(eq(id, envId), eq(nodeId, node.id)) — only clears the
    // nodeId we set, never another concurrent writer's node binding.
    const rollbackWhere = mockDb._tracker.updateWhereArgs[1]![0] as {
      op: string;
      conds: Array<{ op: string; col: unknown; val?: unknown }>;
    };
    expect(rollbackWhere.op).toBe('and');
    expect(rollbackWhere.conds).toHaveLength(2);
    const rollbackIdCond = rollbackWhere.conds.find(
      (cond) => cond.op === 'eq' && cond.col === schema.deploymentEnvironments.id
    )!;
    expect(rollbackIdCond.val).toBe('env-rollback');
    const rollbackNodeCond = rollbackWhere.conds.find(
      (cond) => cond.op === 'eq' && cond.col === schema.deploymentEnvironments.nodeId
    )!;
    expect(rollbackNodeCond.val).toBe('node-rollback-1');
  });

  it('rollback is robust even if the rollback update itself fails', async () => {
    // Create a DB where the second update call throws
    const tracker = {
      selectCalls: 0,
      updateSetValues: [] as Record<string, unknown>[],
      updateWhereArgs: [] as unknown[][],
    };
    let updateCallCount = 0;
    const mockDb = {
      select: vi.fn().mockImplementation(() => {
        tracker.selectCalls++;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ provider: 'hetzner' }]),
            }),
          }),
        };
      }),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updateCallCount++;
          tracker.updateSetValues.push(values);
          return {
            where: vi.fn().mockImplementation(() => {
              // Second update (rollback) throws
              if (updateCallCount >= 2) return Promise.reject(new Error('DB write failed'));
              return Promise.resolve();
            }),
          };
        }),
      })),
      _tracker: tracker,
    };

    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-rollback-fail' }));
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));

    const result = await provisionDeploymentNode(
      'env-rollback-fail',
      'proj-1',
      'user-1',
      createMockEnv()
    );

    expect(result).not.toBeNull();

    // The provisioning promise should still not throw, even if rollback fails
    await expect(result!.provisioningPromise).resolves.toBeUndefined();

    // Both updates were attempted
    expect(tracker.updateSetValues).toHaveLength(2);
    // The rollback was attempted (nodeId: null)
    expect(tracker.updateSetValues[1]).toHaveProperty('nodeId', null);
  });
});

// ---------------------------------------------------------------------------
// Cloud-init deployment role and Docker daemon config are tested
// behaviorally in packages/cloud-init/tests/generate.test.ts
// (YAML parse + round-trip assertions, not source-contract).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DNS skip for deployment nodes (behavioral — spy on provisionNode)
// ---------------------------------------------------------------------------

describe('deployment node skips DNS record creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provisionNode receives deployment context that triggers DNS skip', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult());
    vi.mocked(provisionNode).mockResolvedValue();

    await provisionDeploymentNode('env-dns-skip', 'proj-1', 'user-1', createMockEnv());

    // provisionNode receives the deploymentContext which triggers the DNS skip
    // in nodes.ts (isDeploymentNode = !!deploymentContext?.environmentId)
    const callArgs = vi.mocked(provisionNode).mock.calls[0]!;
    expect(callArgs[4]).toEqual({ environmentId: 'env-dns-skip' });
  });
});
