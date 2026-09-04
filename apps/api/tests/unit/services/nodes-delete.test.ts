import { beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRows: unknown[] = [];
const updateCalls: Array<Record<string, unknown>> = [];
let selectCallCount = 0;
let beforeSelectReturn: ((call: number) => void) | null = null;

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => {
      const selectRows = async () => {
        selectCallCount += 1;
        beforeSelectReturn?.(selectCallCount);
        return nodeRows;
      };
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: selectRows,
        then: <TResult1 = unknown[], TResult2 = never>(
          onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) => selectRows().then(onfulfilled, onrejected),
      };
      return builder;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          let execution: Promise<{ meta: { changes: number } }> | undefined;
          const execute = () => {
            if (!execution) {
              updateCalls.push(values);
              if (
                nodeRows[0] &&
                typeof nodeRows[0] === 'object' &&
                (typeof values.runtimeTerminationConfirmedAt === 'string' ||
                  (values.status === 'destroying' && values.healthStatus === 'stale'))
              ) {
                nodeRows[0] = { ...nodeRows[0], ...values };
              }
              execution = Promise.resolve({ meta: { changes: 1 } });
            }
            return execution;
          };
          return {
            run: execute,
            then: <TResult1 = { meta: { changes: number } }, TResult2 = never>(
              onfulfilled?:
                | ((value: { meta: { changes: number } }) => TResult1 | PromiseLike<TResult1>)
                | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ) => execute().then(onfulfilled, onrejected),
          };
        },
      }),
    }),
  }),
}));

const providerDeleteVM = vi.fn(async () => {});
const providerGetVM = vi.fn(async () => ({ id: 'vm-1' }));
const createProviderForUser = vi.fn();
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: (...args: unknown[]) => createProviderForUser(...args),
  exactProviderCredentialBindingFromPlacementSnapshot: (snapshot: {
    capacityPoolId?: string | null;
    placementCredentialSource?: string | null;
    placementCredentialReference?: string | null;
    placementCredentialVersion?: number | null;
  }) => {
    if (
      !(
        snapshot.placementCredentialSource === 'user' ||
        snapshot.placementCredentialSource === 'project' ||
        snapshot.placementCredentialSource === 'platform'
      ) ||
      !snapshot.placementCredentialReference
    ) {
      return null;
    }
    return {
      credentialSource: snapshot.placementCredentialSource,
      credentialReference: snapshot.placementCredentialReference,
      credentialVersion: snapshot.placementCredentialVersion ?? null,
    };
  },
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-key',
}));

const deleteDNSRecord = vi.fn(async () => {});
vi.mock('../../../src/services/dns', () => ({
  deleteDNSRecord: (...args: unknown[]) => deleteDNSRecord(...args),
  createNodeBackendDNSRecord: vi.fn(),
}));

const destroyVmAgentContainer = vi.fn(async () => {});
vi.mock('../../../src/services/vm-agent-container', () => ({
  destroyVmAgentContainer: (...args: unknown[]) => destroyVmAgentContainer(...args),
}));

const persistError = vi.fn(async () => {});
vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => persistError(...args),
}));

const finalizeWorkspaceLifecycleClosure = vi.fn(async () => ({
  workspaces: 0,
  agentSessionsClosed: 0,
  computeUsageClosed: 0,
  projectSessionsClosed: 0,
  projectSessionErrors: 0,
  workspaceActivityCleaned: 0,
  workspaceActivityErrors: 0,
}));
vi.mock('../../../src/services/workspace-lifecycle-finalizer', () => ({
  finalizeWorkspaceLifecycleClosure: (...args: unknown[]) =>
    finalizeWorkspaceLifecycleClosure(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  })),
}));

const {
  deleteNodeResources,
  deleteNodeResourcesStrict,
  retireDeletedDeploymentNodeRecord,
  stopNodeResources,
} = await import('../../../src/services/nodes');
const { drizzle } = await import('drizzle-orm/d1');

const ENV = {
  DATABASE: {},
} as unknown as Parameters<typeof deleteNodeResources>[2];

describe('node resource deletion services', () => {
  beforeEach(() => {
    nodeRows.length = 0;
    updateCalls.length = 0;
    selectCallCount = 0;
    beforeSelectReturn = null;
    vi.clearAllMocks();
    createProviderForUser.mockImplementation(async (...args: unknown[]) => {
      if (args[4] !== 'hetzner') return null;
      return {
        provider: {
          deleteVM: providerDeleteVM,
          getVM: providerGetVM,
        },
        providerName: 'hetzner',
        credentialSource: 'platform',
      };
    });
  });

  // --- User-owned (BYO) lifecycle guards (architecture-critique #2) -----------------------------
  function userOwnedNode(overrides: Record<string, unknown> = {}) {
    return {
      id: 'byo-1',
      userId: 'user-1',
      name: 'home server',
      status: 'running',
      nodeClass: 'user-owned',
      runtime: 'vm',
      providerInstanceId: null,
      cloudProvider: null,
      backendDnsRecordId: null,
      credentialAttributionUserId: null,
      credentialAttributionSource: 'user',
      credentialAttributionProjectId: null,
      ...overrides,
    };
  }

  function managedPoolNode(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pool-node-1',
      userId: 'user-1',
      name: 'pool node',
      status: 'running',
      nodeClass: 'managed',
      runtime: 'vm',
      runtimeIncarnationId: 'runtime-incarnation-pool-1',
      providerInstanceId: 'vm-pool-1',
      cloudProvider: 'hetzner',
      backendDnsRecordId: null,
      credentialAttributionUserId: 'pool-owner-1',
      credentialAttributionSource: 'project',
      credentialAttributionProjectId: 'project-1',
      capacityPoolId: 'pool-project-1',
      placementCredentialSource: 'project',
      placementCredentialReference: 'credentials:project-cloud-1',
      placementCredentialVersion: 1787875200000,
      ...overrides,
    };
  }

  it('stopNodeResources takes a user-owned node OFFLINE (stopped), never deletes it or its VM', async () => {
    nodeRows.push(userOwnedNode());

    await stopNodeResources('byo-1', 'user-1', ENV);

    // Node marked 'stopped' (offline), NOT 'deleted'; the enrolled machine's record survives.
    expect(updateCalls.some((u) => u.status === 'stopped')).toBe(true);
    expect(updateCalls.some((u) => u.status === 'deleted' && 'healthStatus' in u)).toBe(false);
    // Never touch cloud provider or DNS for the user's own hardware.
    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it('deleteNodeResources never calls provider.deleteVM for a user-owned node', async () => {
    nodeRows.push(userOwnedNode());

    const result = await deleteNodeResources('byo-1', 'user-1', ENV);

    expect(result.providerVmDeleted).toBe(false);
    expect(result.providerVmDeleteSkippedReason).toBe('user-owned node — no cloud VM to delete');
    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
  });

  it('deleteNodeResources never calls deleteVM even if a user-owned node has a stray providerInstanceId', async () => {
    // Defense-in-depth: a BYO node should never have a providerInstanceId, but if one leaked in we
    // must still refuse to delete a cloud VM against the user's hardware.
    nodeRows.push(
      userOwnedNode({ providerInstanceId: 'srv-should-not-touch', cloudProvider: 'hetzner' })
    );

    const result = await deleteNodeResources('byo-1', 'user-1', ENV);

    expect(result.providerVmDeleteSkippedReason).toBe('user-owned node — no cloud VM to delete');
    expect(providerDeleteVM).not.toHaveBeenCalled();
  });

  it('stopNodeResources on a user-owned node with a STRAY providerInstanceId still never deletes VM/DNS', async () => {
    // Discriminating for the guard itself (not the incidental null-checks): even with populated
    // providerInstanceId + cloudProvider + backendDnsRecordId, the user-owned guard must short-circuit.
    nodeRows.push(
      userOwnedNode({
        providerInstanceId: 'srv-should-not-touch',
        cloudProvider: 'hetzner',
        backendDnsRecordId: 'dns-should-not-touch',
      })
    );

    await stopNodeResources('byo-1', 'user-1', ENV);

    expect(updateCalls.some((u) => u.status === 'stopped')).toBe(true);
    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it('deleteNodeResources destroys the cf-container for a managed cf-container node (asymmetry fix)', async () => {
    // Pre-fix, deleteNodeResources had no container branch and leaked the Sandbox container.
    nodeRows.push({
      id: 'cf-1',
      userId: 'user-1',
      name: 'cf node',
      status: 'running',
      nodeClass: 'managed',
      runtime: 'cf-container',
      providerInstanceId: null,
      cloudProvider: null,
      backendDnsRecordId: null,
      credentialAttributionUserId: null,
      credentialAttributionSource: 'user',
      credentialAttributionProjectId: null,
    });

    const result = await deleteNodeResources('cf-1', 'user-1', ENV);

    expect(destroyVmAgentContainer).toHaveBeenCalledWith(ENV, 'cf-1');
    expect(result.runtimeTerminationConfirmed).toBe(true);
    expect(updateCalls).toContainEqual({ runtimeTerminationConfirmedAt: expect.any(String) });
  });

  it('stopNodeResources deletes a pool-provisioned VM with its exact placement credential', async () => {
    nodeRows.push(managedPoolNode());

    await stopNodeResources('pool-node-1', 'user-1', ENV);

    expect(createProviderForUser).toHaveBeenCalledWith(
      expect.anything(),
      'pool-owner-1',
      'test-key',
      ENV,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:project-cloud-1',
        credentialVersion: 1787875200000,
      }
    );
    expect(providerDeleteVM).toHaveBeenCalledWith('vm-pool-1');
    expect(updateCalls).toContainEqual({ runtimeTerminationConfirmedAt: expect.any(String) });
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ status: 'deleted', healthStatus: 'stale' })
    );
    expect(finalizeWorkspaceLifecycleClosure).toHaveBeenCalledTimes(1);
  });

  it('stopNodeResources quarantines managed records and sanitizes provider deletion failure', async () => {
    nodeRows.push(managedPoolNode());
    providerDeleteVM.mockRejectedValueOnce(new Error('raw provider account detail'));

    await expect(stopNodeResources('pool-node-1', 'user-1', ENV)).rejects.toThrow(
      'Managed node teardown remains unconfirmed'
    );

    expect(updateCalls).toContainEqual(
      expect.objectContaining({
        status: 'stopping',
        errorMessage: expect.stringMatching(/^Workspace deletion unconfirmed:/),
      })
    );
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ status: 'destroying', healthStatus: 'stale' })
    );
    expect(updateCalls).not.toContainEqual(
      expect.objectContaining({ runtimeTerminationConfirmedAt: expect.any(String) })
    );
    expect(updateCalls).not.toContainEqual(expect.objectContaining({ status: 'deleted' }));
    expect(finalizeWorkspaceLifecycleClosure).not.toHaveBeenCalled();
  });

  it('deleteNodeResources deletes a pool-provisioned VM with its exact placement credential', async () => {
    nodeRows.push(managedPoolNode());

    const result = await deleteNodeResources('pool-node-1', 'user-1', ENV);

    expect(result.providerVmDeleted).toBe(true);
    expect(result.runtimeTerminationConfirmed).toBe(true);
    expect(createProviderForUser).toHaveBeenCalledWith(
      expect.anything(),
      'pool-owner-1',
      'test-key',
      ENV,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:project-cloud-1',
        credentialVersion: 1787875200000,
      }
    );
    expect(providerDeleteVM).toHaveBeenCalledWith('vm-pool-1');
    expect(updateCalls).toContainEqual({ runtimeTerminationConfirmedAt: expect.any(String) });
  });

  it('quarantines managed records when provider deletion fails', async () => {
    nodeRows.push(managedPoolNode());
    providerDeleteVM.mockRejectedValueOnce(new Error('provider delete timed out'));

    const result = await deleteNodeResources('pool-node-1', 'user-1', ENV);

    expect(result).toMatchObject({
      nodeFound: true,
      runtimeTerminationConfirmed: false,
      providerVmDeleted: false,
      errors: ['Managed runtime termination remains unconfirmed'],
    });
    expect(result.errors.join(' ')).not.toContain('provider delete timed out');
    expect(updateCalls).toContainEqual(
      expect.objectContaining({
        status: 'stopping',
        errorMessage: expect.stringMatching(/^Workspace deletion unconfirmed:/),
      })
    );
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ status: 'destroying', healthStatus: 'stale' })
    );
    expect(updateCalls).not.toContainEqual(
      expect.objectContaining({ runtimeTerminationConfirmedAt: expect.any(String) })
    );
    expect(updateCalls).not.toContainEqual(expect.objectContaining({ status: 'deleted' }));
    expect(finalizeWorkspaceLifecycleClosure).not.toHaveBeenCalled();
  });

  it('sanitizes managed container teardown errors returned by deleteNodeResources', async () => {
    nodeRows.push({
      ...managedPoolNode(),
      id: 'cf-container-1',
      runtime: 'cf-container',
      providerInstanceId: null,
      cloudProvider: 'cloudflare',
    });
    destroyVmAgentContainer.mockRejectedValueOnce(
      new Error('raw container infrastructure account detail')
    );

    const result = await deleteNodeResources('cf-container-1', 'user-1', ENV);

    expect(result).toMatchObject({
      runtimeTerminationConfirmed: false,
      errors: ['Managed runtime termination remains unconfirmed'],
    });
    expect(result.errors.join(' ')).not.toContain('infrastructure account detail');
    expect(finalizeWorkspaceLifecycleClosure).not.toHaveBeenCalled();
  });

  it('sanitizes DNS cleanup errors returned by deleteNodeResources', async () => {
    nodeRows.push(
      managedPoolNode({
        runtimeTerminationConfirmedAt: '2026-09-04T00:00:00.000Z',
        backendDnsRecordId: 'dns-sensitive',
      })
    );
    deleteDNSRecord.mockRejectedValueOnce(new Error('raw DNS provider account detail'));

    const result = await deleteNodeResources('pool-node-1', 'user-1', ENV);

    expect(result).toMatchObject({
      runtimeTerminationConfirmed: true,
      errors: ['Node DNS cleanup remains pending'],
    });
    expect(result.errors.join(' ')).not.toContain('DNS provider account detail');
  });

  it('uses an existing strict runtime marker without repeating provider teardown', async () => {
    nodeRows.push(managedPoolNode({ runtimeTerminationConfirmedAt: '2026-09-04T00:00:00.000Z' }));

    const result = await deleteNodeResources('pool-node-1', 'user-1', ENV);

    expect(result.runtimeTerminationConfirmed).toBe(true);
    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(updateCalls).toContainEqual(expect.objectContaining({ status: 'deleted' }));
    expect(finalizeWorkspaceLifecycleClosure).toHaveBeenCalledTimes(1);
  });

  it('rejects a direct delete when the node is reprovisioned after its initial read', async () => {
    nodeRows.push(managedPoolNode({ runtimeTerminationConfirmedAt: '2026-09-04T00:00:00.000Z' }));
    beforeSelectReturn = (call) => {
      if (call !== 2) return;
      nodeRows[0] = {
        ...(nodeRows[0] as Record<string, unknown>),
        providerInstanceId: 'vm-reprovisioned',
        runtimeIncarnationId: 'runtime-incarnation-reprovisioned',
        runtimeTerminationConfirmedAt: null,
      };
    };

    const result = await deleteNodeResources('pool-node-1', 'user-1', ENV);

    expect(result.runtimeTerminationConfirmed).toBe(false);
    expect(result.errors).toEqual(['Managed runtime termination remains unconfirmed']);
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(finalizeWorkspaceLifecycleClosure).not.toHaveBeenCalled();
  });

  it('deleteNodeResources does NOT destroy a container for a user-owned node', async () => {
    // BYO nodes are never cf-container; the explicit guard proves it (even if runtime leaked in).
    nodeRows.push(userOwnedNode({ runtime: 'cf-container' }));

    await deleteNodeResources('byo-1', 'user-1', ENV);

    expect(destroyVmAgentContainer).not.toHaveBeenCalled();
  });

  it('deleteNodeResourcesStrict requires managed container teardown to succeed', async () => {
    nodeRows.push({
      id: 'cf-strict',
      userId: 'user-1',
      name: 'strict cf node',
      status: 'destroying',
      nodeClass: 'managed',
      runtime: 'cf-container',
      providerInstanceId: null,
      cloudProvider: null,
      backendDnsRecordId: null,
      credentialAttributionUserId: null,
      credentialAttributionSource: 'user',
      credentialAttributionProjectId: null,
    });

    await expect(deleteNodeResourcesStrict('cf-strict', 'user-1', ENV)).resolves.toEqual({
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt: expect.any(String),
      runtimeIncarnationId: undefined,
      providerInstanceId: null,
    });
    expect(destroyVmAgentContainer).toHaveBeenCalledWith(ENV, 'cf-strict');
    expect(updateCalls).toContainEqual({
      runtimeTerminationConfirmedAt: expect.any(String),
    });

    nodeRows[0] = {
      ...(nodeRows[0] as Record<string, unknown>),
      runtimeTerminationConfirmedAt: null,
    };
    destroyVmAgentContainer.mockRejectedValueOnce(new Error('container teardown unavailable'));
    await expect(deleteNodeResourcesStrict('cf-strict', 'user-1', ENV)).rejects.toThrow(
      /container teardown unavailable/
    );
  });

  it('refuses no-instance proof for a managed VM that may still be provisioning', async () => {
    nodeRows.push(managedPoolNode({ status: 'creating', providerInstanceId: null }));

    await expect(deleteNodeResourcesStrict('pool-node-1', 'user-1', ENV)).rejects.toThrow(
      /instance identity is missing/
    );

    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([
      expect.objectContaining({ status: 'destroying', healthStatus: 'stale' }),
    ]);
  });

  it('does not write termination proof when provider deletion races a new VM incarnation', async () => {
    nodeRows.push(managedPoolNode());
    let releaseProviderDelete: (() => void) | undefined;
    providerDeleteVM.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseProviderDelete = resolve;
        })
    );

    const deletion = deleteNodeResourcesStrict('pool-node-1', 'user-1', ENV);
    await vi.waitFor(() => expect(providerDeleteVM).toHaveBeenCalledWith('vm-pool-1'));
    nodeRows[0] = {
      ...(nodeRows[0] as Record<string, unknown>),
      providerInstanceId: 'vm-reprovisioned',
      runtimeTerminationConfirmedAt: null,
    };
    releaseProviderDelete?.();

    await expect(deletion).rejects.toThrow(/lost its incarnation fence/);
    expect(updateCalls).not.toContainEqual(
      expect.objectContaining({ runtimeTerminationConfirmedAt: expect.any(String) })
    );
  });

  it('claims the managed node as destroying before provider I/O', async () => {
    nodeRows.push(managedPoolNode());
    providerDeleteVM.mockImplementationOnce(async () => {
      expect(nodeRows[0]).toMatchObject({ status: 'destroying', healthStatus: 'stale' });
    });

    await expect(deleteNodeResourcesStrict('pool-node-1', 'user-1', ENV)).resolves.toMatchObject({
      providerVm: 'deleted',
    });

    expect(updateCalls[0]).toMatchObject({ status: 'destroying', healthStatus: 'stale' });
    expect(providerDeleteVM).toHaveBeenCalledOnce();
  });

  it.each([
    ['user', 'userId', 'different-user'],
    ['runtime', 'runtime', 'cf-container'],
    ['provider', 'cloudProvider', 'scaleway'],
    ['credential attribution', 'credentialAttributionProjectId', 'different-project'],
    ['placement credential', 'placementCredentialReference', 'credentials:rotated'],
    ['placement version', 'placementCredentialVersion', 1787875200001],
  ])(
    'does not write termination proof when %s identity changes during provider I/O',
    async (_dimension, key, replacement) => {
      nodeRows.push(managedPoolNode());
      providerDeleteVM.mockImplementationOnce(async () => {
        nodeRows[0] = {
          ...(nodeRows[0] as Record<string, unknown>),
          [key]: replacement,
          runtimeTerminationConfirmedAt: null,
        };
      });

      await expect(deleteNodeResourcesStrict('pool-node-1', 'user-1', ENV)).rejects.toThrow(
        /lost its incarnation fence/
      );

      expect(updateCalls).not.toContainEqual(
        expect.objectContaining({ runtimeTerminationConfirmedAt: expect.any(String) })
      );
    }
  );

  it('deleteNodeResourcesStrict is a no-op for a user-owned node (nothing to delete, no throw)', async () => {
    nodeRows.push(
      userOwnedNode({ providerInstanceId: 'srv-should-not-touch', cloudProvider: 'hetzner' })
    );

    await expect(deleteNodeResourcesStrict('byo-1', 'user-1', ENV)).resolves.toEqual({
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt: null,
      runtimeIncarnationId: undefined,
      providerInstanceId: 'srv-should-not-touch',
    });
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });

  it('keeps legacy deleteNodeResources idempotent when the node row is missing', async () => {
    await expect(deleteNodeResources('missing-node', 'user-1', ENV)).resolves.toEqual({
      nodeFound: false,
      runtimeTerminationConfirmed: false,
      providerVmDeleted: false,
      providerVmDeleteSkippedReason: null,
      backendDnsDeleted: false,
      runtimeTerminationConfirmedAt: null,
      runtimeIncarnationId: null,
      errors: [],
    });
  });

  it('throws from strict deletion when the node row is missing', async () => {
    await expect(deleteNodeResourcesStrict('missing-node', 'user-1', ENV)).rejects.toThrow(
      /not found for strict deletion/
    );
  });

  it('retires deployment node records as tombstones so event history can keep its FK', async () => {
    const db = drizzle({} as never) as Parameters<typeof retireDeletedDeploymentNodeRecord>[0];

    await retireDeletedDeploymentNodeRecord(db, ENV, 'node-1', 'user-1', {
      runtimeTerminationConfirmedAt: '2026-09-04T00:00:00.000Z',
      runtimeIncarnationId: 'runtime-incarnation-1',
    });

    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: null,
          status: 'stopped',
          observedStatus: 'stopped',
        }),
        expect.objectContaining({
          status: 'deleted',
        }),
        expect.objectContaining({
          status: 'deleted',
          healthStatus: 'stale',
          providerInstanceId: null,
          backendDnsRecordId: null,
          ipAddress: null,
        }),
      ])
    );
    expect(finalizeWorkspaceLifecycleClosure).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({
        nodeId: 'node-1',
        userId: 'user-1',
        agentSessionStatus: 'completed',
        reason: 'retire_deleted_deployment_node_record',
      })
    );
  });

  it('fails closed when a legacy node lacks an exact provider-account binding', async () => {
    nodeRows.push(
      managedPoolNode({
        id: 'legacy-node',
        status: 'destroying',
        capacityPoolId: null,
        placementCredentialSource: null,
        placementCredentialReference: null,
        placementCredentialVersion: null,
      })
    );

    await expect(deleteNodeResourcesStrict('legacy-node', 'user-1', ENV)).rejects.toThrow(
      /exact provider credential binding is missing/
    );

    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(providerGetVM).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });

  it('does not use a rotated current account even when its instance ID collides', async () => {
    nodeRows.push(
      managedPoolNode({
        id: 'legacy-collision',
        status: 'destroying',
        capacityPoolId: null,
        placementCredentialSource: null,
        placementCredentialReference: null,
        placementCredentialVersion: null,
      })
    );
    providerGetVM.mockResolvedValueOnce({ id: 'vm-pool-1' });

    await expect(deleteNodeResourcesStrict('legacy-collision', 'user-1', ENV)).rejects.toThrow(
      /exact provider credential binding is missing/
    );

    expect(createProviderForUser).not.toHaveBeenCalled();
    expect(providerGetVM).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
  });

  it('fails closed when strict deletion credentials are missing', async () => {
    nodeRows.push(managedPoolNode({ id: 'node-1', status: 'destroying' }));
    createProviderForUser.mockResolvedValueOnce(null);

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).rejects.toThrow(
      /credentials missing/
    );

    expect(providerGetVM).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it('fails closed when exact-account provider deletion fails', async () => {
    nodeRows.push(managedPoolNode({ id: 'node-1', status: 'destroying' }));
    providerDeleteVM.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).rejects.toThrow(
      /provider unavailable/
    );

    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it('does not fail strict compute deletion when DNS cleanup fails after VM deletion', async () => {
    nodeRows.push(
      managedPoolNode({ id: 'node-1', status: 'destroying', backendDnsRecordId: 'dns-1' })
    );
    deleteDNSRecord.mockRejectedValueOnce(new Error('Cloudflare DNS outage'));

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).resolves.toMatchObject({
      providerVm: 'deleted',
    });

    expect(providerDeleteVM).toHaveBeenCalledWith('vm-pool-1');
    expect(deleteDNSRecord).toHaveBeenCalledWith('dns-1', ENV);
    expect(updateCalls).toContainEqual({
      runtimeTerminationConfirmedAt: expect.any(String),
    });
    expect(persistError).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        source: 'api',
        level: 'error',
        nodeId: 'node-1',
        userId: 'user-1',
      }),
      expect.anything()
    );
  });

  it('deleteNodeResourcesStrict deletes a pool-provisioned VM with its exact placement credential', async () => {
    nodeRows.push(managedPoolNode({ status: 'destroying', backendDnsRecordId: 'dns-pool-1' }));

    await expect(deleteNodeResourcesStrict('pool-node-1', 'user-1', ENV)).resolves.toMatchObject({
      providerVm: 'deleted',
    });

    expect(createProviderForUser).toHaveBeenCalledWith(
      expect.anything(),
      'pool-owner-1',
      'test-key',
      ENV,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:project-cloud-1',
        credentialVersion: 1787875200000,
      }
    );
    expect(providerDeleteVM).toHaveBeenCalledWith('vm-pool-1');
    expect(deleteDNSRecord).toHaveBeenCalledWith('dns-pool-1', ENV);
  });
});
