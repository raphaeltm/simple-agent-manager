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

const { deleteNodeResources, deleteNodeResourcesStrict } = await import('../../../src/services/nodes');

const ENV = {
  DATABASE: {},
} as unknown as Parameters<typeof deleteNodeResources>[2];

describe('node resource deletion services', () => {
  beforeEach(() => {
    nodeRows.length = 0;
    updateCalls.length = 0;
    vi.clearAllMocks();
    createProviderForUser.mockResolvedValue({
      provider: {
        deleteVM: providerDeleteVM,
        getVM: providerGetVM,
      },
      providerName: 'hetzner',
      credentialSource: 'platform',
    });
  });

  it('keeps legacy deleteNodeResources idempotent when the node row is missing', async () => {
    await expect(deleteNodeResources('missing-node', 'user-1', ENV)).resolves.toBeUndefined();
  });

  it('throws from strict deletion when the node row is missing', async () => {
    await expect(
      deleteNodeResourcesStrict('missing-node', 'user-1', ENV)
    ).rejects.toThrow(/not found for strict deletion/);
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

    await expect(deleteNodeResourcesStrict('node-1', 'user-1', ENV)).resolves.toBeUndefined();

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
