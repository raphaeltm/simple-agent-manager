import { describe, expect, it } from 'vitest';

import type {
  PlacementProfileDefaults,
  PlacementProjectDefaults,
  TaskStartCapacityPoolSelection,
} from '../../../src/services/placement-resolver';
import {
  PlacementResolutionError,
  resolveEffectivePlacementRuntime,
  resolvePlacementCredentialAttribution,
  resolveReusableNodeCapacitySnapshot,
  resolveTaskStartPlacement,
} from '../../../src/services/placement-resolver';

function reservation(overrides: Partial<ReturnType<typeof resolveTaskStartPlacement>['resolvedReservation']> = {}) {
  return {
    cpuMillis: 2000,
    memoryMb: 4096,
    diskMb: 20 * 1024,
    exclusiveNode: false,
    maxCoTenants: 1,
    source: 'platform' as const,
    sourceId: 'platform',
    ...overrides,
  };
}

function capacitySelection(
  overrides: {
    candidateId?: string;
    providerInstanceType?: string;
    machineSize?: 'small' | 'medium' | 'large' | null;
    vcpuCount?: number;
    memoryMb?: number;
    diskGb?: number | null;
  } = {}
): TaskStartCapacityPoolSelection {
  const providerInstanceType = overrides.providerInstanceType ?? 'cx32';
  const machineSize = overrides.machineSize ?? 'large';
  const snapshot = {
    capacityPoolId: 'pool-user',
    capacityPoolScope: 'user' as const,
    capacityPoolRevision: 4,
    capacitySourceId: 'source-user',
    capacityPoolCandidateId: overrides.candidateId ?? 'candidate-cx32',
    placementCredentialSource: 'user' as const,
    placementCredentialReference: 'credentials:user-hetzner',
    placementCredentialVersion: 1700000000000,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
    providerInstanceType,
    providerInstanceVcpuCount: overrides.vcpuCount ?? 8,
    providerInstanceMemoryMb: overrides.memoryMb ?? 16 * 1024,
    providerInstanceDiskGb: overrides.diskGb ?? 160,
    providerInstancePriceDisplay: '€18.49/mo',
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: 1849,
    providerInstancePriceHourlyMicros: 25329,
    placementExplanationJson: '{"kind":"capacity_pool_default"}',
  };
  return {
    poolId: 'pool-user',
    scope: 'user',
    revision: 4,
    strategy: 'balanced',
    capacityPoolProjectId: null,
    workloadRole: 'workspace',
    poolSnapshot: { ...snapshot, capacitySourceId: null, capacityPoolCandidateId: null },
    candidates: [
      {
        id: snapshot.capacityPoolCandidateId,
        poolId: 'pool-user',
        capacitySourceId: 'source-user',
        provider: 'hetzner',
        location: 'fsn1',
        workloadRole: 'workspace',
        runtime: 'vm',
        machineClass: 'shared-vm',
        machineSize,
        providerInstanceType,
        providerInstanceVcpuCount: snapshot.providerInstanceVcpuCount,
        providerInstanceMemoryMb: snapshot.providerInstanceMemoryMb,
        providerInstanceDiskGb: snapshot.providerInstanceDiskGb,
        providerInstancePriceDisplay: snapshot.providerInstancePriceDisplay,
        providerInstancePriceCurrency: snapshot.providerInstancePriceCurrency,
        providerInstancePriceMonthlyCents: snapshot.providerInstancePriceMonthlyCents,
        providerInstancePriceHourlyMicros: snapshot.providerInstancePriceHourlyMicros,
        priority: 0,
        candidateOrder: 0,
        credentialAttributionSource: 'user',
        placementCredentialSource: 'user',
        placementCredentialReference: snapshot.placementCredentialReference,
        placementCredentialVersion: snapshot.placementCredentialVersion,
        capacityPoolProjectId: null,
        snapshot,
      },
    ],
  };
}

const PROJECT: PlacementProjectDefaults = {
  id: 'project-1',
  defaultVmSize: 'medium',
  defaultProvider: 'hetzner',
  defaultLocation: 'hel1',
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: 'web',
  defaultAgentType: 'openai-codex',
};

const PROFILE: PlacementProfileDefaults = {
  profileId: 'profile-1',
  skillId: 'skill-1',
  agentType: 'claude-code',
  vmSizeOverride: 'large',
  provider: 'digitalocean',
  vmLocation: 'nyc1',
  workspaceProfile: 'lightweight',
  runtime: null,
  devcontainerConfigName: 'profile-devcontainer',
  taskMode: null,
  resourceRequirementsJson: '{"minMemoryGb":16}',
};

describe('placement resolver parity', () => {
  it('matches task submit precedence and inherited parent credential attribution', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'task-submit-1',
      projectId: PROJECT.id,
      userId: 'submit-user',
      project: PROJECT,
      profile: PROFILE,
      explicit: {
        vmSize: 'small',
        vmSizeSource: 'task',
        provider: 'scaleway',
        vmLocation: 'fr-par-1',
        workspaceProfile: 'full',
        devcontainerConfigName: 'api',
        taskMode: 'conversation',
        agentType: 'openai-codex',
      },
      inheritedCredentialAttribution: {
        userId: 'parent-attribution-user',
        projectId: PROJECT.id,
        source: 'project',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'workspace-profile',
      resourceRequirements: {
        task: { minVcpu: 4 },
        skill: { minMemoryGb: 16 },
      },
    });

    expect(placement).toMatchObject({
      vmSize: 'small',
      vmSizeSource: 'task',
      provider: 'scaleway',
      vmLocation: 'fr-par-1',
      workspaceProfile: 'full',
      devcontainerConfigName: 'api',
      taskMode: 'conversation',
      agentType: 'openai-codex',
      credentialLookup: {
        userId: 'parent-attribution-user',
        projectId: PROJECT.id,
        provider: 'scaleway',
      },
      runtime: {
        requestedRuntime: null,
        executionRuntime: 'vm',
        isInstantRuntime: false,
        reason: 'vm-only',
      },
    });
    expect(placement.resolvedReservation).toMatchObject({
      cpuMillis: 4000,
      memoryMb: 16 * 1024,
      source: 'task',
      sourceId: 'task-submit-1',
    });

    expect(
      resolvePlacementCredentialAttribution(placement, {
        credentialSource: 'project',
        providerName: 'hetzner',
      })
    ).toEqual({
      effectiveProvider: 'scaleway',
      credentialAttributionUserId: 'parent-attribution-user',
      credentialAttributionProjectId: PROJECT.id,
      credentialAttributionSource: 'project',
    });
  });

  it('matches MCP dispatch explicit/profile cf-container runtime gating', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'mcp-dispatch',
      taskId: 'mcp-child-1',
      projectId: PROJECT.id,
      userId: 'dispatching-user',
      project: PROJECT,
      profile: {
        ...PROFILE,
        provider: 'hetzner',
        vmLocation: 'nyc1',
        runtime: 'cf-container',
      },
      explicit: {
        workspaceProfile: 'lightweight',
      },
      inheritedCredentialAttribution: {
        userId: 'root-attribution-user',
        projectId: null,
        source: 'platform',
      },
      credentialProjectPolicy: 'inherited-or-none',
      taskModeDefault: 'task',
      resourceRequirements: {
        skill: { minVcpu: 8 },
      },
      runtimeDecision: {
        runtime: 'cf-container',
        reason: 'explicit-cf-container',
      },
    });

    expect(placement).toMatchObject({
      vmSize: 'large',
      vmSizeSource: 'agent-profile',
      provider: 'hetzner',
      vmLocation: 'nyc1',
      workspaceProfile: 'lightweight',
      devcontainerConfigName: null,
      taskMode: 'task',
      agentType: 'claude-code',
      credentialLookup: {
        userId: 'root-attribution-user',
        projectId: null,
        provider: 'hetzner',
      },
      runtime: {
        requestedRuntime: 'cf-container',
        executionRuntime: 'cf-container',
        isInstantRuntime: true,
        reason: 'explicit-cf-container',
      },
    });
  });

  it('keeps zero-config runtime decisions on the existing VM dispatch policy', () => {
    expect(
      resolveEffectivePlacementRuntime({
        requestedRuntime: null,
        runtimeDecision: { runtime: 'cf-container', reason: 'zero-config' },
      })
    ).toMatchObject({
      executionRuntime: 'vm',
      isInstantRuntime: false,
      reason: 'zero-config',
    });
  });

  it('can preserve retry-subtask skill attribution for profile VM-size overrides', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'retry-subtask',
      taskId: 'retry-subtask-1',
      projectId: PROJECT.id,
      userId: 'retry-user',
      project: {
        ...PROJECT,
        defaultVmSize: 'small',
      },
      profile: PROFILE,
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      profileVmSizeSource: 'skill',
      resourceRequirements: {},
    });

    expect(placement).toMatchObject({
      vmSize: 'large',
      vmSizeSource: 'skill',
    });
  });

  it('matches SAM-session dispatch defaults without inferring conversation mode from lightweight', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'sam-session-dispatch',
      taskId: 'sam-dispatch-1',
      projectId: PROJECT.id,
      userId: 'sam-user',
      project: {
        ...PROJECT,
        defaultProvider: 'scaleway',
        defaultLocation: 'fr-par-2',
      },
      profile: null,
      explicit: {
        workspaceProfile: 'lightweight',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });

    expect(placement).toMatchObject({
      vmSize: 'medium',
      vmSizeSource: 'project',
      provider: 'scaleway',
      vmLocation: 'fr-par-2',
      workspaceProfile: 'lightweight',
      devcontainerConfigName: null,
      taskMode: 'task',
      agentType: 'openai-codex',
      credentialLookup: {
        userId: 'sam-user',
        projectId: PROJECT.id,
        provider: 'scaleway',
      },
    });

    expect(
      resolvePlacementCredentialAttribution(placement, {
        credentialSource: 'platform',
        providerName: 'scaleway',
      })
    ).toEqual({
      effectiveProvider: 'scaleway',
      credentialAttributionUserId: 'sam-user',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'platform',
    });
  });

  it('matches trigger submit precedence and trigger reservation source IDs', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'trigger-submit',
      taskId: 'trigger-task-1',
      triggerId: 'trigger-1',
      projectId: PROJECT.id,
      userId: 'trigger-owner',
      project: PROJECT,
      profile: {
        ...PROFILE,
        provider: 'gcp',
        vmLocation: 'us-east1-b',
        workspaceProfile: 'full',
        taskMode: 'task',
        devcontainerConfigName: 'profile-devcontainer',
      },
      explicit: {
        vmSize: 'small',
        vmSizeSource: 'trigger',
        taskMode: 'conversation',
      },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'workspace-profile',
      resourceRequirements: {
        trigger: { minDiskGb: 100 },
        skill: { minVcpu: 8 },
      },
    });

    expect(placement).toMatchObject({
      vmSize: 'small',
      vmSizeSource: 'trigger',
      provider: 'gcp',
      vmLocation: 'us-east1-b',
      workspaceProfile: 'full',
      devcontainerConfigName: 'profile-devcontainer',
      taskMode: 'conversation',
      agentType: 'claude-code',
      credentialLookup: {
        userId: 'trigger-owner',
        projectId: PROJECT.id,
        provider: 'gcp',
      },
    });
    expect(placement.resolvedReservation).toMatchObject({
      cpuMillis: 8000,
      diskMb: 100 * 1024,
      source: 'trigger',
      sourceId: 'trigger-1',
    });
  });

  it('matches task-run caller-scope placement and keeps lightweight runs in task mode', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-run',
      taskId: 'ready-task-1',
      projectId: PROJECT.id,
      userId: 'runner-user',
      project: {
        ...PROJECT,
        defaultVmSize: null,
        defaultProvider: 'hetzner',
        defaultLocation: 'hel1',
      },
      explicit: {
        vmSize: 'small',
        vmSizeSource: 'task',
        vmLocation: 'nbg1',
        workspaceProfile: 'lightweight',
        devcontainerConfigName: 'ignored-for-lightweight',
      },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });

    expect(placement).toMatchObject({
      vmSize: 'small',
      vmSizeSource: 'task',
      provider: 'hetzner',
      vmLocation: 'nbg1',
      workspaceProfile: 'lightweight',
      devcontainerConfigName: null,
      taskMode: 'task',
      credentialLookup: {
        userId: 'runner-user',
        projectId: PROJECT.id,
        provider: 'hetzner',
      },
    });

    expect(
      resolvePlacementCredentialAttribution(placement, {
        credentialSource: 'platform',
        providerName: 'hetzner',
      })
    ).toEqual({
      effectiveProvider: 'hetzner',
      credentialAttributionUserId: 'runner-user',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'platform',
    });
  });

  it('matches orchestration retry inheritance from the retried child task', () => {
    const placement = resolveTaskStartPlacement({
      entryPoint: 'orchestration-retry',
      taskId: 'replacement-task-1',
      projectId: PROJECT.id,
      userId: 'parent-agent-user',
      project: {
        ...PROJECT,
        defaultVmSize: 'small',
        defaultProvider: 'hetzner',
        defaultLocation: 'hel1',
        defaultWorkspaceProfile: 'full',
      },
      inheritedCredentialAttribution: {
        userId: 'child-attribution-user',
        projectId: PROJECT.id,
        source: 'project',
      },
      credentialProjectPolicy: 'inherited-or-none',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });

    expect(placement).toMatchObject({
      vmSize: 'small',
      vmSizeSource: 'project',
      provider: 'hetzner',
      vmLocation: 'hel1',
      workspaceProfile: 'full',
      taskMode: 'task',
      agentType: 'openai-codex',
      credentialLookup: {
        userId: 'child-attribution-user',
        projectId: PROJECT.id,
        provider: 'hetzner',
      },
    });

    expect(
      resolvePlacementCredentialAttribution(placement, {
        credentialSource: 'user',
        providerName: 'hetzner',
      })
    ).toEqual({
      effectiveProvider: 'hetzner',
      credentialAttributionUserId: 'child-attribution-user',
      credentialAttributionProjectId: PROJECT.id,
      credentialAttributionSource: 'project',
    });
  });

  it('rejects an invalid explicit provider at the resolver boundary', () => {
    expect(() =>
      resolveTaskStartPlacement({
        entryPoint: 'task-submit',
        taskId: 'bad-provider-task',
        projectId: PROJECT.id,
        userId: 'submit-user',
        project: PROJECT,
        explicit: {
          provider: 'linode',
        },
        credentialProjectPolicy: 'current-project',
        taskModeDefault: 'workspace-profile',
        resourceRequirements: {},
      })
    ).toThrow(PlacementResolutionError);
  });

  it('rejects a provider/location mismatch when VM location validation applies', () => {
    expect(() =>
      resolveTaskStartPlacement({
        entryPoint: 'task-submit',
        taskId: 'bad-location-task',
        projectId: PROJECT.id,
        userId: 'submit-user',
        project: PROJECT,
        explicit: {
          provider: 'hetzner',
          vmLocation: 'fr-par-1',
        },
        credentialProjectPolicy: 'current-project',
        taskModeDefault: 'workspace-profile',
        resourceRequirements: {},
      })
    ).toThrow(PlacementResolutionError);
  });
});

describe('capacity-aware reusable node resolution', () => {
  it('matches concrete instance identity and normalized node resources before legacy vmSize', () => {
    const selection = capacitySelection({
      providerInstanceType: 'ccx13',
      machineSize: 'small',
      vcpuCount: 8,
      memoryMb: 16 * 1024,
    });

    const snapshot = resolveReusableNodeCapacitySnapshot({
      selection,
      projectId: 'project-1',
      requestedVmSize: 'large',
      requestedReservation: reservation({ cpuMillis: 6000, memoryMb: 12 * 1024 }),
      node: {
        vmSize: 'small',
        vmLocation: 'fsn1',
        cloudProvider: 'hetzner',
        capacityPoolId: 'pool-user',
        capacityPoolScope: 'user',
        capacityPoolRevision: 2,
        capacitySourceId: 'source-user',
        capacityPoolCandidateId: 'candidate-cx32',
        placementCredentialSource: 'user',
        placementCredentialReference: 'credentials:user-hetzner',
        placementCredentialVersion: 1700000000000,
        capacityPoolProjectId: null,
        workloadRole: 'workspace',
        providerInstanceType: 'ccx13',
        providerInstanceVcpuCount: 8,
        providerInstanceMemoryMb: 16 * 1024,
        providerInstanceDiskGb: 160,
      },
    });

    expect(snapshot).toMatchObject({
      capacityPoolCandidateId: 'candidate-cx32',
      providerInstanceType: 'ccx13',
      providerInstanceVcpuCount: 8,
      providerInstanceMemoryMb: 16 * 1024,
    });
  });

  it('preserves legacy vm_size compatibility for nodes without concrete offering metadata', () => {
    const selection = capacitySelection({
      providerInstanceType: 'cx23',
      machineSize: 'medium',
      vcpuCount: 2,
      memoryMb: 4 * 1024,
    });

    const snapshot = resolveReusableNodeCapacitySnapshot({
      selection,
      projectId: 'project-1',
      requestedVmSize: 'medium',
      requestedReservation: reservation({ cpuMillis: 2000, memoryMb: 4 * 1024 }),
      node: {
        vmSize: 'large',
        vmLocation: 'fsn1',
        cloudProvider: 'hetzner',
        capacityPoolId: 'pool-user',
        capacityPoolScope: 'user',
        capacityPoolRevision: 2,
        capacitySourceId: 'source-user',
        capacityPoolCandidateId: null,
        capacityPoolProjectId: null,
        workloadRole: 'workspace',
      },
    });

    expect(snapshot).toMatchObject({
      capacityPoolCandidateId: 'candidate-cx32',
      providerInstanceType: 'cx23',
    });
  });

  it('does not fall back to legacy vm_size reuse when the selected pool has no candidates', () => {
    const selection = {
      ...capacitySelection({
        providerInstanceType: 'cx23',
        machineSize: 'medium',
        vcpuCount: 2,
        memoryMb: 4 * 1024,
      }),
      candidates: [],
    };

    const snapshot = resolveReusableNodeCapacitySnapshot({
      selection,
      projectId: 'project-1',
      requestedVmSize: 'medium',
      requestedReservation: reservation({ cpuMillis: 2000, memoryMb: 4 * 1024 }),
      node: {
        vmSize: 'large',
        vmLocation: 'fsn1',
        cloudProvider: 'hetzner',
        capacityPoolId: null,
        capacityPoolScope: null,
        capacitySourceId: null,
        capacityPoolProjectId: null,
        workloadRole: null,
      },
    });

    expect(snapshot).toBeUndefined();
  });

  it('excludes nodes whose historical concrete candidate is no longer active so they drain naturally', () => {
    const selection = capacitySelection({
      candidateId: 'candidate-current',
      providerInstanceType: 'cx23',
      machineSize: 'medium',
      vcpuCount: 2,
      memoryMb: 4 * 1024,
    });

    const snapshot = resolveReusableNodeCapacitySnapshot({
      selection,
      projectId: 'project-1',
      requestedVmSize: 'medium',
      requestedReservation: reservation({ cpuMillis: 2000, memoryMb: 4 * 1024 }),
      node: {
        vmSize: 'medium',
        vmLocation: 'fsn1',
        cloudProvider: 'hetzner',
        capacityPoolId: 'pool-user',
        capacityPoolScope: 'user',
        capacityPoolRevision: 2,
        capacitySourceId: 'source-user',
        capacityPoolCandidateId: 'candidate-removed',
        capacityPoolProjectId: null,
        workloadRole: 'workspace',
        providerInstanceType: 'cx22',
        providerInstanceVcpuCount: 2,
        providerInstanceMemoryMb: 4 * 1024,
        providerInstanceDiskGb: 40,
      },
    });

    expect(snapshot).toBeUndefined();
  });
});
