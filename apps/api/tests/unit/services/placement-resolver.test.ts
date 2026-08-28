import { describe, expect, it } from 'vitest';

import type {
  PlacementProfileDefaults,
  PlacementProjectDefaults,
} from '../../../src/services/placement-resolver';
import {
  PlacementResolutionError,
  resolveEffectivePlacementRuntime,
  resolvePlacementCredentialAttribution,
  resolveTaskStartPlacement,
} from '../../../src/services/placement-resolver';

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
