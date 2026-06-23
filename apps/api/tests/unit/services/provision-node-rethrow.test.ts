import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionNode } from '../../../src/services/nodes';

// Records the write operations the drizzle mock receives so tests can assert
// whether the failed node row was DELETED (capacity) or UPDATEd to status:'error'
// (non-capacity / legacy).
interface RecordedOp {
  kind: 'update' | 'delete';
  set?: Record<string, unknown>;
}
const ops: RecordedOp[] = [];
const nodeRows: unknown[] = [];

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
      set: (val: Record<string, unknown>) => ({
        where: () => {
          ops.push({ kind: 'update', set: val });
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: () => {
        ops.push({ kind: 'delete' });
        return Promise.resolve();
      },
    }),
  }),
}));

const createVM = vi.fn();
const createProviderForUser = vi.fn();
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: (...args: unknown[]) => createProviderForUser(...args),
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-key',
}));

vi.mock('../../../src/services/jwt', () => ({
  signNodeCallbackToken: vi.fn().mockResolvedValue('callback-token'),
}));

vi.mock('@simple-agent-manager/cloud-init', () => ({
  generateCloudInit: () => 'cloud-init-yaml',
  validateCloudInitSize: () => true,
}));

const createNodeBackendDNSRecord = vi.fn();
vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: (...args: unknown[]) => createNodeBackendDNSRecord(...args),
  deleteDNSRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

function capacityError(): ProviderError {
  return new ProviderError('hetzner', 503, 'No large capacity', {
    providerCode: 'resource_unavailable',
    category: 'transient_capacity',
  });
}

function invalidConfigError(): ProviderError {
  return new ProviderError('hetzner', 400, 'Bad VM config', {
    providerCode: 'invalid_input',
    category: 'invalid_config',
  });
}

const ENV = {
  DATABASE: {},
  OBSERVABILITY_DATABASE: {},
  BASE_DOMAIN: 'example.com',
} as unknown as Parameters<typeof provisionNode>[1];

beforeEach(() => {
  ops.length = 0;
  nodeRows.length = 0;
  vi.clearAllMocks();
  nodeRows.push({
    id: 'node-1',
    userId: 'user-1',
    vmSize: 'large',
    vmLocation: 'fsn1',
    cloudProvider: 'hetzner',
  });
  createProviderForUser.mockResolvedValue({
    provider: { createVM },
    credentialSource: 'user',
  });
  createVM.mockResolvedValue({ id: 'provider-vm-1', ip: '203.0.113.10' });
  createNodeBackendDNSRecord.mockResolvedValue('dns-record-id');
});

describe('provisionNode backend DNS records', () => {
  it('creates and stores a backend DNS record for deployment nodes with a VM IP', async () => {
    await provisionNode(
      'node-1',
      ENV,
      undefined,
      undefined,
      { environmentId: 'env-1' },
    );

    expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', '203.0.113.10', ENV);
    expect(ops).toContainEqual(expect.objectContaining({
      kind: 'update',
      set: expect.objectContaining({
        providerInstanceId: 'provider-vm-1',
        ipAddress: '203.0.113.10',
        backendDnsRecordId: 'dns-record-id',
        status: 'running',
      }),
    }));
  });

  it('keeps existing workspace-node backend DNS behavior intact', async () => {
    await provisionNode('node-1', ENV);

    expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', '203.0.113.10', ENV);
    expect(ops).toContainEqual(expect.objectContaining({
      kind: 'update',
      set: expect.objectContaining({
        backendDnsRecordId: 'dns-record-id',
        status: 'running',
      }),
    }));
  });

  it('records explicit node state when backend DNS creation fails', async () => {
    createNodeBackendDNSRecord.mockRejectedValue(new Error('Cloudflare DNS unavailable'));

    await expect(
      provisionNode(
        'node-1',
        ENV,
        undefined,
        undefined,
        { environmentId: 'env-1' },
      )
    ).resolves.toBeUndefined();

    expect(ops).toContainEqual(expect.objectContaining({
      kind: 'update',
      set: expect.objectContaining({
        providerInstanceId: 'provider-vm-1',
        ipAddress: '203.0.113.10',
        backendDnsRecordId: null,
        status: 'error',
        healthStatus: 'unhealthy',
        errorMessage: expect.stringContaining('Backend DNS record creation failed'),
      }),
    }));
  });
});

describe('provisionNode rethrowProviderError', () => {
  it('deletes the failed node row and re-throws on transient capacity exhaustion', async () => {
    const err = capacityError();
    createVM.mockRejectedValue(err);

    await expect(
      provisionNode('node-1', ENV, undefined, { rethrowProviderError: true })
    ).rejects.toBe(err);

    // Failed capacity attempt must leave NO orphaned error row — the row is deleted.
    expect(ops.some((o) => o.kind === 'delete')).toBe(true);
    expect(ops.some((o) => o.kind === 'update' && o.set?.status === 'error')).toBe(false);
  });

  it('preserves the ProviderError category and providerCode when re-throwing capacity errors', async () => {
    const err = capacityError();
    createVM.mockRejectedValue(err);

    const thrown = await provisionNode('node-1', ENV, undefined, {
      rethrowProviderError: true,
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(isTransientCapacityError(thrown)).toBe(true);
    expect((thrown as ProviderError).providerCode).toBe('resource_unavailable');
  });

  it('records status:error and re-throws on a non-capacity provider error', async () => {
    const err = invalidConfigError();
    createVM.mockRejectedValue(err);

    await expect(
      provisionNode('node-1', ENV, undefined, { rethrowProviderError: true })
    ).rejects.toBe(err);

    // Non-capacity failures keep the row, marked error, for surfacing to the user.
    expect(ops.some((o) => o.kind === 'delete')).toBe(false);
    expect(ops.some((o) => o.kind === 'update' && o.set?.status === 'error')).toBe(true);
  });

  it('legacy mode swallows the error and records status:error without throwing', async () => {
    const err = capacityError();
    createVM.mockRejectedValue(err);

    await expect(provisionNode('node-1', ENV)).resolves.toBeUndefined();

    // Without the rethrow option, even capacity failures are swallowed and recorded.
    expect(ops.some((o) => o.kind === 'delete')).toBe(false);
    expect(ops.some((o) => o.kind === 'update' && o.set?.status === 'error')).toBe(true);
  });
});
