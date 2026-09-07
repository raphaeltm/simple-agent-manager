/**
 * Behavioral tests for deployment node provisioning.
 *
 * The service resolves a canonical deployment allocation, reuses only current
 * deployment nodes that still satisfy authority predicates, or creates and
 * provisions a new deployment node with the same placement contract.
 */
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  createNodeRecord: vi.fn(),
  placementProjectDefaultsFromRow: vi.fn(),
  provisionNode: vi.fn(),
  resolveCanonicalVmAllocationPlan: vi.fn(),
}));

vi.mock('../../src/services/canonical-vm-allocation', () => ({
  placementProjectDefaultsFromRow: mocks.placementProjectDefaultsFromRow,
  resolveCanonicalVmAllocationPlan: mocks.resolveCanonicalVmAllocationPlan,
}));

vi.mock('../../src/services/nodes', () => ({
  createNodeRecord: mocks.createNodeRecord,
  provisionNode: mocks.provisionNode,
}));

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ error: String(e) })),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
    ne: vi.fn((col: unknown, val: unknown) => ({ op: 'ne', col, val })),
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

interface MockDbTracker {
  updateSetValues: Record<string, unknown>[];
  updateWhereArgs: unknown[][];
  deleteWhereArgs: unknown[][];
}

function projectRow() {
  return {
    id: 'proj-1',
    defaultVmSize: 'medium',
    defaultProvider: 'hetzner',
    defaultLocation: 'fsn1',
    defaultWorkspaceProfile: 'lightweight',
    defaultDevcontainerConfigName: null,
    defaultAgentType: null,
  };
}

function canonicalAllocation(
  overrides: Partial<{
    effectiveProvider: CredentialProvider;
    vmSize: string;
    vmLocation: string;
    credentialAttributionSource: 'user' | 'project' | 'platform';
    credentialAttributionProjectId: string | null;
    providerInstanceType: string | null;
  }> = {}
) {
  return {
    placement: { workloadRole: 'deployment' },
    credential: {
      credentialSource: overrides.credentialAttributionSource ?? 'user',
      providerName: overrides.effectiveProvider ?? 'hetzner',
    },
    quotaCredentialSource: overrides.credentialAttributionSource ?? 'user',
    credentialAttributionUserId: 'user-1',
    credentialAttributionProjectId: overrides.credentialAttributionProjectId ?? null,
    credentialAttributionSource: overrides.credentialAttributionSource ?? 'user',
    effectiveProvider: overrides.effectiveProvider ?? 'hetzner',
    vmSize: overrides.vmSize ?? 'small',
    vmLocation: overrides.vmLocation ?? 'fsn1',
    providerInstanceType: overrides.providerInstanceType ?? 'cx22',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPoolSelection: null,
    capacityPlacementSnapshot: null,
  };
}

function createMockDb(options: { currentNodeId?: string | null; rollbackFails?: boolean } = {}) {
  const tracker: MockDbTracker = {
    updateSetValues: [],
    updateWhereArgs: [],
    deleteWhereArgs: [],
  };

  const mockDb = {
    select: vi.fn().mockImplementation((projection?: Record<string, unknown>) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (projection && Object.prototype.hasOwnProperty.call(projection, 'nodeId')) {
              return Promise.resolve(
                options.currentNodeId ? [{ nodeId: options.currentNodeId }] : []
              );
            }
            return Promise.resolve([projectRow()]);
          }),
        }),
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        tracker.updateSetValues.push(values);
        return {
          where: vi.fn().mockImplementation((...args: unknown[]) => {
            tracker.updateWhereArgs.push(args);
            return options.rollbackFails
              ? Promise.reject(new Error('DB write failed'))
              : Promise.resolve();
          }),
        };
      }),
    })),
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((...args: unknown[]) => {
        tracker.deleteWhereArgs.push(args);
        return Promise.resolve();
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

type RawMethod = 'all' | 'run' | 'first';
type RawResolver = (sql: string, binds: unknown[], method: RawMethod) => unknown | Promise<unknown>;

function createRawMockEnv(resolver?: RawResolver, overrides: Record<string, unknown> = {}) {
  const statements: Array<{ method: RawMethod; sql: string; binds: unknown[] }> = [];
  const defaultResolver: RawResolver = (_sql, _binds, method) => {
    if (method === 'all') return { results: [] };
    if (method === 'run') return { meta: { changes: 1 } };
    return null;
  };

  return {
    env: {
      DATABASE: {
        prepare: vi.fn().mockImplementation((sql: string) => {
          const statement = {
            binds: [] as unknown[],
            bind: vi.fn().mockImplementation((...binds: unknown[]) => {
              statement.binds = binds;
              return statement;
            }),
            all: vi.fn().mockImplementation(async () => {
              statements.push({ method: 'all', sql, binds: statement.binds });
              return (resolver ?? defaultResolver)(sql, statement.binds, 'all');
            }),
            run: vi.fn().mockImplementation(async () => {
              statements.push({ method: 'run', sql, binds: statement.binds });
              return (resolver ?? defaultResolver)(sql, statement.binds, 'run');
            }),
            first: vi.fn().mockImplementation(async () => {
              statements.push({ method: 'first', sql, binds: statement.binds });
              return (resolver ?? defaultResolver)(sql, statement.binds, 'first');
            }),
          };
          return statement;
        }),
      } as unknown as D1Database,
      ...overrides,
    } as any,
    statements,
  };
}

describe('provisionDeploymentNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placementProjectDefaultsFromRow.mockImplementation((project) => project);
    mocks.resolveCanonicalVmAllocationPlan.mockResolvedValue(canonicalAllocation());
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult());
    vi.mocked(provisionNode).mockResolvedValue();
  });

  it('creates a node with nodeRole=deployment from the canonical allocation', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    const { env } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-12345678-abcd', 'proj-1', 'user-1', env);

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('node-deploy-1');
    expect(result!.provisioningPromise).toBeInstanceOf(Promise);
    expect(mocks.resolveCanonicalVmAllocationPlan).toHaveBeenCalledWith(
      mockDb,
      env,
      expect.objectContaining({
        entryPoint: 'deployment-provisioning',
        userId: 'user-1',
        projectId: 'proj-1',
        project: projectRow(),
        workloadRole: 'deployment',
        credentialProjectPolicy: 'current-project',
      })
    );
    expect(createNodeRecord).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        nodeRole: 'deployment',
        vmSize: DEPLOYMENT_DEFAULT_VM_SIZE,
        cloudProvider: 'hetzner',
        credentialAttributionSource: 'user',
        providerInstanceType: 'cx22',
        heartbeatStaleAfterSeconds: 300,
      })
    );
    expect(provisionNode).toHaveBeenCalledWith(
      'node-deploy-1',
      env,
      undefined,
      { rethrowProviderError: true, authorityProjectId: 'proj-1' },
      { environmentId: 'env-12345678-abcd', projectId: 'proj-1' }
    );
  });

  it('links environment to a fresh node with authority-aware raw SQL', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    const { env, statements } = createRawMockEnv();

    await provisionDeploymentNode('env-link-test', 'proj-1', 'user-1', env);

    const update = statements.find((statement) =>
      statement.sql.includes('UPDATE deployment_environments')
    );
    expect(update?.sql).toContain('node_id IS NULL');
    expect(update?.sql).toContain('AND EXISTS');
    expect(update?.sql).toContain("n.runtime = 'vm'");
    expect(update?.sql).toContain("n.node_class = 'managed'");
    expect(update?.sql).toContain('project_members current_project_member');
    expect(update?.sql).toContain('capacity_pool_id IS NULL');
    expect(update?.binds).toEqual(
      expect.arrayContaining([
        'node-deploy-1',
        'hetzner',
        'fsn1',
        'env-link-test',
        'creating',
        'shared',
        'deployment',
        'proj-1',
        'user-1',
      ])
    );
  });

  it('does not link to a selected existing node unless it is still running', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-fresh-after-race' }));
    vi.mocked(provisionNode).mockResolvedValue();
    let updateCount = 0;
    const { env, statements } = createRawMockEnv((sql, _binds, method) => {
      if (method === 'all' && sql.includes('FROM nodes n')) {
        return {
          results: [
            { id: 'node-existing', vm_size: 'small', vm_location: 'fsn1', last_metrics: null },
          ],
        };
      }
      if (method === 'all' && sql.includes('FROM deployment_environments')) {
        return { results: [] };
      }
      if (method === 'run' && sql.includes('UPDATE deployment_environments')) {
        updateCount += 1;
        return { meta: { changes: updateCount === 1 ? 0 : 1 } };
      }
      return method === 'run' ? { meta: { changes: 1 } } : { results: [] };
    });

    const result = await provisionDeploymentNode('env-race', 'proj-1', 'user-1', env);

    expect(result?.nodeId).toBe('node-fresh-after-race');
    expect(createNodeRecord).toHaveBeenCalledTimes(1);
    const updates = statements.filter((statement) =>
      statement.sql.includes('UPDATE deployment_environments')
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]!.binds).toContain('running');
    expect(updates[1]!.binds).toContain('creating');
  });

  it('volume-free placement only reuses shared deployment nodes', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    const { env, statements } = createRawMockEnv();

    await provisionDeploymentNode('env-shared-only', 'proj-1', 'user-1', env);

    const candidateQuery = statements.find((statement) => statement.sql.includes('FROM nodes n'));
    expect(candidateQuery?.sql).toContain("COALESCE(n.node_mode, 'shared') = 'shared'");
    expect(candidateQuery?.sql).toContain("n.node_role = 'deployment'");
  });

  it('volume placement skips existing-node reuse and creates an exclusive node', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-exclusive-1' }));
    const { env, statements } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-volume', 'proj-1', 'user-1', env, {
      requiresVolumes: true,
    });

    expect(result?.nodeId).toBe('node-exclusive-1');
    expect(createNodeRecord).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ nodeMode: 'exclusive', nodeRole: 'deployment' })
    );
    expect(statements.some((statement) => statement.sql.includes('SELECT n.id, n.vm_size'))).toBe(
      false
    );
  });

  it('exclusive node link asserts the fresh node has no existing environments', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-exclusive-guard' }));
    const { env, statements } = createRawMockEnv();

    await provisionDeploymentNode('env-exclusive-guard', 'proj-1', 'user-1', env, {
      requiresVolumes: true,
    });

    const update = statements.find((statement) =>
      statement.sql.includes('UPDATE deployment_environments')
    );
    expect(update?.sql).toContain("COALESCE(n.node_mode, 'shared') = ?");
    expect(update?.sql).toContain('NOT EXISTS');
    expect(update?.sql).toContain('existing.node_id = n.id');
    expect(update?.binds).toContain('exclusive');
  });

  it('uses platform allocation when canonical placement selected platform credentials', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    mocks.resolveCanonicalVmAllocationPlan.mockResolvedValue(
      canonicalAllocation({
        effectiveProvider: 'scaleway',
        vmLocation: 'par1',
        credentialAttributionSource: 'platform',
      })
    );
    vi.mocked(createNodeRecord).mockResolvedValue(
      makeNodeResult({ id: 'node-deploy-2', cloudProvider: 'scaleway', vmLocation: 'par1' })
    );
    const { env } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-abcdefgh', 'proj-1', 'user-1', env);

    expect(result).not.toBeNull();
    expect(createNodeRecord).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        cloudProvider: 'scaleway',
        vmLocation: 'par1',
        credentialAttributionSource: 'platform',
        nodeRole: 'deployment',
      })
    );
  });

  it('returns null when canonical allocation has no current credentials', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    mocks.resolveCanonicalVmAllocationPlan.mockResolvedValue({
      error: 'No current deployment credentials',
      errorKind: 'credentials',
    });
    const { env } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-nocreds', 'proj-1', 'user-1', env);

    expect(result).toBeNull();
    expect(createNodeRecord).not.toHaveBeenCalled();
  });

  it('uses DEPLOYMENT_DEFAULT_VM_SIZE (small)', () => {
    expect(DEPLOYMENT_DEFAULT_VM_SIZE).toBe('small');
  });

  it('uses DEPLOYMENT_DEFAULT_VM_SIZE env override when resolving deployment allocation', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    mocks.resolveCanonicalVmAllocationPlan.mockResolvedValue(
      canonicalAllocation({ vmSize: 'medium' })
    );
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-deploy-medium' }));
    const { env } = createRawMockEnv(undefined, { DEPLOYMENT_DEFAULT_VM_SIZE: 'medium' });

    await provisionDeploymentNode('env-medium', 'proj-1', 'user-1', env);

    expect(mocks.resolveCanonicalVmAllocationPlan).toHaveBeenCalledWith(
      mockDb,
      env,
      expect.objectContaining({
        explicit: expect.objectContaining({ vmSize: 'medium' }),
      })
    );
    expect(createNodeRecord).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ vmSize: 'medium' })
    );
  });

  it('provisioning promise rolls back nodeId and rejects so callers can mark failure', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-deploy-err' }));
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));
    const { env } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-fail', 'proj-1', 'user-1', env);

    expect(result).not.toBeNull();
    await expect(result!.provisioningPromise).rejects.toThrow('VM creation failed');
    expect(mockDb._tracker.updateSetValues[0]).toHaveProperty('nodeId', null);
  });

  it('rolls back only the nodeId written by this provisioning attempt', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-rollback-1' }));
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));
    const { env } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-rollback', 'proj-1', 'user-1', env);

    expect(result).not.toBeNull();
    await expect(result!.provisioningPromise).rejects.toThrow('VM creation failed');
    expect(mockDb._tracker.updateSetValues).toHaveLength(1);
    expect(mockDb._tracker.updateSetValues[0]).toHaveProperty('nodeId', null);

    const rollbackWhere = mockDb._tracker.updateWhereArgs[0]![0] as {
      op: string;
      conds: Array<{ op: string; col: unknown; val?: unknown }>;
    };
    expect(rollbackWhere.op).toBe('and');
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
    const mockDb = createMockDb({ rollbackFails: true });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult({ id: 'node-rollback-fail' }));
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));
    const { env } = createRawMockEnv();

    const result = await provisionDeploymentNode('env-rollback-fail', 'proj-1', 'user-1', env);

    expect(result).not.toBeNull();
    await expect(result!.provisioningPromise).rejects.toThrow('VM creation failed');
    expect(mockDb._tracker.updateSetValues[0]).toHaveProperty('nodeId', null);
  });
});

describe('deployment node skips DNS record creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placementProjectDefaultsFromRow.mockImplementation((project) => project);
    mocks.resolveCanonicalVmAllocationPlan.mockResolvedValue(canonicalAllocation());
    vi.mocked(createNodeRecord).mockResolvedValue(makeNodeResult());
    vi.mocked(provisionNode).mockResolvedValue();
  });

  it('provisionNode receives deployment context that triggers DNS skip', async () => {
    const mockDb = createMockDb();
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    const { env } = createRawMockEnv();

    await provisionDeploymentNode('env-dns-skip', 'proj-1', 'user-1', env);

    const callArgs = vi.mocked(provisionNode).mock.calls[0]!;
    expect(callArgs[4]).toEqual({ environmentId: 'env-dns-skip', projectId: 'proj-1' });
  });
});
