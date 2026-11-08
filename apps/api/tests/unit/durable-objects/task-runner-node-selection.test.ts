import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleNodeSelection } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { TaskStartCapacityPoolSelection } from '../../../src/services/placement-resolver';
import { SessionRecoveryAuthorityRevokedError } from '../../../src/services/session-recovery-authority';

const admissionMocks = vi.hoisted(() => ({
  resolveVmAdmissionScope: vi.fn(),
  waitForVmAdmissionCapacity: vi.fn(),
}));

vi.mock('../../../src/services/vm-admission-control', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/services/vm-admission-control')>();
  return {
    ...actual,
    resolveVmAdmissionScope: (...args: unknown[]) =>
      admissionMocks.resolveVmAdmissionScope(...args),
    waitForVmAdmissionCapacity: (...args: unknown[]) =>
      admissionMocks.waitForVmAdmissionCapacity(...args),
  };
});

type D1ResultMap = {
  activePoolNodeCount?: number;
  persistedWarmClaim?: string | null;
  persistedWarmNode?: PlacementRowNodeSource;
  runs?: Array<{ sql: string; bound: unknown[] }>;
  preferredNode?:
    | (PlacementSeedFields & {
        status: string;
      })
    | null;
  warmNodes?: Array<PlacementSeedFields & { vm_location: string }>;
  freshWarmNode?:
    | (PlacementMetadataFields & {
        id?: string;
        status: string;
        warm_since: string | null;
        vm_size?: string;
        vm_location?: string;
        agent_version?: string | null;
        placement_explanation_json?: string | null;
      })
    | null;
  existingNodes?: Array<
    PlacementSeedFields & {
      vm_location: string;
      health_status: string;
      last_metrics: string | null;
      last_heartbeat_at?: string | null;
    }
  >;
  workspaceCounts?: Array<{ node_id: string; c: number }>;
  warmWorkspaceCount?: number;
  workspaceReservations?: Array<{
    nodeId: string;
    resolvedReservationJson: string | null;
    /** Workspace status; defaults to `running`. `creating` rows are the node's startup backlog. */
    status?: string;
  }>;
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
type ExistingNodeSeed = NonNullable<D1ResultMap['existingNodes']>[number];

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
  // Trusted-capacity projection. Production node selection reads these columns
  // (services/workspace-resource-capacity.ts trustedWorkspaceNodeCapacityColumnsSql);
  // a fixture that omits them models a node with no verified hardware, which the
  // real selector rejects.
  node_class?: string | null;
  provider_instance_id?: string | null;
  observed_provider_instance_type?: string | null;
  observed_provider_instance_vcpu_count?: number | null;
  observed_provider_instance_memory_mb?: number | null;
  observed_provider_instance_disk_gb?: number | null;
  observed_hardware_source?: string | null;
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
  last_heartbeat_at?: string | null;
  warm_since?: string | null;
};

/**
 * Concrete hardware a real running managed node of this legacy vm_size reports.
 * Fixtures that only set vm_size still model a provisioned node with
 * provider-observed hardware, which is what the production projection returns
 * and what both advisory selection and the final admission SQL require.
 */
const LEGACY_SIZE_HARDWARE: Record<string, { vcpu: number; memoryMb: number; diskGb: number }> = {
  small: { vcpu: 2, memoryMb: 4096, diskGb: 40 },
  medium: { vcpu: 4, memoryMb: 8192, diskGb: 80 },
  large: { vcpu: 8, memoryMb: 16384, diskGb: 160 },
};

function plannedHardware(node: PlacementRowNodeSource): {
  vcpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
} {
  const fallback = LEGACY_SIZE_HARDWARE[node.vm_size] ?? null;
  return {
    vcpu: node.provider_instance_vcpu_count ?? fallback?.vcpu ?? null,
    memoryMb: node.provider_instance_memory_mb ?? fallback?.memoryMb ?? null,
    diskGb: node.provider_instance_disk_gb ?? fallback?.diskGb ?? null,
  };
}

function toPlacementRow(node: PlacementRowNodeSource | null | undefined) {
  if (!node) return null;
  const planned = plannedHardware(node);
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
    // A running managed node has a provider instance and provider-observed
    // hardware; fixtures opt out explicitly (null) to model old/unverified nodes.
    nodeClass: node.node_class === undefined ? 'managed' : node.node_class,
    providerInstanceId:
      node.provider_instance_id === undefined ? `server-${node.id}` : node.provider_instance_id,
    observedProviderInstanceType:
      node.observed_provider_instance_type === undefined
        ? (node.provider_instance_type ?? null)
        : node.observed_provider_instance_type,
    observedProviderInstanceVcpuCount:
      node.observed_provider_instance_vcpu_count === undefined
        ? planned.vcpu
        : node.observed_provider_instance_vcpu_count,
    observedProviderInstanceMemoryMb:
      node.observed_provider_instance_memory_mb === undefined
        ? planned.memoryMb
        : node.observed_provider_instance_memory_mb,
    observedProviderInstanceDiskGb:
      node.observed_provider_instance_disk_gb === undefined
        ? planned.diskGb
        : node.observed_provider_instance_disk_gb,
    observedHardwareSource:
      node.observed_hardware_source === undefined ? 'observed' : node.observed_hardware_source,
    agentVersion: node.agent_version ?? null,
    healthStatus:
      'health_status' in node ? (node as { health_status?: string }).health_status : undefined,
    lastMetrics:
      'last_metrics' in node
        ? ((node as { last_metrics?: string | null }).last_metrics ?? null)
        : undefined,
    lastHeartbeatAt:
      'last_heartbeat_at' in node
        ? ((node as { last_heartbeat_at?: string | null }).last_heartbeat_at ?? null)
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
      if (sql.includes('COUNT(*) AS count') && sql.includes('capacity_pool_id = ?')) {
        return Promise.resolve({ count: results.activePoolNodeCount ?? 0 });
      }
      if (sql.includes('claimed_warm_node_id AS claimedWarmNodeId')) {
        const claimedWarmNodeId = results.persistedWarmClaim ?? null;
        return Promise.resolve({
          claimedWarmNodeId,
          ...(claimedWarmNodeId
            ? toPlacementRow(results.persistedWarmNode ?? defaultPlacementNode(claimedWarmNodeId))
            : {}),
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
      // This suite exercises orchestration with a successful authority boundary.
      // Real SQL revocation/stale-snapshot cases live in
      // placement-authority-effective-pool.test.ts.
      if (sql.includes('SELECT n.id FROM nodes n')) {
        const ids = new Set(
          [
            results.persistedWarmClaim,
            results.preferredNode?.id,
            results.freshWarmNode?.id,
            ...(results.warmNodes ?? []).map((node) => node.id),
            ...(results.existingNodes ?? []).map((node) => node.id),
          ].filter((id): id is string => typeof id === 'string')
        );
        return Promise.resolve({
          results: [...ids].filter((id) => bound.includes(id)).map((id) => ({ id })),
        });
      }
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
      if (sql.includes('resolved_reservation_json AS reservationJson')) {
        return Promise.resolve({
          results: (results.workspaceReservations ?? []).map((row, index) => ({
            nodeId: row.nodeId,
            reservationJson: row.resolvedReservationJson,
            workspaceId: `ws-${row.nodeId}-${index}`,
            status: row.status ?? 'running',
          })),
        });
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
    strategy?: TaskStartCapacityPoolSelection['strategy'];
    maxNodes?: number;
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
    overrides.vcpuCount ??
    ({ small: 2, medium: 2, large: 8 } satisfies Record<string, number>)[machineSize];
  const providerInstanceMemoryMb =
    overrides.memoryMb ??
    ({ small: 4096, medium: 4096, large: 16384 } satisfies Record<string, number>)[machineSize];
  const providerInstanceDiskGb =
    overrides.diskGb ??
    ({ small: 40, medium: 80, large: 160 } satisfies Record<string, number>)[machineSize];
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
    strategy: overrides.strategy ?? 'balanced',
    maxNodes: overrides.maxNodes ?? 3,
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

const ADMISSION_SCOPE = {
  provider: 'hetzner' as const,
  credentialSource: 'user' as const,
  credentialDomainKey: 'user:user-1:hetzner',
  providerDomainKey: 'hetzner:user:user-1:hetzner',
  scopeKey: 'user:user-1:workspace-vm:hetzner:user:user-1:hetzner',
};

function busyBuildMetrics(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cpuLoadAvg1: 0.1,
    memoryPercent: 10,
    diskPercent: 10,
    creatingWorkspaces: 1,
    ...overrides,
  });
}

function idleBuildMetrics(): string {
  return busyBuildMetrics({ creatingWorkspaces: 0 });
}

function busyBuildState({
  cpuMillis = 500,
  selection = capacityPoolSelection('user'),
}: {
  cpuMillis?: number;
  selection?: TaskStartCapacityPoolSelection;
} = {}): TaskRunnerState {
  return createState({
    config: {
      ...createState().config,
      cloudProvider: 'hetzner',
      capacityPoolSelection: selection,
      resolvedReservation: {
        cpuMillis,
        memoryMb: 1_024,
        diskMb: 1_024,
        exclusiveNode: false,
        source: 'task',
        sourceId: 'task-1',
        version: 1,
      },
    },
  });
}

function busyBuildNode(
  id: string,
  selection: TaskStartCapacityPoolSelection,
  overrides: Partial<ExistingNodeSeed> = {}
): ExistingNodeSeed {
  const candidate = selection.candidates[0];
  return {
    id,
    vm_size: candidate.machineSize,
    vm_location: candidate.location,
    health_status: 'healthy',
    last_metrics: busyBuildMetrics(),
    last_heartbeat_at: new Date().toISOString(),
    agent_version: 'current-sha',
    ...nodeCapacityFields(selection),
    ...overrides,
  };
}

/** `count` workspace rows on `nodeId` holding the run's own reservation. */
function reservationsOn(
  nodeId: string,
  count: number,
  state: TaskRunnerState,
  status: 'creating' | 'running' = 'creating'
): NonNullable<D1ResultMap['workspaceReservations']> {
  return Array.from({ length: count }, () => ({
    nodeId,
    resolvedReservationJson: JSON.stringify(state.config.resolvedReservation),
    status,
  }));
}

function healthyAgents(...nodeIds: string[]): NonNullable<D1ResultMap['healthByNode']> {
  const now = new Date().toISOString();
  return Object.fromEntries(
    nodeIds.map((id) => [
      id,
      {
        health_status: 'healthy',
        last_heartbeat_at: now,
        agent_ready_at: now,
        agent_version: 'current-sha',
      },
    ])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  admissionMocks.resolveVmAdmissionScope.mockResolvedValue(ADMISSION_SCOPE);
  admissionMocks.waitForVmAdmissionCapacity.mockResolvedValue({
    kind: 'waiting',
    reason: 'compatible_node_building_workspace',
    nextRetryAt: '2026-09-11T12:00:15.000Z',
    waitDeadlineAt: '2026-09-11T12:15:00.000Z',
  });
});

describe('TaskRunner node selection VM size minimum behavior', () => {
  it('rejects an impossible persisted plan before selecting or provisioning a node', async () => {
    const rc = createContext({});
    const state = createState();
    state.config.capacityPoolSelection = capacityPoolSelection('user');
    state.config.capacityPoolSelection.candidates[0].providerInstanceMemoryMb = 4096;
    state.config.resourceRequirements = { minMemoryGb: 4 };
    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({ permanent: true });
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('drops a persisted 4 GB plan that an older 512 MB-reserve scheduler made for 3.5 GB', async () => {
    // 4096 - 512 >= 3584 let the old scheduler keep this candidate; the shared 1024 MB reserve
    // does not, so the stale plan is refused before any provider is called.
    const rc = createContext({});
    const state = createState();
    state.config.capacityPoolSelection = capacityPoolSelection('user');
    state.config.capacityPoolSelection.candidates[0].providerInstanceMemoryMb = 4096;
    state.config.resourceRequirements = { minMemoryGb: 3.5 };
    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({ permanent: true });
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('keeps the same persisted 4 GB plan for a request at the documented 3 GB cap', async () => {
    const rc = createContext({});
    const state = createState();
    state.config.capacityPoolSelection = capacityPoolSelection('user');
    state.config.capacityPoolSelection.candidates[0].providerInstanceMemoryMb = 4096;
    state.config.resourceRequirements = { minMemoryGb: 3 };
    await handleNodeSelection(state, rc);
    expect(state.config.capacityPoolSelection.candidates).toHaveLength(1);
  });

  it('does not reuse legacy nodes when the selected pool has no candidates', async () => {
    const rc = createContext({});
    const state = createState();
    state.config.capacityPoolSelection = {
      ...capacityPoolSelection('user'),
      candidates: [],
    };

    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({
      message:
        'No active compute pool offerings in the selected user pool satisfy the requested resources.',
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

  it.each([
    { occupiedCpuMillis: 7000, canRecover: true },
    { occupiedCpuMillis: 8000, canRecover: false },
  ])(
    'rechecks persisted warm-claim capacity with $occupiedCpuMillis occupied CPU millis',
    async ({ occupiedCpuMillis, canRecover }) => {
      const now = new Date().toISOString();
      const nodeId = 'warm-capacity-recheck';
      const runs: Array<{ sql: string; bound: unknown[] }> = [];
      const request = {
        cpuMillis: 1000,
        memoryMb: 1024,
        diskMb: 1024,
        exclusiveNode: false,
        source: 'platform' as const,
        sourceId: 'platform',
        version: 1,
      };
      const state = createState({
        config: { ...createState().config, resolvedReservation: request },
      });
      const tryClaim = vi.fn().mockResolvedValue({
        claimed: true,
        state: {
          nodeId,
          status: 'active',
          warmSince: null,
          claimedByTask: state.taskId,
        },
      });
      const taskPointerClearedAtRelease: boolean[] = [];
      const releaseClaim = vi.fn().mockImplementation(async () => {
        taskPointerClearedAtRelease.push(
          runs.some((run) => run.sql.includes('UPDATE tasks SET claimed_warm_node_id = NULL'))
        );
        return {
          released: true,
          state: { nodeId, status: 'warm', warmSince: Date.now(), claimedByTask: null },
        };
      });
      const rc = createContext({
        persistedWarmClaim: nodeId,
        persistedWarmNode: {
          ...defaultPlacementNode(nodeId),
          last_metrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
          last_heartbeat_at: now,
        },
        warmNodes: [],
        existingNodes: [],
        runs,
        workspaceReservations: [
          {
            nodeId,
            resolvedReservationJson: JSON.stringify({ ...request, cpuMillis: occupiedCpuMillis }),
          },
        ],
        healthByNode: {
          [nodeId]: {
            health_status: 'healthy',
            last_heartbeat_at: now,
            agent_ready_at: now,
            agent_version: 'current-sha',
          },
        },
      });
      rc.env.NODE_LIFECYCLE = {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ tryClaim, releaseClaim })),
      } as unknown as DurableObjectNamespace;

      await handleNodeSelection(state, rc);

      // Both cases got through identity, current authority and the lifecycle claim.
      expect(tryClaim).toHaveBeenCalledWith(state.taskId, undefined);
      if (canRecover) {
        expect(releaseClaim).not.toHaveBeenCalled();
        expect(state.stepResults).toMatchObject({
          nodeId,
          claimedWarmNodeId: nodeId,
          autoProvisioned: false,
        });
        expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
        expect(
          runs.some((run) => run.sql.includes('UPDATE tasks SET claimed_warm_node_id = NULL'))
        ).toBe(false);
      } else {
        expect(releaseClaim).toHaveBeenCalledWith(state.taskId);
        // Check outside the callback: production deliberately catches release errors.
        expect(taskPointerClearedAtRelease).toEqual([false]);
        expect(
          runs.some(
            (run) =>
              run.sql.includes('UPDATE tasks SET claimed_warm_node_id = NULL') &&
              run.bound[1] === state.taskId &&
              run.bound[2] === nodeId
          )
        ).toBe(true);
        expect(state.stepResults.nodeId).toBeNull();
        expect(state.stepResults.claimedWarmNodeId ?? null).toBeNull();
        expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
        expect(rc.advanceToStep).not.toHaveBeenCalledWith(state, 'workspace_creation');
      }
    }
  );

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
      .mockRejectedValueOnce(new SessionRecoveryAuthorityRevokedError('recovery_task_authority'));
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
      config: {
        ...createState().config,
        preferredNodeId: 'node-medium',
        vmSize: 'large',
        resolvedReservation: {
          version: 2,
          cpuMillis: 8000,
          memoryMb: 16384,
          diskMb: 163840,
          exclusiveNode: false,
          source: 'task',
          sourceId: 'task-1',
        },
      },
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

  it('rejects a preferred node whose active reservations consume its capacity', async () => {
    const state = createState({
      config: {
        ...createState().config,
        preferredNodeId: 'node-full',
        vmSize: 'small',
        resolvedReservation: {
          cpuMillis: 2000,
          memoryMb: 1024,
          diskMb: 1024,
          exclusiveNode: false,
          source: 'platform',
          sourceId: 'platform',
          version: 1,
        },
      },
    });
    const rc = createContext({
      preferredNode: {
        id: 'node-full',
        status: 'running',
        vm_size: 'small',
        agent_version: 'current-sha',
        provider_instance_type: 'cx23',
        provider_instance_vcpu_count: 2,
        provider_instance_memory_mb: 4_096,
        provider_instance_disk_gb: 40,
      },
      workspaceReservations: [
        {
          nodeId: 'node-full',
          resolvedReservationJson: JSON.stringify(state.config.resolvedReservation),
        },
      ],
    });

    await expect(handleNodeSelection(state, rc)).rejects.toMatchObject({
      message: 'Specified node lacks aggregate reservation capacity or fresh safe telemetry',
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
    const now = new Date().toISOString();
    const rc = createContext({
      existingNodes: [
        {
          id: 'node-medium',
          vm_size: 'medium',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1, diskPercent: 1 }),
          last_heartbeat_at: now,
          agent_version: 'current-sha',
        },
        {
          id: 'node-large',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1.6, memoryPercent: 20, diskPercent: 20 }),
          last_heartbeat_at: now,
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

  it('excludes the unhealthy eviction source node from normal replacement placement', async () => {
    const now = new Date().toISOString();
    const state = createState({
      config: { ...createState().config, excludedNodeId: 'node-eviction-source' },
    });
    const node = {
      vm_size: 'large',
      vm_location: 'fsn1',
      health_status: 'healthy',
      last_metrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
      last_heartbeat_at: now,
      agent_version: 'current-sha',
    };
    const rc = createContext({
      existingNodes: [
        { ...node, id: 'node-eviction-source' },
        { ...node, id: 'node-replacement' },
      ],
      healthByNode: {
        'node-replacement': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-replacement');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('spread provisions separate nodes while the explicit pool limit has room', async () => {
    const selection = capacityPoolSelection('user', { strategy: 'spread', maxNodes: 3 });
    const state = createState({
      config: { ...createState().config, capacityPoolSelection: selection },
    });
    const now = new Date().toISOString();
    const rc = createContext({
      activePoolNodeCount: 2,
      existingNodes: [
        {
          id: 'node-spread-existing',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
          last_heartbeat_at: now,
          agent_version: 'current-sha',
          ...nodeCapacityFields(selection),
        },
      ],
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBeNull();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });

  it('spread packs onto an existing node after reaching the explicit pool limit', async () => {
    const selection = capacityPoolSelection('user', { strategy: 'spread', maxNodes: 3 });
    const state = createState({
      config: { ...createState().config, capacityPoolSelection: selection },
    });
    const now = new Date().toISOString();
    const rc = createContext({
      activePoolNodeCount: 3,
      existingNodes: [
        {
          id: 'node-spread-at-limit',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
          last_heartbeat_at: now,
          agent_version: 'current-sha',
          ...nodeCapacityFields(selection),
        },
      ],
      healthByNode: {
        'node-spread-at-limit': {
          health_status: 'healthy',
          last_heartbeat_at: now,
          agent_ready_at: now,
          agent_version: 'current-sha',
        },
      },
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBe('node-spread-at-limit');
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
          source: 'task',
          sourceId: 'task-1',
          version: 1,
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
          last_metrics: JSON.stringify({ cpuLoadAvg1: 3, memoryPercent: 5, diskPercent: 5 }),
          last_heartbeat_at: now,
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
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1, diskPercent: 1 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(otherProject),
        },
        {
          id: 'node-project-1',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 3, memoryPercent: 20, diskPercent: 20 }),
          last_heartbeat_at: now,
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
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1, diskPercent: 1 }),
          last_heartbeat_at: now,
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
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1, diskPercent: 1 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(otherProject),
        },
        {
          id: 'node-project-1',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 2, diskPercent: 2 }),
          agent_version: 'current-sha',
          ...nodeCapacityFields(sameProject),
        },
        {
          id: 'node-legacy',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 3.2, memoryPercent: 40, diskPercent: 40 }),
          last_heartbeat_at: now,
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

  describe('startup backlog ranking', () => {
    // The 2026-11-08 incident: `pack` ranked the node with five queued builds first, because
    // their reservations made it look fullest, and a chat waited 17 minutes for a 3-minute setup.
    it('prefers a node with no queued builds over one with five, even under pack', async () => {
      const selection = capacityPoolSelection('user', { strategy: 'pack' });
      const state = busyBuildState({ selection });
      const rc = createContext({
        existingNodes: [
          busyBuildNode('node-queued', selection),
          busyBuildNode('node-idle', selection, { last_metrics: idleBuildMetrics() }),
        ],
        workspaceReservations: [
          ...reservationsOn('node-queued', 5, state),
          ...reservationsOn('node-idle', 1, state, 'running'),
        ],
        healthByNode: healthyAgents('node-queued', 'node-idle'),
      });

      await handleNodeSelection(state, rc);

      expect(state.stepResults.nodeId).toBe('node-idle');
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
      expect(state.stepResults.rankedStartupBacklog).toEqual({ nodeId: 'node-idle', backlog: 0 });
      expect(state.stepResults.placementDiagnostics?.hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: 'node-idle', outcome: 'selected', startupBacklog: 0 }),
          expect.objectContaining({
            nodeId: 'node-queued',
            outcome: 'rejected',
            startupBacklog: 5,
            reasons: ['Another eligible host ranked higher'],
          }),
        ])
      );
    });

    it('prefers one queued build over five', async () => {
      const selection = capacityPoolSelection('user', { strategy: 'pack' });
      const state = busyBuildState({ selection });
      const rc = createContext({
        existingNodes: [
          busyBuildNode('node-five', selection),
          busyBuildNode('node-one', selection),
        ],
        workspaceReservations: [
          ...reservationsOn('node-five', 5, state),
          ...reservationsOn('node-one', 1, state),
        ],
        healthByNode: healthyAgents('node-five', 'node-one'),
      });

      await handleNodeSelection(state, rc);

      expect(state.stepResults.nodeId).toBe('node-one');
      expect(state.stepResults.rankedStartupBacklog).toEqual({ nodeId: 'node-one', backlog: 1 });
    });

    it('prefers an idle node over one with a single active build and no waiters', async () => {
      const selection = capacityPoolSelection('user', { strategy: 'pack' });
      const state = busyBuildState({ selection });
      const rc = createContext({
        existingNodes: [
          busyBuildNode('node-building', selection),
          busyBuildNode('node-idle', selection, { last_metrics: idleBuildMetrics() }),
        ],
        // pack alone would pick node-building: it carries more reservations.
        workspaceReservations: [
          ...reservationsOn('node-building', 1, state),
          ...reservationsOn('node-building', 2, state, 'running'),
          ...reservationsOn('node-idle', 1, state, 'running'),
        ],
        healthByNode: healthyAgents('node-building', 'node-idle'),
      });

      await handleNodeSelection(state, rc);

      expect(state.stepResults.nodeId).toBe('node-idle');
    });

    it('leaves equal backlogs to the pool strategy', async () => {
      const selection = capacityPoolSelection('user', { strategy: 'pack' });
      const state = busyBuildState({ selection });
      const rc = createContext({
        existingNodes: [
          busyBuildNode('node-light', selection, { last_metrics: idleBuildMetrics() }),
          busyBuildNode('node-full', selection, { last_metrics: idleBuildMetrics() }),
        ],
        workspaceReservations: [
          ...reservationsOn('node-light', 1, state, 'running'),
          ...reservationsOn('node-full', 4, state, 'running'),
        ],
        healthByNode: healthyAgents('node-light', 'node-full'),
      });

      await handleNodeSelection(state, rc);

      // pack: highest projected utilization first.
      expect(state.stepResults.nodeId).toBe('node-full');
    });

    it.each([
      { label: 'first human conversation', taskMode: 'conversation', resume: false },
      { label: 'automated task', taskMode: 'task', resume: false },
      { label: 'conversation wake', taskMode: 'conversation', resume: true },
    ] as const)(
      'places a $label on the shortest queue when every node is building, without waiting or provisioning',
      async ({ taskMode, resume }) => {
        const selection = capacityPoolSelection('user');
        const state = busyBuildState({ selection });
        state.config.taskMode = taskMode;
        state.config.resumeSnapshotChatSessionId = resume ? 'sleeping-chat' : null;
        const rc = createContext({
          existingNodes: [
            busyBuildNode('node-three', selection),
            busyBuildNode('node-one', selection),
          ],
          // balanced alone would pick node-three: node-one carries more reservations in total.
          workspaceReservations: [
            ...reservationsOn('node-three', 3, state),
            ...reservationsOn('node-one', 1, state),
            ...reservationsOn('node-one', 3, state, 'running'),
          ],
          healthByNode: healthyAgents('node-three', 'node-one'),
        });

        await handleNodeSelection(state, rc);

        expect(state.stepResults.nodeId).toBe('node-one');
        expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
        expect(rc.advanceToStep).not.toHaveBeenCalledWith(state, 'node_provisioning');
        expect(admissionMocks.waitForVmAdmissionCapacity).not.toHaveBeenCalled();
        expect(rc.updateD1ExecutionStep).not.toHaveBeenCalledWith(
          state.taskId,
          'waiting_for_node_capacity'
        );
      }
    );

    it('queues on the only eligible node while it builds, with no backlog guard', async () => {
      const selection = capacityPoolSelection('user', {
        machineSize: 'small',
        providerInstanceType: 'cx23',
        vcpuCount: 2,
        memoryMb: 4_096,
        diskGb: 40,
      });
      const state = busyBuildState({ selection });
      const rc = createContext({
        existingNodes: [busyBuildNode('node-building-only', selection)],
        workspaceReservations: reservationsOn('node-building-only', 1, state),
        healthByNode: healthyAgents('node-building-only'),
      });

      await handleNodeSelection(state, rc);

      expect(state.stepResults.nodeId).toBe('node-building-only');
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
      expect(admissionMocks.waitForVmAdmissionCapacity).not.toHaveBeenCalled();
      // No alternative node, so a growing queue is no reason to refuse the reservation.
      expect(state.stepResults.rankedStartupBacklog).toBeNull();
    });

    it('keeps an explicit pin on its node however long that node\'s queue is, with no guard', async () => {
      const selection = capacityPoolSelection('user');
      const state = busyBuildState({ selection });
      state.config.preferredNodeId = 'node-pinned';
      const rc = createContext({
        preferredNode: { ...busyBuildNode('node-pinned', selection), status: 'running' },
        existingNodes: [
          busyBuildNode('node-idle', selection, { last_metrics: idleBuildMetrics() }),
        ],
        workspaceReservations: reservationsOn('node-pinned', 4, state),
        healthByNode: healthyAgents('node-pinned', 'node-idle'),
      });

      await handleNodeSelection(state, rc);

      expect(state.stepResults.nodeId).toBe('node-pinned');
      expect(state.stepResults.rankedStartupBacklog).toBeNull();
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
    });

    it('lets a task parked under the old busy-build wait place on its next selection', async () => {
      const state = busyBuildState();
      const selection = state.config.capacityPoolSelection!;
      state.stepResults.placementDiagnostics = {
        version: 1,
        decidedAt: '2026-11-08T22:30:00.000Z',
        requested: null,
        hosts: [],
        selectedNodeId: null,
        attempts: [],
        queue: {
          state: 'waiting',
          reason: 'compatible_node_building_workspace',
          nextRetryAt: '2026-11-08T22:30:15.000Z',
          waitDeadlineAt: '2026-11-08T22:50:00.000Z',
          attemptCount: 3,
        },
        notes: [],
      } as unknown as NonNullable<TaskRunnerState['stepResults']['placementDiagnostics']>;
      const rc = createContext({
        existingNodes: [busyBuildNode('node-still-building', selection)],
        workspaceReservations: reservationsOn('node-still-building', 2, state),
        healthByNode: healthyAgents('node-still-building'),
      });

      await handleNodeSelection(state, rc);

      expect(state.stepResults.nodeId).toBe('node-still-building');
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
    });

    it.each([
      {
        label: 'stale telemetry',
        overrides: { last_heartbeat_at: '2026-09-11T11:00:00.000Z' },
        reason: 'node telemetry is stale',
      },
      {
        label: 'disk pressure',
        overrides: { last_metrics: busyBuildMetrics({ creatingWorkspaces: 0, diskPercent: 85 }) },
        reason: 'disk pressure threshold reached',
      },
      {
        label: 'measured memory overrun',
        overrides: { last_metrics: busyBuildMetrics({ creatingWorkspaces: 0, memoryPercent: 99 }) },
        reason: 'measured memory use above the host reserve leaves no room for this reservation',
      },
      {
        label: 'an incompatible agent',
        overrides: { agent_version: 'old-sha' },
        reason: 'Host agent version is incompatible',
      },
    ])(
      'never trades safety for a shorter queue: excludes an idle node with $label',
      async ({ overrides, reason }) => {
        const selection = capacityPoolSelection('user');
        const state = busyBuildState({ selection });
        const rc = createContext({
          existingNodes: [
            busyBuildNode('node-unsafe-idle', selection, overrides),
            busyBuildNode('node-safe-queued', selection),
          ],
          workspaceReservations: reservationsOn('node-safe-queued', 4, state),
          healthByNode: healthyAgents('node-unsafe-idle', 'node-safe-queued'),
        });

        await handleNodeSelection(state, rc);

        expect(state.stepResults.nodeId).toBe('node-safe-queued');
        // The unsafe node was the only alternative and was excluded, so no guard applies.
        expect(state.stepResults.rankedStartupBacklog).toBeNull();
        expect(state.stepResults.placementDiagnostics?.hosts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              nodeId: 'node-unsafe-idle',
              outcome: 'rejected',
              reasons: expect.arrayContaining([reason]),
            }),
          ])
        );
      }
    );

    it.each([
      { label: 'explicit', explicitVmLocation: true, expected: 'node-requested-region' },
      { label: 'legacy (flag absent)', explicitVmLocation: undefined, expected: 'node-requested-region' },
      { label: 'default', explicitVmLocation: false, expected: 'node-other-region' },
    ])(
      'ranks a $label location against backlog',
      async ({ explicitVmLocation, expected }) => {
        // A pool spanning two regions: either node is inside its authority.
        const selection = capacityPoolSelection('user');
        const [fsn1Candidate] = selection.candidates;
        const nbg1Candidate = {
          ...fsn1Candidate,
          id: 'candidate-user-nbg1',
          location: 'nbg1',
          snapshot: { ...fsn1Candidate.snapshot, capacityPoolCandidateId: 'candidate-user-nbg1' },
        };
        selection.candidates.push(nbg1Candidate);
        const state = busyBuildState({ selection });
        state.config.vmLocation = 'fsn1';
        if (explicitVmLocation === undefined) delete state.config.explicitVmLocation;
        else state.config.explicitVmLocation = explicitVmLocation;
        const rc = createContext({
          existingNodes: [
            busyBuildNode('node-requested-region', selection, { vm_location: 'fsn1' }),
            busyBuildNode('node-other-region', selection, {
              vm_location: 'nbg1',
              capacity_pool_candidate_id: nbg1Candidate.id,
              last_metrics: idleBuildMetrics(),
            }),
          ],
          workspaceReservations: reservationsOn('node-requested-region', 2, state),
          healthByNode: healthyAgents('node-requested-region', 'node-other-region'),
        });

        await handleNodeSelection(state, rc);

        expect(state.stepResults.nodeId).toBe(expected);
      }
    );

    it('does not let the warm shortcut take a warm-flagged node that already has a start queued', async () => {
      const now = new Date().toISOString();
      const state = createState();
      const tryClaim = vi.fn().mockResolvedValue({
        claimed: true,
        state: { nodeId: 'warm-raced', status: 'active', warmSince: null, claimedByTask: state.taskId },
      });
      const metrics = idleBuildMetrics();
      const rc = createContext({
        // An ordinary placement reserved onto this node before NodeLifecycle cleared warm_since.
        warmNodes: [
          {
            id: 'warm-raced',
            vm_size: 'large',
            vm_location: 'fsn1',
            agent_version: 'current-sha',
          },
        ],
        freshWarmNode: { status: 'running', warm_since: now, agent_version: 'current-sha' },
        existingNodes: [
          {
            id: 'warm-raced',
            vm_size: 'large',
            vm_location: 'fsn1',
            health_status: 'healthy',
            last_metrics: busyBuildMetrics(),
            last_heartbeat_at: now,
            agent_version: 'current-sha',
          },
          {
            id: 'node-idle',
            vm_size: 'large',
            vm_location: 'fsn1',
            health_status: 'healthy',
            last_metrics: metrics,
            last_heartbeat_at: now,
            agent_version: 'current-sha',
          },
        ],
        workspaceReservations: [
          {
            nodeId: 'warm-raced',
            resolvedReservationJson: JSON.stringify({
              cpuMillis: 500,
              memoryMb: 1_024,
              diskMb: 1_024,
              exclusiveNode: false,
              source: 'task',
              sourceId: 'other-task',
              version: 1,
            }),
            status: 'creating',
          },
        ],
        healthByNode: healthyAgents('warm-raced', 'node-idle'),
      });
      rc.env.NODE_LIFECYCLE = {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ tryClaim, releaseClaim: vi.fn() })),
      } as unknown as DurableObjectNamespace;

      await handleNodeSelection(state, rc);

      expect(tryClaim).not.toHaveBeenCalled();
      expect(state.stepResults.nodeId).toBe('node-idle');
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
    });
  });

  it('keeps aggregate resource rejection for a first human conversation on a building host', async () => {
    const selection = capacityPoolSelection('user', {
      machineSize: 'small',
      providerInstanceType: 'cx23',
      vcpuCount: 2,
      memoryMb: 4096,
      diskGb: 40,
    });
    const state = busyBuildState({ cpuMillis: 1500, selection });
    state.config.taskMode = 'conversation';
    const rc = createContext({
      existingNodes: [busyBuildNode('node-building-full', selection)],
      workspaceReservations: [
        {
          nodeId: 'node-building-full',
          resolvedReservationJson: JSON.stringify({
            ...state.config.resolvedReservation,
            cpuMillis: 1000,
          }),
          status: 'creating',
        },
      ],
    });

    await handleNodeSelection(state, rc);

    expect(state.stepResults.nodeId).toBeNull();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
    expect(state.stepResults.placementDiagnostics?.hosts[0]).toMatchObject({
      outcome: 'rejected',
      reasons: expect.arrayContaining(['CPU share budget would be exceeded']),
    });
  });

  it('treats stale telemetry on a building node as stale', async () => {
    const state = busyBuildState();
    const selection = state.config.capacityPoolSelection!;
    const rc = createContext({
      existingNodes: [
        busyBuildNode('node-building-stale', selection, {
          last_heartbeat_at: '2026-09-11T11:00:00.000Z',
        }),
      ],
    });

    await handleNodeSelection(state, rc);

    expect(admissionMocks.waitForVmAdmissionCapacity).not.toHaveBeenCalled();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
    expect(state.stepResults.placementDiagnostics?.hosts[0]).toMatchObject({
      outcome: 'rejected',
      reasons: ['node telemetry is stale'],
    });
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
          last_metrics: JSON.stringify({ cpuLoadAvg1: 1, memoryPercent: 1, diskPercent: 1 }),
          agent_version: 'old-sha',
        },
        {
          id: 'node-current',
          vm_size: 'large',
          vm_location: 'fsn1',
          health_status: 'healthy',
          last_metrics: JSON.stringify({ cpuLoadAvg1: 3.2, memoryPercent: 40, diskPercent: 40 }),
          last_heartbeat_at: now,
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
