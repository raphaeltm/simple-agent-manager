import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionNode } from '../../../src/services/nodes';

const { logError, logInfo, persistError, deleteNodeResourcesStrict } = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  persistError: vi.fn(),
  deleteNodeResourcesStrict: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { error: logError, info: logInfo, warn: vi.fn(), debug: vi.fn() },
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
let nextWriteChanges: number[] = [];

function d1Result(changes = 1) {
  return { meta: { changes } };
}

function writeResultFor(val?: Record<string, unknown>) {
  const result = d1Result(nextWriteChanges.shift() ?? 1);
  const run = () => {
    const waitsForTerminalBoundary =
      !!val && 'status' in val && 'providerInstanceId' in val && updateBarrier;
    return waitsForTerminalBoundary ? updateBarrier.then(() => result) : Promise.resolve(result);
  };
  return {
    run,
    then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
      run().then(resolve, reject),
  };
}

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
          return writeResultFor(val);
        },
      }),
    }),
    delete: () => ({
      where: () => {
        ops.push({ kind: 'delete' });
        return writeResultFor();
      },
    }),
  }),
}));

const createVM = vi.fn();
const deleteVM = vi.fn();
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
      !snapshot.capacityPoolId ||
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

vi.mock('../../../src/services/strict-node-deletion', () => ({
  deleteNodeResourcesStrict: (...args: unknown[]) => deleteNodeResourcesStrict(...args),
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
  DATABASE: {
    prepare: (query: string) => ({
      bind: (..._params: unknown[]) => ({
        first: async () => {
          if (query.includes('SELECT 1 AS ok')) return { ok: 1 };
          return nodeRowForAuthorityGuard(nodeRows[0]);
        },
      }),
    }),
  },
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

function observedHardware() {
  return {
    serverType: { source: 'observed' as const, value: 'cx22' },
    resources: {
      source: 'observed' as const,
      value: { vcpuCount: 2, memoryMb: 4096, diskGb: 80 },
    },
  };
}

function vmResult(ip: string | null = '203.0.113.10') {
  return {
    id: 'provider-vm-1',
    name: 'workspace-node',
    ip,
    status: 'running',
    serverType: 'cx22',
    createdAt: '2026-08-12T00:00:00.000Z',
    labels: {},
    observedHardware: observedHardware(),
  };
}

function nodeRowForAuthorityGuard(row: unknown) {
  if (!row || typeof row !== 'object') return null;
  const value = row as Record<string, unknown>;
  return {
    id: value.id,
    user_id: value.userId,
    status: value.status,
    runtime: value.runtime ?? 'vm',
    node_class: value.nodeClass ?? 'managed',
    node_role: value.nodeRole ?? 'workspace',
    workload_role: value.workloadRole ?? 'workspace',
    cloud_provider: value.cloudProvider ?? null,
    vm_location: value.vmLocation ?? null,
    capacity_pool_id: value.capacityPoolId ?? null,
    capacity_pool_scope: value.capacityPoolScope ?? null,
    capacity_pool_revision: value.capacityPoolRevision ?? null,
    capacity_source_id: value.capacitySourceId ?? null,
    capacity_source_generation: value.capacitySourceGeneration ?? null,
    capacity_source_external_ref: value.capacitySourceExternalRef ?? null,
    capacity_pool_candidate_id: value.capacityPoolCandidateId ?? null,
    capacity_pool_project_id: value.capacityPoolProjectId ?? null,
    placement_credential_source: value.placementCredentialSource ?? null,
    placement_credential_reference: value.placementCredentialReference ?? null,
    placement_credential_version: value.placementCredentialVersion ?? null,
    selection_settings_version: value.selectionSettingsVersion ?? null,
    capacity_authority_generation: value.capacityAuthorityGeneration ?? null,
    pool_revision: value.capacityPoolRevision ?? null,
    source_authority_generation: value.capacitySourceGeneration ?? null,
    candidate_authority_generation: value.candidateAuthorityGeneration ?? null,
    provider_instance_type: value.providerInstanceType ?? null,
    provider_instance_vcpu_count: value.providerInstanceVcpuCount ?? null,
    provider_instance_memory_mb: value.providerInstanceMemoryMb ?? null,
    provider_instance_disk_gb: value.providerInstanceDiskGb ?? null,
    provider_instance_boot_disk_size_gb: value.providerInstanceBootDiskSizeGb ?? null,
    provider_instance_image: value.providerInstanceImage ?? null,
    provider_instance_architecture: value.providerInstanceArchitecture ?? null,
    provider_instance_price_display: value.providerInstancePriceDisplay ?? null,
    provider_instance_price_currency: value.providerInstancePriceCurrency ?? null,
    provider_instance_price_monthly_cents: value.providerInstancePriceMonthlyCents ?? null,
    provider_instance_price_hourly_micros: value.providerInstancePriceHourlyMicros ?? null,
    placement_explanation_json: value.placementExplanationJson ?? null,
  };
}

beforeEach(() => {
  ops.length = 0;
  nodeRows.length = 0;
  updateBarrier = undefined;
  nextWriteChanges = [];
  vi.clearAllMocks();
  nodeRows.push({
    id: 'node-1',
    userId: 'user-1',
    name: 'workspace-node',
    status: 'creating',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    runtime: 'vm',
    runtimeIncarnationId: 'runtime-1',
    vmSize: 'large',
    vmLocation: 'fsn1',
    cloudProvider: 'hetzner',
    providerInstanceId: null,
  });
  createProviderForUser.mockResolvedValue({
    provider: { createVM, deleteVM },
    providerName: 'hetzner',
    credentialSource: 'user',
  });
  createVM.mockResolvedValue(vmResult());
  deleteVM.mockResolvedValue(undefined);
  deleteNodeResourcesStrict.mockResolvedValue({
    providerVm: 'deleted',
    runtimeTerminationConfirmedAt: new Date().toISOString(),
    runtimeIncarnationId: 'runtime-2',
    providerInstanceId: 'provider-vm-1',
  });
  createNodeBackendDNSRecord.mockResolvedValue('dns-record-id');
});

describe('provisionNode backend DNS records', () => {
  it.each([null, ''])(
    'retains provider identity and waits for IP backfill without creating DNS (%s)',
    async (ip) => {
      createVM.mockResolvedValueOnce(vmResult(ip));

      await expect(provisionNode('node-1', ENV)).resolves.toEqual({ allocationConfirmed: true });

      expect(createVM).toHaveBeenCalledOnce();
      expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
      expect(ops.at(-1)).toEqual({
        kind: 'update',
        set: expect.objectContaining({
          providerInstanceId: 'provider-vm-1',
          cloudProvider: 'hetzner',
          status: 'creating',
          errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
        }),
      });
      expect(ops.some((op) => op.set?.status === 'running')).toBe(false);
      expect(logInfo).toHaveBeenCalledWith(
        'node_provisioning.awaiting_ip_backfill',
        expect.objectContaining({
          nodeId: 'node-1',
          providerInstanceId: 'provider-vm-1',
        })
      );
    }
  );

  it('forwards task context into cloud-init and sends that generated payload to the provider', async () => {
    const taskContext = {
      projectId: 'project-context',
      chatSessionId: 'chat-context',
      taskId: 'task-context',
      taskMode: 'task' as const,
    };
    await provisionNode('node-1', ENV, taskContext);

    expect(generateCloudInit).toHaveBeenCalledWith(expect.objectContaining(taskContext));
    expect(createVM).toHaveBeenCalledWith(expect.objectContaining({ userData: 'cloud-init-yaml' }));
  });

  it.each([false, true])(
    'passes the deploy signing key only for deployment context (%s)',
    async (deployment) => {
      const env = { ...ENV, DEPLOY_SIGNING_PUBLIC_KEY: 'test-public-deployment-key' };
      await provisionNode(
        'node-1',
        env,
        undefined,
        undefined,
        deployment ? { environmentId: 'environment-1' } : undefined
      );

      expect(generateCloudInit).toHaveBeenCalledWith(
        expect.objectContaining({
          deploySigningPubKey: deployment ? 'test-public-deployment-key' : undefined,
          role: deployment ? 'deployment' : undefined,
          environmentId: deployment ? 'environment-1' : undefined,
        })
      );
    }
  );

  it('clears stale termination proof and records provider ownership before paid allocation', async () => {
    Object.assign(nodeRows[0] as Record<string, unknown>, {
      runtimeTerminationConfirmedAt: '2026-08-01T00:00:00.000Z',
    });
    let writesAtAllocation: RecordedOp[] = [];
    createVM.mockImplementationOnce(async () => {
      writesAtAllocation = structuredClone(ops);
      return vmResult();
    });

    await provisionNode('node-1', ENV);

    expect(writesAtAllocation).toContainEqual({
      kind: 'update',
      set: expect.objectContaining({
        cloudProvider: 'hetzner',
        credentialSource: 'user',
        runtimeTerminationConfirmedAt: null,
        runtimeIncarnationId: expect.any(String),
      }),
    });
    const claim = writesAtAllocation.find((op) => op.set?.runtimeTerminationConfirmedAt === null);
    expect(claim?.set?.runtimeIncarnationId).not.toBe('runtime-1');
  });

  it('propagates exact installation ownership to the provider create boundary', async () => {
    await provisionNode('node-1', ENV);

    const allocationClaim = ops.find((op) => op.set?.runtimeIncarnationId && op.set.runtimeTerminationConfirmedAt === null);
    expect(allocationClaim?.set?.runtimeIncarnationId).toEqual(expect.any(String));
    expect(allocationClaim?.set?.runtimeIncarnationId).not.toBe('runtime-1');

    expect(createVM).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: {
          node: 'node-1',
          managed: 'simple-agent-manager',
          role: 'workspace',
          env: 'production',
          installation: '0123456789abcdef0123456789abcdef',
          incarnation: allocationClaim?.set?.runtimeIncarnationId,
        },
      })
    );
  });

  it('passes the concrete provider instance type from the node row to createVM', async () => {
    (nodeRows[0] as { providerInstanceType?: string }).providerInstanceType = 'cx42';

    await provisionNode('node-1', ENV);

    expect(createVM).toHaveBeenCalledWith(
      expect.objectContaining({
        size: undefined,
        instanceType: undefined,
        native: { instanceType: 'cx42' },
      })
    );
  });

  it('keeps provisioning compatible but omits ownership when identity is unavailable', async () => {
    await provisionNode('node-1', { ...ENV, SAM_INSTALLATION_ID: undefined });

    expect(createVM).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.not.objectContaining({ installation: expect.anything() }),
      })
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
      'project-1',
      null
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

  it('uses the selected pool credential reference as the exact provider authority', async () => {
    nodeRows.length = 0;
    nodeRows.push({
      id: 'node-project-pool',
      userId: 'member-b',
      credentialAttributionUserId: 'member-b',
      credentialAttributionProjectId: 'project-1',
      credentialAttributionSource: 'project',
      vmSize: 'large',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      capacityPoolId: 'pool-project-1',
      placementCredentialSource: 'project',
      placementCredentialReference: 'credentials:project-cloud-owner',
      placementCredentialVersion: 1700000000000,
    });
    createProviderForUser.mockResolvedValueOnce({
      provider: { createVM },
      providerName: 'hetzner',
      credentialSource: 'project',
    });

    await provisionNode('node-project-pool', ENV, {
      projectId: 'project-1',
      chatSessionId: '',
      taskId: 'task-1',
    });

    expect(createProviderForUser).toHaveBeenCalledWith(
      expect.anything(),
      'member-b',
      'test-key',
      ENV,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:project-cloud-owner',
        credentialVersion: 1700000000000,
      }
    );
  });

  it('records explicit node state when backend DNS creation fails', async () => {
    createNodeBackendDNSRecord.mockRejectedValue(new Error('Cloudflare DNS unavailable'));

    await expect(
      provisionNode('node-1', ENV, undefined, undefined, { environmentId: 'env-1' })
    ).resolves.toEqual({ allocationConfirmed: true });

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
      {
        status: 'creating',
        errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
      },
    ],
  ])('preserves cancellation during the %s', async (_boundary, vmIp, expectedTerminalSet) => {
    const controller = new AbortController();
    const callerReason = new ProviderError('hetzner', 503, `caller cancelled ${_boundary}`);
    let releaseUpdate: () => void = () => undefined;
    createVM.mockImplementationOnce(async () => {
      updateBarrier = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      return vmResult(vmIp);
    });

    const provisioning = provisionNode('node-1', ENV, undefined, {
      signal: controller.signal,
    });
    // ops[0] claims the provider identity before the paid call, ops[1] records
    // the returned provider instance without lifecycle mutation, and ops[2] is
    // the terminal write under test.
    await vi.waitFor(() => expect(ops).toHaveLength(3));
    expect(createVM).toHaveBeenCalledTimes(1);
    expect(ops[0]).toEqual({
      kind: 'update',
      set: expect.objectContaining({ cloudProvider: 'hetzner' }),
    });
    expect(ops[1]).toEqual({
      kind: 'update',
      set: expect.objectContaining({ providerInstanceId: 'provider-vm-1' }),
    });
    expect(ops[1].set).not.toHaveProperty('cloudProvider');
    expect(ops[1].set).not.toHaveProperty('status');
    expect(ops[2]).toEqual({
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

  it('revalidates authority immediately before paid allocation', async () => {
    const authority = vi.fn().mockRejectedValue(new Error('source revoked'));

    await expect(
      provisionNode('node-1', ENV, undefined, {
        rethrowProviderError: true,
        assertExternalMutationAuthority: authority,
      })
    ).rejects.toThrow('source revoked');

    expect(authority).toHaveBeenCalledOnce();
    expect(createVM).not.toHaveBeenCalled();
  });

  it('persists provider identity before detecting revocation after allocation', async () => {
    const authority = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('source revoked'));

    await expect(
      provisionNode('node-1', ENV, undefined, {
        rethrowProviderError: true,
        assertExternalMutationAuthority: authority,
      })
    ).rejects.toThrow('source revoked');

    expect(createVM).toHaveBeenCalledOnce();
    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        set: expect.objectContaining({ providerInstanceId: 'provider-vm-1' }),
      })
    );
  });

  it('cleans the exact created VM when lifecycle changes before provider identity can be recorded', async () => {
    nextWriteChanges = [1, 0, 0];

    await expect(
      provisionNode('node-1', ENV, undefined, { rethrowProviderError: true })
    ).rejects.toThrow('Node lifecycle changed before provider identity could be recorded');

    expect(createVM).toHaveBeenCalledOnce();
    expect(deleteNodeResourcesStrict).toHaveBeenCalledWith('node-1', 'user-1', ENV, {
      cleanupDns: false,
      expectedRuntime: {
        userId: 'user-1',
        runtime: 'vm',
        providerInstanceId: 'provider-vm-1',
        runtimeIncarnationId: expect.any(String),
      },
    });
    expect(deleteVM).not.toHaveBeenCalled();
    expect(ops.some((op) => op.set?.status === 'running')).toBe(false);
    expect(ops[1]).toEqual({
      kind: 'update',
      set: expect.objectContaining({ providerInstanceId: 'provider-vm-1' }),
    });
    expect(ops[1].set).not.toHaveProperty('status');
  });

  it('surfaces cleanup failure after authority is revoked after provider allocation', async () => {
    const authority = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('source revoked'));
    deleteNodeResourcesStrict.mockRejectedValueOnce(new Error('strict cleanup failed'));
    deleteVM.mockRejectedValueOnce(new Error('direct cleanup failed'));

    await expect(
      provisionNode('node-1', ENV, undefined, {
        rethrowProviderError: true,
        assertExternalMutationAuthority: authority,
      })
    ).rejects.toThrow('source revoked');

    expect(deleteNodeResourcesStrict).toHaveBeenCalledWith('node-1', 'user-1', ENV, {
      cleanupDns: false,
      expectedRuntime: {
        userId: 'user-1',
        runtime: 'vm',
        providerInstanceId: 'provider-vm-1',
        runtimeIncarnationId: expect.any(String),
      },
    });
    expect(deleteVM).toHaveBeenCalledWith('provider-vm-1');
    expect(logError).toHaveBeenCalledWith(
      'node_provisioning.authority_revoked_cleanup_failed',
      expect.objectContaining({ nodeId: 'node-1', providerInstanceId: 'provider-vm-1' })
    );
    expect(logError).toHaveBeenCalledWith(
      'node_provisioning.created_vm_direct_cleanup_failed',
      expect.objectContaining({ nodeId: 'node-1', providerInstanceId: 'provider-vm-1' })
    );
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
    expect(ops).toContainEqual({
      kind: 'update',
      set: expect.objectContaining({
        status: 'error',
        errorMessage: '[hetzner] Bad VM config',
      }),
    });
    expect(logError).toHaveBeenCalledWith(
      'node_provisioning.failed',
      expect.objectContaining({
        nodeId: 'node-1',
        provider: 'hetzner',
        statusCode: 400,
        error: 'Bad VM config',
      })
    );
    expect(persistError).toHaveBeenCalledWith(
      ENV.OBSERVABILITY_DATABASE,
      expect.objectContaining({
        source: 'api',
        level: 'error',
        message: 'Node provisioning failed: Bad VM config',
        context: expect.objectContaining({
          component: 'node-provisioning',
          nodeId: 'node-1',
          provider: 'hetzner',
          statusCode: 400,
        }),
      }),
      ENV
    );
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
