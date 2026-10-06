import type {
  AgentProfileRuntime,
  CredentialSource,
  ResourceRequirementsSource,
  VMSize,
} from '@simple-agent-manager/shared';
import {
  LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveCapacityPoolPlacementSettings } from './capacity-pool-placement-settings';
import { resolveEffectiveDefaultCapacityPoolSummary } from './default-capacity-pools';
import { preferCapacityCandidatesInLocation } from './placement-capacity-ranking';
import {
  normalizeCredentialAttribution,
  resolveCredentialLookup,
  resolveDevcontainerConfigName,
  resolvePreferredVmLocation,
  resolveProvider,
  resolveTaskMode,
  resolveVmLocation,
  resolveVmSize,
  resolveVmSizeSource,
  resolveWorkloadRole,
  resolveWorkspaceProfile,
  validateResolvedLocation,
} from './placement-field-resolution';
import {
  noEligibleCapacityCandidateMessage,
  PlacementResolutionError,
} from './placement-resolution-error';
import {
  buildCapacityPoolSelection,
  capacityPlacementSnapshotForTaskStart,
  directPlacementAuditSnapshot,
  hasNoCapacityPoolCandidates,
} from './placement-resolver-capacity';
import type {
  PlacementCredentialAttribution,
  PlacementCredentialLookup,
  PlacementCredentialSourceResult,
  PlacementProfileDefaults,
  PlacementRuntimeResolution,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
  TaskStartPlacementInput,
  TaskStartPlacementWithCredential,
} from './placement-resolver-types';
import { resolveCredentialSource } from './provider-credentials';
import {
  collectStoredResourceRequirementLayers,
  mergeResourceRequirementLayers,
  ResourceRequirementsValidationError,
} from './resource-requirements-input';
import { resolveEffectiveNodeHostMemoryReserveMb } from './workspace-resource-capacity';
import type { WorkspaceRuntimeDecision } from './workspace-runtime';

export type { RankCapacityCandidatesInput } from './placement-resolver-capacity';
export {
  capacityPlacementSnapshotForCandidate,
  capacityPlacementSnapshotForTaskStart,
  capacityPoolNoCandidatesError,
  capacityPoolNoCandidatesMessage,
  capacityPoolSnapshotForPool,
  directPlacementAuditSnapshot,
  hasNoCapacityPoolCandidates,
  rankCapacityCandidatesForRuntime,
  resolveReusableNodeCapacitySnapshot,
} from './placement-resolver-capacity';
export type {
  CapacityAwareNodePlacementRow,
  PlacementCredentialAttribution,
  PlacementCredentialAttributionInput,
  PlacementCredentialLookup,
  PlacementCredentialProjectPolicy,
  PlacementCredentialSourceResult,
  PlacementEntryPoint,
  PlacementExplicitOverrides,
  PlacementProfileDefaults,
  PlacementProfileVmSizeSource,
  PlacementProjectDefaults,
  PlacementResolutionErrorCode,
  PlacementRuntimeResolution,
  PlacementTaskModeDefault,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
  TaskStartPlacementInput,
  TaskStartPlacementWithCredential,
} from './placement-resolver-types';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export { PlacementResolutionError } from './placement-resolution-error';

export function resolvePlacementRuntimePreference(input: {
  explicitRuntime?: AgentProfileRuntime | null;
  profile?: PlacementProfileDefaults | null;
}): AgentProfileRuntime | null {
  return input.explicitRuntime ?? input.profile?.runtime ?? null;
}

export function resolveEffectivePlacementRuntime(input: {
  requestedRuntime: AgentProfileRuntime | null;
  runtimeDecision?: WorkspaceRuntimeDecision | null;
}): PlacementRuntimeResolution {
  const decision = input.runtimeDecision ?? null;
  const isInstantRuntime = decision?.reason === 'explicit-cf-container';

  return {
    requestedRuntime: input.requestedRuntime,
    decision,
    executionRuntime: isInstantRuntime ? 'cf-container' : 'vm',
    isInstantRuntime,
    reason: decision?.reason ?? 'vm-only',
  };
}

function resolvePlacementReservation(
  input: TaskStartPlacementInput,
  vmSize: VMSize,
  vmSizeSource: ResourceRequirementsSource
) {
  if (input.resolvedReservationOverride) {
    return input.resolvedReservationOverride;
  }

  const explicit = input.explicit ?? {};
  const profile = input.profile ?? null;
  const legacyVmSizes: Partial<Record<ResourceRequirementsSource, VMSize>> = {};

  if (explicit.vmSize) {
    legacyVmSizes[explicit.vmSizeSource ?? 'task'] = explicit.vmSize;
  }
  const skillVmSizeOverride = profile?.skillVmSizeOverride ?? null;
  if (skillVmSizeOverride) {
    legacyVmSizes.skill = skillVmSizeOverride as VMSize;
  }
  if (profile?.agentProfileVmSizeOverride) {
    const agentProfileVmSizeOverride = profile.agentProfileVmSizeOverride;
    legacyVmSizes['agent-profile'] = agentProfileVmSizeOverride as VMSize;
  } else if (!skillVmSizeOverride && profile?.vmSizeOverride) {
    legacyVmSizes[input.profileVmSizeSource ?? 'agent-profile'] = profile.vmSizeOverride as VMSize;
  }
  if (input.project.defaultVmSize && legacyVmSizes.project === undefined) {
    legacyVmSizes.project = input.project.defaultVmSize as VMSize;
  }
  if (Object.keys(legacyVmSizes).length === 0) {
    legacyVmSizes[vmSizeSource] = vmSize;
  }

  try {
    const storedResourceLayers = collectStoredResourceRequirementLayers({
      project: input.project.resourceRequirementsJson,
    });
    const resourceRequirements = mergeResourceRequirementLayers(
      storedResourceLayers,
      input.resourceRequirements ?? {}
    );
    return resolveResourceReservation(
      resourceRequirements,
      {
        taskId: input.taskId,
        triggerId: input.triggerId,
        skillId: profile?.skillId ?? undefined,
        agentProfileId: profile?.profileId ?? undefined,
        projectId: input.projectId,
        userId: input.userId,
      },
      {
        platformDefaults: input.platformDefaults,
        legacyVmSizes,
        legacyWorkloadMapping: input.legacyWorkloadMapping,
        compatibilityAdapterVersion:
          input.placementSettings?.legacyWorkloadAdapterVersion ??
          LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
      }
    );
  } catch (error) {
    if (error instanceof ResourceRequirementsValidationError) {
      throw new PlacementResolutionError('invalid-resource-requirements', error.message, []);
    }
    throw new PlacementResolutionError(
      'invalid-resource-requirements',
      error instanceof Error ? error.message : 'Invalid resource requirements',
      []
    );
  }
}

export function resolveTaskStartPlacement(input: TaskStartPlacementInput): TaskStartPlacement {
  const profile = input.profile ?? null;
  const explicit = input.explicit ?? {};
  const provider = resolveProvider(explicit.provider, profile, input.project);
  const preferredVmLocation =
    explicit.vmLocation == null
      ? resolvePreferredVmLocation(input.preferredVmLocation, provider)
      : null;
  const vmLocation = resolveVmLocation(
    explicit.vmLocation,
    preferredVmLocation,
    profile,
    input.project,
    provider
  );
  const workspaceProfile = resolveWorkspaceProfile(
    explicit.workspaceProfile,
    profile,
    input.project
  );
  const runtime = resolveEffectivePlacementRuntime({
    requestedRuntime: resolvePlacementRuntimePreference({
      explicitRuntime: explicit.runtime,
      profile,
    }),
    runtimeDecision: input.runtimeDecision,
  });

  if (input.validateLocation !== false && !runtime.isInstantRuntime) {
    validateResolvedLocation(provider, vmLocation);
  }

  const inheritedCredentialAttribution = normalizeCredentialAttribution(
    input.inheritedCredentialAttribution,
    input.userId,
    input.projectId
  );
  const vmSize = resolveVmSize(explicit.vmSize, profile, input.project);
  const vmSizeSource = resolveVmSizeSource(
    explicit,
    profile,
    input.project,
    input.profileVmSizeSource ?? 'agent-profile'
  );
  const resolvedReservation = resolvePlacementReservation(input, vmSize, vmSizeSource);

  return {
    entryPoint: input.entryPoint,
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    vmSize,
    vmSizeSource,
    provider,
    vmLocation,
    explicitVmLocation: explicit.vmLocation != null,
    ...(preferredVmLocation ? { preferredVmLocation } : {}),
    workspaceProfile,
    devcontainerConfigName: resolveDevcontainerConfigName(
      workspaceProfile,
      explicit.devcontainerConfigName,
      profile,
      input.project
    ),
    taskMode: resolveTaskMode(explicit.taskMode, profile, workspaceProfile, input.taskModeDefault),
    agentType: explicit.agentType ?? profile?.agentType ?? input.project.defaultAgentType ?? null,
    resolvedReservation,
    workloadRole: resolveWorkloadRole(input.workloadRole),
    placementSettings: input.placementSettings ?? null,
    credentialLookup: resolveCredentialLookup({
      userId: input.userId,
      projectId: input.projectId,
      provider,
      inheritedCredentialAttribution,
      projectPolicy: input.credentialProjectPolicy,
    }),
    inheritedCredentialAttribution,
    runtime,
  };
}

export function resolvePlacementCredentialAttribution(
  placement: TaskStartPlacement,
  credential: PlacementCredentialSourceResult
): PlacementCredentialAttribution {
  const inherited = placement.inheritedCredentialAttribution;
  const credentialAttributionSource = inherited.source ?? credential.credentialSource;
  const credentialAttributionProjectId =
    credentialAttributionSource === 'project'
      ? (inherited.projectId ?? placement.credentialLookup.projectId ?? placement.projectId)
      : null;

  return {
    effectiveProvider: placement.provider ?? credential.providerName,
    credentialAttributionUserId: inherited.userId ?? placement.credentialLookup.userId,
    credentialAttributionProjectId,
    credentialAttributionSource,
  };
}

export async function resolveTaskStartCapacityPoolSelection(
  db: Db,
  placement: TaskStartPlacement,
  options: { ensure?: boolean; failOpen?: boolean; env?: Env } = {}
): Promise<TaskStartCapacityPoolSelection | null> {
  if (placement.runtime.isInstantRuntime) return null;

  try {
    const resolvedSettings = options.env
      ? await resolveCapacityPoolPlacementSettings(db, options.env)
      : null;
    const summary = await resolveEffectiveDefaultCapacityPoolSummary(db, {
      userId: placement.userId,
      projectId: placement.projectId,
      ensure: options.ensure ?? true,
      initializeOnly: true,
      env: options.env,
      // Allocation filters by the requested role; editor summaries hide deployment mirrors.
      workloadRoles: 'all',
    });
    if (!summary) return null;

    const selection = buildCapacityPoolSelection(
      summary,
      {
        ...placement,
        placementSettings: resolvedSettings?.placementSettings ?? placement.placementSettings,
      },
      placement.workloadRole,
      resolvedSettings?.placementSettings ?? placement.placementSettings ?? undefined,
      resolveEffectiveNodeHostMemoryReserveMb(options.env ?? {})
    );
    return selection && placement.preferredVmLocation
      ? {
          ...selection,
          candidates: preferCapacityCandidatesInLocation(
            selection.candidates,
            placement.preferredVmLocation
          ),
        }
      : selection;
  } catch (error) {
    if (options.failOpen === false) throw error;
    log.warn('placement_resolver.capacity_pool_unavailable', {
      taskId: placement.taskId,
      projectId: placement.projectId,
      userId: placement.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function resolveCapacityAwareCredentialLookup(
  placement: TaskStartPlacement,
  capacityPoolSelection: TaskStartCapacityPoolSelection | null
): PlacementCredentialLookup {
  if (capacityPoolSelection && hasNoCapacityPoolCandidates(capacityPoolSelection)) {
    throw new PlacementResolutionError(
      'no-eligible-capacity-candidate',
      noEligibleCapacityCandidateMessage(placement, capacityPoolSelection),
      []
    );
  }

  const candidate = capacityPoolSelection?.candidates[0] ?? null;
  if (!candidate) return placement.credentialLookup;

  return {
    userId: placement.credentialLookup.userId,
    projectId:
      candidate.credentialAttributionSource === 'project'
        ? (candidate.capacityPoolProjectId ?? placement.projectId)
        : null,
    provider: candidate.provider,
  };
}

export function resolveCapacityPlacementCredentialAttribution(
  placement: TaskStartPlacement,
  candidate: TaskStartCapacityCandidate
): PlacementCredentialAttribution {
  return {
    effectiveProvider: candidate.provider,
    credentialAttributionUserId: placement.credentialLookup.userId,
    credentialAttributionProjectId:
      candidate.credentialAttributionSource === 'project'
        ? (candidate.capacityPoolProjectId ?? placement.projectId)
        : null,
    credentialAttributionSource: candidate.credentialAttributionSource,
  };
}

export function resolveCapacityAwareQuotaCredentialSource(
  credential: PlacementCredentialSourceResult,
  capacityPoolSelection: TaskStartCapacityPoolSelection | null
): CredentialSource {
  const capacityCandidate = capacityPoolSelection?.candidates[0] ?? null;
  if (
    credential.credentialSource === 'platform' ||
    capacityCandidate?.credentialAttributionSource === 'platform'
  ) {
    return 'platform';
  }
  return capacityCandidate?.credentialAttributionSource ?? credential.credentialSource;
}

export async function resolveTaskStartPlacementCredentialAttribution(
  db: Db,
  input: TaskStartPlacementInput,
  options?: { capacityPoolEnsure?: boolean; credentialsRequiredMessage?: string; env?: Env }
): Promise<
  TaskStartPlacementWithCredential | { error: string; errorKind: 'placement' | 'credentials' }
> {
  let placement: TaskStartPlacement;
  try {
    const settings = options?.env
      ? await resolveCapacityPoolPlacementSettings(db, options.env)
      : null;
    placement = resolveTaskStartPlacement({
      ...input,
      placementSettings: settings?.placementSettings ?? input.placementSettings,
      platformDefaults: settings?.resourceDefaults.platformDefaults ?? input.platformDefaults,
      legacyWorkloadMapping:
        settings?.resourceDefaults.legacyWorkloadMapping ?? input.legacyWorkloadMapping,
    });
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message, errorKind: 'placement' };
    }
    throw err;
  }

  return resolveTaskStartPlacementCredentialAttributionFromPlacement(db, placement, options);
}

export async function resolveTaskStartPlacementCredentialAttributionFromPlacement(
  db: Db,
  placement: TaskStartPlacement,
  options?: { capacityPoolEnsure?: boolean; credentialsRequiredMessage?: string; env?: Env }
): Promise<
  TaskStartPlacementWithCredential | { error: string; errorKind: 'placement' | 'credentials' }
> {
  let capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  let credentialLookup: PlacementCredentialLookup;
  try {
    capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement, {
      failOpen: false,
      ensure: options?.capacityPoolEnsure,
      env: options?.env,
    });
    credentialLookup = resolveCapacityAwareCredentialLookup(placement, capacityPoolSelection);
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message, errorKind: 'placement' };
    }
    throw err;
  }
  const credential = await resolveCredentialSource(
    db,
    credentialLookup.userId,
    credentialLookup.provider,
    credentialLookup.projectId
  );
  if (!credential) {
    return {
      error:
        options?.credentialsRequiredMessage ??
        'No cloud provider credentials found. The user must connect a cloud provider in Settings.',
      errorKind: 'credentials',
    };
  }

  const capacityCandidate = capacityPoolSelection?.candidates[0] ?? null;

  return {
    placement,
    credential,
    capacityPoolSelection,
    quotaCredentialSource: resolveCapacityAwareQuotaCredentialSource(
      credential,
      capacityPoolSelection
    ),
    capacityPlacementSnapshot:
      capacityPlacementSnapshotForTaskStart(capacityPoolSelection) ??
      directPlacementAuditSnapshot(placement),
    ...(capacityCandidate
      ? resolveCapacityPlacementCredentialAttribution(placement, capacityCandidate)
      : resolvePlacementCredentialAttribution(placement, credential)),
  };
}
