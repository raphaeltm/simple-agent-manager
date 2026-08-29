import { describe, expect, it, vi } from 'vitest';

import { handleNodeSelection } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { TaskStartCapacityPoolSelection } from '../../../src/services/placement-resolver';
import { SessionRecoveryAuthorityRevokedError } from '../../../src/services/session-recovery-authority';

type D1ResultMap = {
  persistedWarmClaim?: string | null;
  runs?: Array<{ sql: string; bound: unknown[] }>;
  preferredNode?: PlacementSeedFields & {
    status: string;
  } | null;
  warmNodes?: Array<PlacementSeedFields & { vm_location: string }>;
  freshWarmNode?: PlacementMetadataFields & {
    id?: string;
    status: string;
    warm_since: string | null;
    vm_size?: string;
    vm_location?: string;
    agent_version?: string | null;
    placement_explanation_json?: string | null;
  } | null;
  existingNodes?: Array<
    PlacementSeedFields & {
    vm_location: string;
    health_status: string;
    last_metrics: string | null;
    }
  >;
  workspaceCounts?: Array<{ node_id: string; c: number }>;
  warmWorkspaceCount?: number;
  healthByNode?: Record<
    string,
    {
      health_status: string | null;
      last_heartbeat_at: string | null;
      agent_ready_at: string | null;
      agent_version?: string | null;
    }
  >;
};

type MockNode = NonNullable<D1ResultMap['preferredNode']>;

type PlacementMetadataFields = {
  capacity_pool_id?: string | null;
  capacity_pool_scope?: string | null;
  capacity_pool_revision?: number | null;
  capacity_source_id?: string | null;
  capacity_pool_candidate_id?: string | null;
  placement_credential_source?: string | null;
  placement_credential_reference?: string | null;
  placement_credential_version?: number | null;
  capacity_pool_project_id?: string | null;
  workload_role?: string | null;
  provider_instance_type?: string | null;
  provider_instance_vcpu_count?: number | null;
  provider_instance_memory_mb?: number | null;
  provider_instance_disk_gb?: number | null;
  provider_instance_price_display?: string | null;
  provider_instance_price_currency?: string | null;
  provider_instance_price_monthly_cents?: number | null;
  provider_instance_price_hourly_micros?: number | null;
};

type PlacementSeedFields = PlacementMetadataFields & {
  id: string;
  vm_size: string;
  vm_location?: string | null;
  agent_version?: string | null;
  placement_explanation_json?: string | null;
};

// Shared shape for every node source fed into toPlacementRow (preferredNode,
// freshWarmNode, warmNodes, existingNodes). status/health_status/warm_since are
// optional because only some sources carry them, so passing any element type to
// a map callback typed against this is valid under strict callback checking.
type PlacementRowNodeSource = PlacementSeedFields & {
  id: string;
  status?: string | null;
  vm_size: string;
  vm_location?: string | null;
  agent_version?: string | null;
  cloud_provider?: string | null;
  health_status?: string | null;
  last_metrics?: string | null;
  warm_since?: string | null;
};

function toPlacementRow(node: PlacementRowNodeSource | null | undefined) {
  if (!node) return null;
  return {
    id: node.id,
    status: 'status' in node ? node.status : undefined,
    vmSize: node.vm_size,
    vmLocation: node.vm_location ?? 'fsn1',
    cloudProvider:
      'cloud_provider' in node
        ? ((node as { cloud_provider?: string | null }).cloud_provider ?? null)
        : null,
    capacityPoolId: node.capacity_pool_id ?? null,
    capacityPoolScope: node.capacity_pool_scope ?? null,
    capacityPoolRevision: node.capacity_pool_revision ?? null,
    capacitySourceId: node.capacity_source_id ?? null,
    capacityPoolCandidateId: node.capacity_pool_candidate_id ?? null,
    placementCredentialSource: node.placement_credential_source ?? null,
    placementCredentialReference: node.placement_credential_reference ?? null,
    placementCredentialVersion: node.placement_credential_version ?? null,
    capacityPoolProjectId: node.capacity_pool_project_id ?? null,
    workloadRole: node.workload_role ?? null,
    providerInstanceType: node.provider_instance_type ?? null,
    providerInstanceVcpuCount: node.provider_instance_vcpu_count ?? null,
    providerInstanceMemoryMb: node.provider_instance_memory_mb ?? null,
    providerInstanceDiskGb: node.provider_instance_disk_gb ?? null,
    providerInstancePriceDisplay: node.provider_instance_price_display ?? null,
    providerInstancePriceCurrency: node.provider_instance_price_currency ?? null,
    providerInstancePriceMonthlyCents: node.provider_instance_price_monthly_cents ?? null,
    providerInstancePriceHourlyMicros: node.provider_instance_price_hourly_micros ?? null,
    placementExplanationJson: node.placement_explanation_json ?? null,
    agentVersion: node.agent_version ?? null,
    healthStatus:
      'health_status' in node ? (node as { health_status?: string }).health_status : undefined,
    lastMetrics:
      'last_metrics' in node
        ? ((node as { last_metrics?: string | null }).last_metrics ?? null)
        : undefined,
    warmSince:
      'warm_since' in node
        ? ((node as { warm_since?: string | null }).warm_since ?? null)
        : undefined,
  };
}

function defaultPlacementNode(id: string): MockNode {
  return {
    id,
    status: 'running',
    vm_size: 'large',
    vm_location: 'fsn1',
    agent_version: 'current-sha',
  };
}

function createStatement(sql: string, results: D1ResultMap) {
  let bound: unknown[] = [];
  return {
    bind(...args: unknown[]) {
      bound = args;
      return this;
    },
    first() {
      if (sql.includes('claimed_warm_node_id AS claimedWarmNodeId')) {
        const claimedWarmNodeId = results.persistedWarmClaim ?? null;
        return Promise.resolve({
          claimedWarmNodeId,
          ...(claimedWarmNodeId ? toPlacementRow(defaultPlacementNode(claimedWarmNodeId)) : {}),
        });
      }
      if (sql.includes('FROM nodes WHERE id = ? AND user_id = ?')) {
        return Promise.resolve(toPlacementRow(results.preferredNode ?? null));
      }
      if (
        sql.includes("FROM nodes WHERE id = ? AND status = 'running' AND warm_since IS NOT NULL")
      ) {
        const node = results.freshWarmNode
          ? {
              id: results.freshWarmNode.id ?? String(bound[0]),
              vm_size: results.freshWarmNode.vm_size ?? 'large',
              vm_location: results.freshWarmNode.vm_location ?? 'fsn1',
              ...results.freshWarmNode,
            }
          : null;
        return Promise.resolve(toPlacementRow(node as MockNode | null));
      }
      if (sql.includes('SELECT health_status, last_heartbeat_at, agent_ready_at')) {
        return Promise.resolve(results.healthByNode?.[String(bound[0])] ?? null);
      }
      if (sql.includes('SELECT COUNT(*) as c FROM workspaces WHERE node_id = ?')) {
        return Promise.resolve({ c: results.warmWorkspaceCount ?? 0 });
      }
      return Promise.resolve(null);
    },
    run() {
      results.runs?.push({ sql, bound });
      return Promise.resolve({ meta: { changes: 1 } });
    },
    all() {
      if (sql.includes('warm_since IS NOT NULL')) {
        return Promise.resolve({ results: (results.warmNodes ?? []).map(toPlacementRow) });
      }
      if (sql.includes('health_status AS healthStatus')) {
        const rows = (results.existingNodes ?? []).map(toPlacementRow);
        return Promise.resolve({ results: rows });
      }
      if (sql.includes('SELECT node_id, COUNT(*) as c FROM workspaces')) {
        return Promise.resolve({ results: results.workspaceCounts ?? [] });
      }
      return Promise.resolve({ results: [] });
    },
  };
}

function createContext(results: D1ResultMap): TaskRunnerContext {
  return {
    env: {
      DATABASE: {
        prepare(sql: string) {
          return createStatement(sql, results);
        },
      },
      NODE_HEARTBEAT_STALE_SECONDS: '180',
      MAX_WORKSPACES_PER_NODE: '5',
      VM_AGENT_REQUIRED_VERSION: 'current-sha',
    },
    ctx: {
      storage: {
        setAlarm: vi.fn(),
        put: vi.fn().mockResolvedValue(undefined),
      },
    },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getAgentPollIntervalMs: vi.fn(() => 1000),
    getAgentReadyTimeoutMs: vi.fn(() => 1000),
    getWorkspaceReadyTimeoutMs: vi.fn(() => 1000),
    getWorkspaceReadyPollIntervalMs: vi.fn(() => 1000),
    getProvisionPollIntervalMs: vi.fn(() => 1000),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

function createState(overrides: Partial<TaskRunnerState> = {}): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'node_selection',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
      capacityPlacementSnapshot: null,
    },
    config: {
      vmSize: 'large',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'VM size regression',
      taskDescription: null,
      repository: 'owner/repo',
      installationId: '123',
      outputBranch: null,
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: null,
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    completed: false,
    ...overrides,
  };
}

function capacityPoolSelection(
  scope: 'project' | 'user' | 'installation',
  overrides: {
    poolId?: string;
    sourceId?: string;
    candidateId?: string;
    projectId?: string | null;
    provider?: 'hetzner' | 'vultr' | 'scaleway';
    location?: string;
    machineSize?: 'small' | 'medium' | 'large';
    providerInstanceType?: string;
    vcpuCount?: number;
    memoryMb?: number;
    diskGb?: number | null;
  } = {}
): TaskStartCapacityPoolSelection {
  const poolId = overrides.poolId ?? `pool-${scope}`;
  const sourceId = overrides.sourceId ?? `source-${scope}`;
  const candidateId = overrides.candidateId ?? `candidate-${scope}`;
  const projectId = scope === 'project' ? (overrides.projectId ?? 'project-1') : null;
  const provider = overrides.provider ?? 'hetzner';
  const location = overrides.location ?? 'fsn1';
  const machineSize = overrides.machineSize ?? 'large';
  const providerInstanceType =
    overrides.providerInstanceType ??
    ({ small: 'cx22', medium: 'cx23', large: 'cx32' } satisfies Record<string, string>)[
      machineSize
    ];
  const providerInstanceVcpuCount =
    overrides.vcpuCount ?? ({ small: 2, medium: 2, large: 8 } satisfies Record<string, number>)[
      machineSize
    ];
  const providerInstanceMemoryMb =
    overrides.memoryMb ??
    ({ small: 4096, medium: 4096, large: 16384 } satisfies Record<string, number>)[machineSize];
  const providerInstanceDiskGb =
    overrides.diskGb ?? ({ small: 40, medium: 80, large: 160 } satisfies Record<string, number>)[
      machineSize
    ];
  const placementCredentialSource = scope === 'installation' ? 'platform' : scope;
  const snapshot = {
    capacityPoolId: poolId,
    capacityPoolScope: scope,
    capacityPoolRevision: 3,
    capacitySourceId: sourceId,
    capacityPoolCandidateId: candidateId,
    placementCredentialSource,
    placementCredentialReference:
      scope === 'installation'
        ? 'platform_credentials:platform-hetzner'
        : `credentials:${sourceId}`,
    placementCredentialVersion: 123,
    capacityPoolProjectId: projectId,
    workloadRole: 'workspace' as const,
    providerInstanceType,
    providerInstanceVcpuCount,
    providerInstanceMemoryMb,
    providerInstanceDiskGb,
    providerInstancePriceDisplay: '€18.49/mo',
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: 1849,
    providerInstancePriceHourlyMicros: 25329,
    placementExplanationJson: JSON.stringify({
      poolId,
      capacitySourceId: sourceId,
      capacityPoolCandidateId: candidateId,
      providerInstanceType,
    }),
  };
  return {
    poolId,
    scope,
    revision: 3,
    strategy: 'balanced',
    capacityPoolProjectId: projectId,
    workloadRole: 'workspace',
    poolSnapshot: { ...snapshot, capacitySourceId: null, capacityPoolCandidateId: null },
    candidates: [
      {
        id: candidateId,
        poolId,
        capacitySourceId: sourceId,
        provider,
        location,
        workloadRole: 'workspace',
        runtime: 'vm',
        machineClass: 'shared-vm',
        machineSize,
        providerInstanceType,
        providerInstanceVcpuCount,
        providerInstanceMemoryMb,
        providerInstanceDiskGb,
        providerInstancePriceDisplay: snapshot.providerInstancePriceDisplay,
        providerInstancePriceCurrency: snapshot.providerInstancePriceCurrency,
        providerInstancePriceMonthlyCents: snapshot.providerInstancePriceMonthlyCents,
        providerInstancePriceHourlyMicros: snapshot.providerInstancePriceHourlyMicros,
        priority: 0,
        candidateOrder: 0,
        credentialAttributionSource: placementCredentialSource,
        placementCredentialSource,
        placementCredentialReference: snapshot.placementCredentialReference,
        placementCredentialVersion: snapshot.placementCredentialVersion,
        capacityPoolProjectId: projectId,
        snapshot,
      },
    ],
  };
}

function nodeCapacityFields(selection: TaskStartCapacityPoolSelection) {
  const candidate = selection.candidates[0];
  return {
    cloud_provider: candidate.provider,
    capacity_pool_id: selection.poolId,
    capacity_pool_scope: selection.scope,
    capacity_pool_revision: selection.revision,
    capacity_source_id: candidate.capacitySourceId,
    capacity_pool_candidate_id: candidate.id,
    placement_credential_source: candidate.placementCredentialSource,
    placement_credential_reference: candidate.placementCredentialReference,
    placement_credential_version: candidate.placementCredentialVersion,
    capacity_pool_project_id: candidate.capacityPoolProjectId,
    workload_role: candidate.workloadRole,
    provider_instance_type: candidate.providerInstanceType,
    provider_instance_vcpu_count: candidate.providerInstanceVcpuCount,
    provider_instance_memory_mb: candidate.providerInstanceMemoryMb,
    provider_instance_disk_gb: candidate.providerInstanceDiskGb,
    provider_instance_price_display: candidate.providerInstancePriceDisplay,
    provider_instance_price_currency: candidate.providerInstancePriceCurrency,
    provider_instance_price_monthly_cents: candidate.providerInstancePriceMonthlyCents,
    provider_instance_price_hourly_micros: candidate.providerInstancePriceHourlyMicros,
    placement_explanation_json: candidate.snapshot.placementExplanationJson,
  };
}

describe('TaskRunner node selection VM size minimum behavior', () => {
  it('does not reuse legacy nodes when the selected pool has no candidates', async () => {
    const rc = createContext({});
    const state = createState();
    state.config.capacityPoolSelection = {
      ...capacityPoolSelection('user'),
      candidates: [],
    };

    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({
      message: 'No active compute pool offerings in the selected user pool satisfy the requested resources.',
      permanent: true,
    });

    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('recovers a D1-persisted warm claim before discovering new candidates', async () => {
    const now = new Date().toISOString();
    const state = createState();
    const tryClaim = vi.fn().mockResolvedValue({
      claimed: true,
      state: {
        nodeId: 'warm-recovered',
        status: 'active',
        warmSince: null,
        claimedByTask: state.taskId,
      },
    });
    const rc = createContext({
      persistedWarmClaim: 'warm-recovered',
      warmNodes: [],
      healthByNode: {
        'warm-recovered': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });
    rc.env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ tryClaim, releaseClaim: vi.fn() })),
    } as unknown as DurableObjectNamespace;

    await handleNodeSelection(state, rc);

    expect(tryClaim).toHaveBeenCalledWith(state.taskId, undefined);
    expect(state.stepResults).toMatchObject({
      nodeId: 'warm-recovered',
      claimedWarmNodeId: 'warm-recovered',
      autoProvisioned: false,
    });
    expect(rc.ctx.storage.put).toHaveBeenCalledWith('state', state);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('releases an unusable D1-persisted warm claim before clearing the task pointer', async () => {
    const runs: Array<{ sql: string; bound: unknown[] }> = [];
    const state = createState({
      config: {
        ...createState().config,
        capacityPoolSelection: capacityPoolSelection('project', {
          poolId: 'pool-project-1',
          sourceId: 'source-project-1',
          candidateId: 'candidate-project-1',
          projectId: 'project-1',
        }),
      },
    });
    const releaseClaim = vi.fn().mockResolvedValue({
      released: true,
      state: {
        nodeId: 'warm-legacy-unusable',
        status: 'warm',
        warmSince: Date.now(),
        claimedByTask: null,
      },
    });
    const tryClaim = vi.fn();
    const rc = createContext({
      persistedWarmClaim: 'warm-legacy-unusable',
      warmNodes: [],
      existingNodes: [],
      runs,
    });
    rc.env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ tryClaim, releaseClaim })),
    } as unknown as DurableObjectNamespace;

    await handleNodeSelection(state, rc);

    expect(tryClaim).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith(state.taskId);
    expect(
      runs.some(
        (run) =>
          run.sql.includes('UPDATE tasks SET claimed_warm_node_id = NULL') &&
          run.bound[1] === state.taskId &&
          run.bound[2] === 'warm-legacy-unusable'
      )
    ).toBe(true);
    expect(state.stepResults.claimedWarmNodeId ?? null).toBeNull();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });

  it('persists a warm claim locally and advances only after post-claim authority validation', async () => {
    const now = new Date().toISOString();
    const state = createState();
    const tryClaim = vi.fn().mockResolvedValue({
      claimed: true,
      state: {
        nodeId: 'warm-large',
        status: 'active',
        warmSince: null,
        claimedByTask: state.taskId,
      },
    });
    const rc = createContext({
      warmNodes: [
        { id: 'warm-large', vm_size: 'large', vm_location: 'fsn1', agent_version: 'current-sha' },
      ],
      freshWarmNode: {
        status: 'running',
        warm_since: now,
        agent_version: 'current-sha',
      },
      healthByNode: {
        'warm-large': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });
    rc.env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ tryClaim, releaseClaim: vi.fn() })),
    } as unknown as DurableObjectNamespace;

    await handleNodeSelection(state, rc);

    expect(tryClaim).toHaveBeenCalledWith(state.taskId, undefined);
    expect(rc.assertRecoveryAuthority).toHaveBeenCalledTimes(2);
    expect(state.stepResults).toMatchObject({
      nodeId: 'warm-large',
      claimedWarmNodeId: 'warm-large',
      autoProvisioned: false,
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('releases the exact warm claim when authority is revoked after the DO mutation', async () => {
    const state = createState({
      config: {
        ...createState().config,
        recoverySourceTaskId: 'source-1',
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const releaseClaim = vi.fn().mockResolvedValue({
      released: true,
      state: { nodeId: 'warm-large', status: 'warm', warmSince: 1, claimedByTask: null },
    });
    const rc = createContext({
      warmNodes: [
        { id: 'warm-large', vm_size: 'large', vm_location: 'fsn1', agent_version: 'current-sha' },
      ],
      freshWarmNode: {
        status: 'running',
        warm_since: new Date().toISOString(),
        agent_version: 'current-sha',
      },
    });
    vi.mocked(rc.assertRecoveryAuthority)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SessionRecoveryAuthorityRevokedError());
    rc.env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({
        tryClaim: vi.fn().mockResolvedValue({
          claimed: true,
          state: {
            nodeId: 'warm-large',
            status: 'active',
            warmSince: null,
            claimedByTask: state.taskId,
          },
        }),
        releaseClaim,
      })),
    } as unknown as DurableObjectNamespace;

    await expect(handleNodeSelection(state, rc)).rejects.toBeInstanceOf(
      SessionRecoveryAuthorityRevokedError
    );
    expect(releaseClaim).toHaveBeenCalledWith(state.taskId);
    expect(state.stepResults.nodeId).toBeNull();
    expect(state.stepResults.claimedWarmNodeId).toBeNull();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('rejects an undersized preferred node before health verification', async () => {
    const state = createState({
      config: { ...createState().config, preferredNodeId: 'node-medium', vmSize: 'large' },
    });
    const rc = createContext({
      preferredNode: {
        id: 'node-medium',
        status: 'running',
        vm_size: 'medium',
        agent_version: 'current-sha',
      },
    });

    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({
      message: 'Specified node does not satisfy the requested resources',
      permanent: true,
    });
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('does not claim undersized warm nodes and falls through to provisioning', async () => {
    const lifecycleGet = vi.fn();
    const state = createState();
    const rc = createContext({
      warmNodes: [
        { id: 'warm-medium', vm_size: 'medium', vm_location: 'fsn1', agent_version: 'current-sha' },
      ],
      existingNodes: [],
    });
    rc.env.NODE_LIFECYCLE = {
      idFromName: vi.fn((id: string) => id),
      get: lifecycleGet,
    } as unknown as DurableObjectNamespace;

    await handleNodeSelection(state, rc);

    expect(lifecycleGet).not.toHaveBeenCalled();
    expect(state.stepResults.nodeId).toBeNull();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });

  it('selects a larger existing node and skips smaller existing nodes', async () => {
    const state = createState({ config: { ...createState().config, vmSize: 'large' } });
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-medium',
          vm_size: 'medium',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
          agent_version: 'current-sha',
        },
        {
          id: 'node-large',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 20, memoryPercent: 20 }),
          agent_version: 'current-sha',
        },
      ],
      healthByNode: {
        'node-large': {
          health_status: 'healthy',
          last_heartbeat_at: new Date().toISOString(),
          agent_ready_at: new Date().toISOString(),
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-large');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('selects a concrete pool node when normalized resources satisfy the task despite legacy vm_size', async () => {
    const selection = capacityPoolSelection('user', {
      poolId: 'pool-user-concrete',
      sourceId: 'source-user-concrete',
      candidateId: 'candidate-ccx13',
      machineSize: 'small',
      providerInstanceType: 'ccx13',
      vcpuCount: 8,
      memoryMb: 16 * 1024,
      diskGb: 160,
    });
    const state = createState({
      config: {
        ...createState().config,
        vmSize: 'large',
        capacityPoolSelection: selection,
        resolvedReservation: {
          cpuMillis: 6000,
          memoryMb: 12 * 1024,
          diskMb: 80 * 1024,
          exclusiveNode: false,
          maxCoTenants: 1,
          source: 'task',
          sourceId: 'task-1',
        },
      },
    });
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-concrete-small-legacy',
          vm_size: 'small',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 5, memoryPercent: 5 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(selection),
        },
      ],
      healthByNode: {
        'node-concrete-small-legacy': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-concrete-small-legacy');
    expect(state.stepResults.capacityPlacementSnapshot).toMatchObject({
      capacityPoolId: 'pool-user-concrete',
      capacityPoolCandidateId: 'candidate-ccx13',
      providerInstanceType: 'ccx13',
      providerInstanceVcpuCount: 8,
      providerInstanceMemoryMb: 16 * 1024,
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('isolates project-pool nodes to the same project and pool/source', async () => {
    const state = createState({
      projectId: 'project-1',
      config: {
        ...createState().config,
        capacityPoolSelection: capacityPoolSelection('project', {
          poolId: 'pool-project-1',
          sourceId: 'source-project-1',
          candidateId: 'candidate-project-1',
          projectId: 'project-1',
        }),
      },
    });
    const sameProject = state.config.capacityPoolSelection!;
    const otherProject = capacityPoolSelection('project', {
      poolId: 'pool-project-2',
      sourceId: 'source-project-2',
      candidateId: 'candidate-project-2',
      projectId: 'project-2',
    });
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-project-2',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(otherProject),
        },
        {
          id: 'node-project-1',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 20, memoryPercent: 20 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(sameProject),
        },
      ],
      healthByNode: {
        'node-project-1': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-project-1');
    expect(state.stepResults.capacityPlacementSnapshot).toMatchObject({
      capacityPoolId: 'pool-project-1',
      capacitySourceId: 'source-project-1',
      capacityPoolCandidateId: 'candidate-project-1',
      capacityPoolProjectId: 'project-1',
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('allows same-user cross-project reuse for user-scope pool nodes', async () => {
    const selection = capacityPoolSelection('user', {
      poolId: 'pool-user-1',
      sourceId: 'source-user-1',
      candidateId: 'candidate-user-1',
    });
    const state = createState({
      projectId: 'project-2',
      config: {
        ...createState().config,
        capacityPoolSelection: selection,
      },
    });
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-user-pool-cross-project',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(selection),
        },
      ],
      healthByNode: {
        'node-user-pool-cross-project': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-user-pool-cross-project');
    expect(state.stepResults.capacityPlacementSnapshot).toMatchObject({
      capacityPoolId: 'pool-user-1',
      capacitySourceId: 'source-user-1',
      capacityPoolProjectId: null,
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('preserves null-pool legacy reuse while rejecting project-pool nodes without a selected pool', async () => {
    const sameProject = capacityPoolSelection('project', {
      poolId: 'pool-project-1',
      sourceId: 'source-project-1',
      candidateId: 'candidate-project-1',
      projectId: 'project-1',
    });
    const otherProject = capacityPoolSelection('project', {
      poolId: 'pool-project-2',
      sourceId: 'source-project-2',
      candidateId: 'candidate-project-2',
      projectId: 'project-2',
    });
    const state = createState({ projectId: 'project-1' });
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-project-2',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(otherProject),
        },
        {
          id: 'node-project-1',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 2 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(sameProject),
        },
        {
          id: 'node-legacy',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 40, memoryPercent: 40 }),
          agent_version: 'current-sha',
        },
      ],
      healthByNode: {
        'node-legacy': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-legacy');
    expect(state.stepResults.capacityPlacementSnapshot).toBeNull();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('skips existing nodes that report creating workspaces in heartbeat metrics', async () => {
    const state = createState();
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-building',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({
            cpuLoadAvg1: 1,
            memoryPercent: 1,
            creatingWorkspaces: 1,
          }),
          agent_version: 'current-sha',
        },
        {
          id: 'node-ready',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 20, memoryPercent: 20 }),
          agent_version: 'current-sha',
        },
      ],
      healthByNode: {
        'node-ready': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-ready');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('skips a better-ranked stale node and selects a compatible current node', async () => {
    const state = createState({ config: { ...createState().config, vmSize: 'large' } });
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-stale',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1 }),
          agent_version: 'old-sha',
        },
        {
          id: 'node-current',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 40, memoryPercent: 40 }),
          agent_version: 'current-sha',
        },
      ],
      healthByNode: {
        'node-current': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-current');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('rejects an explicitly preferred stale node', async () => {
    const state = createState({
      config: { ...createState().config, preferredNodeId: 'node-stale', vmSize: 'large' },
    });
    const rc = createContext({
      preferredNode: {
        id: 'node-stale',
        status: 'running',
        vm_size: 'large',
        agent_version: 'old-sha',
      },
    });

    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({
      message: 'Specified node is running an incompatible VM agent build',
      permanent: true,
    });
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });
});
