import { beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRows: unknown[] = [];
const updateCalls: Array<Record<string, unknown>> = [];

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => Promise.resolve(nodeRows),
      };
      return builder;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updateCalls.push(values);
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

const providerDeleteVM = vi.fn(async () => {});
const providerGetVM = vi.fn(async () => ({ id: 'vm-1' }));
const scalewayDeleteVM = vi.fn(async () => {});
const scalewayGetVM = vi.fn(async () => null);
const createProviderForUser = vi.fn();
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: (...args: unknown[]) => createProviderForUser(...args),
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-key',
}));

const deleteDNSRecord = vi.fn(async () => {});
vi.mock('../../../src/services/dns', () => ({
  deleteDNSRecord: (...args: unknown[]) => deleteDNSRecord(...args),
  createNodeBackendDNSRecord: vi.fn(),
}));

const persistError = vi.fn(async () => {});
vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => persistError(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  })),
}));

const { deleteNodeResources, deleteNodeResourcesStrict, retireDeletedDeploymentNodeRecord } =
  await import('../../../src/services/nodes');
const { drizzle } = await import('drizzle-orm/d1');

const ENV = {
  DATABASE: {},
} as unknown as Parameters<typeof deleteNodeResources>[2];

describe('node resource deletion services', () => {
  beforeEach(() => {
    nodeRows.length = 0;
    updateCalls.length = 0;
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

  it('keeps legacy deleteNodeResources idempotent when the node row is missing', async () => {
    await expect(deleteNodeResources('missing-node', 'user-1', ENV)).resolves.toEqual({
      nodeFound: false,
      providerVmDeleted: false,
      providerVmDeleteSkippedReason: null,
      backendDnsDeleted: false,
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

    await retireDeletedDeploymentNodeRecord(db, 'node-1', 'user-1');

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
  });

  it('finalizes strict cleanup when a credentialed legacy-provider lookup conclusively returns null', async () => {
    nodeRows.push({
      id: 'node-absent',
      userId: 'user-1',
      providerInstanceId: 'vm-absent',
      cloudProvider: null,
      backendDnsRecordId: 'dns-absent',
    });
    providerGetVM.mockResolvedValueOnce(null);

    await expect(deleteNodeResourcesStrict('node-absent', 'user-1', ENV)).resolves.toEqual({
      providerVm: 'already-absent',
    });

    expect(providerGetVM).toHaveBeenCalledWith('vm-absent');
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).toHaveBeenCalledWith('dns-absent', ENV);
    expect(updateCalls).toEqual([]);
  });

  it('checks every credentialed provider before selecting the only provider that contains a legacy VM', async () => {
    nodeRows.push({
      id: 'node-present',
      userId: 'user-1',
      providerInstanceId: 'vm-shared-id',
      cloudProvider: null,
      backendDnsRecordId: 'dns-present',
    });
    providerGetVM.mockResolvedValueOnce(null);
    scalewayGetVM.mockResolvedValueOnce({ id: 'vm-shared-id' });
    createProviderForUser.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'hetzner') {
        return {
          provider: { deleteVM: providerDeleteVM, getVM: providerGetVM },
          providerName: 'hetzner',
          credentialSource: 'platform',
        };
      }
      if (args[4] === 'scaleway') {
        return {
          provider: { deleteVM: scalewayDeleteVM, getVM: scalewayGetVM },
          providerName: 'scaleway',
          credentialSource: 'user',
        };
      }
      return null;
    });

    await expect(deleteNodeResourcesStrict('node-present', 'user-1', ENV)).resolves.toEqual({
      providerVm: 'deleted',
    });

    expect(providerGetVM).toHaveBeenCalledWith('vm-shared-id');
    expect(scalewayGetVM).toHaveBeenCalledWith('vm-shared-id');
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(scalewayDeleteVM).toHaveBeenCalledWith('vm-shared-id');
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ cloudProvider: 'scaleway', credentialSource: 'user' })
    );
  });

  it('fails closed when a legacy instance ID matches multiple credentialed providers', async () => {
    nodeRows.push({
      id: 'node-ambiguous',
      userId: 'user-1',
      providerInstanceId: 'vm-shared-id',
      cloudProvider: null,
      backendDnsRecordId: 'dns-ambiguous',
    });
    providerGetVM.mockResolvedValueOnce({ id: 'vm-shared-id' });
    scalewayGetVM.mockResolvedValueOnce({ id: 'vm-shared-id' });
    createProviderForUser.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'hetzner') {
        return {
          provider: { deleteVM: providerDeleteVM, getVM: providerGetVM },
          providerName: 'hetzner',
          credentialSource: 'platform',
        };
      }
      if (args[4] === 'scaleway') {
        return {
          provider: { deleteVM: scalewayDeleteVM, getVM: scalewayGetVM },
          providerName: 'scaleway',
          credentialSource: 'user',
        };
      }
      return null;
    });

    await expect(deleteNodeResourcesStrict('node-ambiguous', 'user-1', ENV)).rejects.toThrow(
      /matched multiple providers/
    );

    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(scalewayDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });

  it('fails closed when strict deletion credentials are missing', async () => {
    nodeRows.push({
      id: 'node-1',
      userId: 'user-1',
      providerInstanceId: 'vm-1',
      cloudProvider: null,
    });
    createProviderForUser.mockResolvedValueOnce(null);

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).rejects.toThrow(
      /credentials missing/
    );

    expect(providerGetVM).not.toHaveBeenCalled();
    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it.each([
    [
      'lookup failure',
      () => providerGetVM.mockRejectedValueOnce(new Error('provider unavailable')),
      /provider unavailable/,
    ],
    [
      'ambiguous lookup',
      () => providerGetVM.mockResolvedValueOnce(undefined),
      /ambiguous hetzner lookup result/,
    ],
  ])('fails closed for %s', async (_scenario, arrange, expected) => {
    nodeRows.push({
      id: 'node-1',
      userId: 'user-1',
      providerInstanceId: 'vm-1',
      cloudProvider: null,
    });
    arrange();

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).rejects.toThrow(expected);

    expect(providerDeleteVM).not.toHaveBeenCalled();
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it('does not fail strict compute deletion when DNS cleanup fails after VM deletion', async () => {
    nodeRows.push({
      id: 'node-1',
      userId: 'user-1',
      providerInstanceId: 'vm-1',
      cloudProvider: 'hetzner',
      backendDnsRecordId: 'dns-1',
    });
    deleteDNSRecord.mockRejectedValueOnce(new Error('Cloudflare DNS outage'));

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).resolves.toEqual({
      providerVm: 'deleted',
    });

    expect(providerDeleteVM).toHaveBeenCalledWith('vm-1');
    expect(deleteDNSRecord).toHaveBeenCalledWith('dns-1', ENV);
    expect(updateCalls).toContainEqual(
      expect.objectContaining({
        cloudProvider: 'hetzner',
        credentialSource: 'platform',
      })
    );
    expect(persistError).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        source: 'api',
        level: 'error',
        nodeId: 'node-1',
        userId: 'user-1',
      })
    );
  });
});
