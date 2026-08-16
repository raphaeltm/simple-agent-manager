import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionNode } from '../../../src/services/nodes';

const { logError, persistError } = vi.hoisted(() => ({
  logError: vi.fn(),
  persistError: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  serializeError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }),
}));

// Records the write operations the drizzle mock receives so tests can assert
// whether the failed node row was DELETED (capacity) or UPDATEd to status:'error'
// (non-capacity / legacy).
interface RecordedOp {
  kind: 'update' | 'delete';
  set?: Record<string, unknown>;
}
const ops: RecordedOp[] = [];
const nodeRows: unknown[] = [];
let updateBarrier: Promise<void> | undefined;

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
          return updateBarrier ?? Promise.resolve();
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

const generateCloudInit = vi.fn(() => 'cloud-init-yaml');
vi.mock('@simple-agent-manager/cloud-init', () => ({
  generateCloudInit: (...args: unknown[]) => generateCloudInit(...args),
  validateCloudInitSize: () => true,
}));

const createNodeBackendDNSRecord = vi.fn();
vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: (...args: unknown[]) => createNodeBackendDNSRecord(...args),
  deleteDNSRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => persistError(...args),
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
  ENVIRONMENT: 'production',
  SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
  ERROR_REPORT_RESPONSE_MAX_BYTES: '2048',
  ERROR_REPORT_STORED_ERROR_MAX_BYTES: '256',
  ERROR_REPORT_COLLECTOR_CONCURRENCY: '2',
  SESSION_SNAPSHOT_OPERATION_TIMEOUT: '12m30s',
  SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL: '3s',
  SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT: '750ms',
} as unknown as Parameters<typeof provisionNode>[1];

beforeEach(() => {
  ops.length = 0;
  nodeRows.length = 0;
  updateBarrier = undefined;
  vi.clearAllMocks();
  nodeRows.push({
    id: 'node-1',
    userId: 'user-1',
    name: 'workspace-node',
    status: 'pending',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    vmSize: 'large',
    vmLocation: 'fsn1',
    cloudProvider: 'hetzner',
  });
  createProviderForUser.mockResolvedValue({
    provider: { createVM },
    providerName: 'hetzner',
    credentialSource: 'user',
  });
  createVM.mockResolvedValue({
    id: 'provider-vm-1',
    name: 'workspace-node',
    ip: '203.0.113.10',
    status: 'running',
    serverType: 'cx22',
    createdAt: '2026-08-12T00:00:00.000Z',
    labels: {},
  });
  createNodeBackendDNSRecord.mockResolvedValue('dns-record-id');
});

describe('provisionNode backend DNS records', () => {
  it('propagates exact installation ownership to the provider create boundary', async () => {
    await provisionNode('node-1', ENV);

    expect(createVM).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: {
          node: 'node-1',
          managed: 'simple-agent-manager',
          role: 'workspace',
          env: 'production',
          installation: '0123456789abcdef0123456789abcdef',
        },
      }),
    );
  });

  it('keeps provisioning compatible but omits ownership when identity is unavailable', async () => {
    await provisionNode('node-1', { ...ENV, SAM_INSTALLATION_ID: undefined });

    expect(createVM).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.not.objectContaining({ installation: expect.anything() }),
      }),
    );
  });

  it('passes configurable reporter bounds into generated cloud-init', async () => {
    await provisionNode('node-1', ENV);

    expect(generateCloudInit).toHaveBeenCalledWith(
      expect.objectContaining({
        errorReportResponseMaxBytes: '2048',
        errorReportStoredErrorMaxBytes: '256',
        errorReportCollectorConcurrency: '2',
        sessionSnapshotOperationTimeout: '12m30s',
        sessionSnapshotProgressReportInterval: '3s',
        sessionSnapshotProgressReportTimeout: '750ms',
      })
    );
  });

  it('creates and stores a backend DNS record for deployment nodes with a VM IP', async () => {
    await provisionNode('node-1', ENV, undefined, undefined, { environmentId: 'env-1' });

    expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', '203.0.113.10', ENV);
    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        set: expect.objectContaining({
          providerInstanceId: 'provider-vm-1',
          ipAddress: '203.0.113.10',
          backendDnsRecordId: 'dns-record-id',
          status: 'running',
        }),
      })
    );
  });

  it('keeps existing workspace-node backend DNS behavior intact', async () => {
    await provisionNode('node-1', ENV);

    expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', '203.0.113.10', ENV);
    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        set: expect.objectContaining({
          backendDnsRecordId: 'dns-record-id',
          status: 'running',
        }),
      })
    );
  });

  it('uses project-pinned compute attribution when resolving the provider', async () => {
    nodeRows.length = 0;
    nodeRows.push({
      id: 'node-project',
      userId: 'member-b',
      credentialAttributionUserId: 'member-a',
      credentialAttributionProjectId: 'project-1',
      credentialAttributionSource: 'project',
      vmSize: 'large',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
    });
    createProviderForUser.mockResolvedValueOnce({
      provider: { createVM },
      providerName: 'hetzner',
      credentialSource: 'project',
    });

    await provisionNode('node-project', ENV);

    expect(createProviderForUser).toHaveBeenCalledWith(
      expect.anything(),
      'member-a',
      'test-key',
      ENV,
      'hetzner',
      'project-1'
    );
    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        set: expect.objectContaining({
          credentialSource: 'project',
          credentialAttributionUserId: 'member-a',
          credentialAttributionProjectId: 'project-1',
          credentialAttributionSource: 'project',
        }),
      })
    );
  });

  it('records explicit node state when backend DNS creation fails', async () => {
    createNodeBackendDNSRecord.mockRejectedValue(new Error('Cloudflare DNS unavailable'));

    await expect(
      provisionNode('node-1', ENV, undefined, undefined, { environmentId: 'env-1' })
    ).resolves.toBeUndefined();

    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        set: expect.objectContaining({
          providerInstanceId: 'provider-vm-1',
          ipAddress: '203.0.113.10',
          backendDnsRecordId: null,
          status: 'error',
          healthStatus: 'unhealthy',
          errorMessage: expect.stringContaining('Backend DNS record creation failed'),
        }),
      })
    );
  });
});

describe('provisionNode rethrowProviderError', () => {
  it('forwards optional cancellation and performs no D1, DNS, or observability work after abort', async () => {
    nodeRows.length = 0;
    nodeRows.push({
      id: 'node-1',
      userId: 'user-1',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      credentialSource: 'user',
      name: 'Cancellation capability node',
      status: 'creating',
      vmSize: 'large',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      providerInstanceId: null,
      runtime: 'vm',
      nodeRole: 'workspace',
      nodeMode: 'shared',
      heartbeatStaleAfterSeconds: 120,
      healthStatus: 'stale',
      ipAddress: null,
      backendDnsRecordId: null,
      errorMessage: null,
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    });
    const controller = new AbortController();
    const callerReason = new ProviderError('hetzner', 409, 'caller cancelled provisioning');
    let receivedSignal: AbortSignal | undefined;
    let operationCountAtAbort = -1;
    createVM.mockImplementationOnce(
      async (_config: unknown, context?: { signal?: AbortSignal }) => {
        receivedSignal = context?.signal;
        operationCountAtAbort = ops.length;
        controller.abort(callerReason);
        throw callerReason;
      }
    );

    await expect(
      provisionNode('node-1', ENV, undefined, { signal: controller.signal })
    ).rejects.toBe(callerReason);

    expect(receivedSignal).toBe(controller.signal);
    expect(operationCountAtAbort).toBeGreaterThanOrEqual(0);
    expect(ops.slice(operationCountAtAbort)).toEqual([]);
    expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
    expect(persistError).not.toHaveBeenCalled();
  });

  it('preserves cancellation during DNS creation and performs no later bookkeeping', async () => {
    const controller = new AbortController();
    const callerReason = new ProviderError('hetzner', 404, 'caller cancelled pending DNS');
    let releaseDns: () => void = () => undefined;
    const dnsStarted = new Promise<void>((resolveStarted) => {
      createNodeBackendDNSRecord.mockImplementationOnce(async () => {
        resolveStarted();
        return await new Promise<string>((resolve) => {
          releaseDns = () => resolve('dns-record-id');
        });
      });
    });

    const provisioning = provisionNode('node-1', ENV, undefined, {
      signal: controller.signal,
    });
    await dnsStarted;
    const operationCountAtAbort = ops.length;
    controller.abort(callerReason);
    releaseDns();

    await expect(provisioning).rejects.toBe(callerReason);
    expect(ops.slice(operationCountAtAbort)).toEqual([]);
    expect(persistError).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalledWith(
      'node_provisioning.dns_record_failed',
      expect.anything()
    );
    expect(logError).not.toHaveBeenCalledWith('node_provisioning.failed', expect.anything());
  });

  it.each([
    [
      'terminal running-node write',
      '203.0.113.10',
      { status: 'running', ipAddress: '203.0.113.10' },
    ],
    [
      'terminal awaiting-IP write',
      '',
      { status: 'creating', errorMessage: 'Awaiting IP allocation — will be set on first heartbeat' },
    ],
  ])('preserves cancellation during the %s', async (_boundary, vmIp, expectedTerminalSet) => {
    const controller = new AbortController();
    const callerReason = new ProviderError('hetzner', 503, `caller cancelled ${_boundary}`);
    let releaseUpdate: () => void = () => undefined;
    createVM.mockImplementationOnce(async () => {
      updateBarrier = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      return { id: 'provider-vm-1', ip: vmIp };
    });

    const provisioning = provisionNode('node-1', ENV, undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(ops).toHaveLength(2));
    expect(createVM).toHaveBeenCalledTimes(1);
    expect(ops[1]).toEqual({
      kind: 'update',
      set: expect.objectContaining(expectedTerminalSet),
    });
    const operationCountAtAbort = ops.length;
    controller.abort(callerReason);
    releaseUpdate();

    await expect(provisioning).rejects.toBe(callerReason);
    expect(ops.slice(operationCountAtAbort)).toEqual([]);
    expect(persistError).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalledWith('node_provisioning.failed', expect.anything());
  });

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
