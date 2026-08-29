import type {
  AgentProfileRuntime,
  CredentialProvider,
  CredentialSource,
  ResourceRequirementsSource,
  TaskMode,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import {
  CREDENTIAL_PROVIDERS,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  getLocationsForProvider,
  isValidLocationForProvider,
  isValidProvider,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import { log } from '../lib/logger';
import { resolveEffectiveDefaultCapacityPoolSummary } from './default-capacity-pools';
import {
  buildCapacityPoolSelection,
  hasNoCapacityPoolCandidates,
} from './placement-resolver-capacity';
import type {
  PlacementCredentialAttribution,
  PlacementCredentialAttributionInput,
  PlacementCredentialLookup,
  PlacementCredentialProjectPolicy,
  PlacementCredentialSourceResult,
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
import { resolveCredentialSource } from './provider-credentials';
import type { WorkspaceRuntimeDecision } from './workspace-runtime';

export {
  capacityPlacementSnapshotForTaskStart,
  capacityPoolNoCandidatesError,
  capacityPoolNoCandidatesMessage,
  capacityPoolSnapshotForPool,
  hasNoCapacityPoolCandidates,
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

export class PlacementResolutionError extends Error {
  readonly code: PlacementResolutionErrorCode;
  readonly validValues: readonly string[];

  constructor(code: PlacementResolutionErrorCode, message: string, validValues: readonly string[]) {
    super(message);
    this.name = 'PlacementResolutionError';
    this.code = code;
    this.validValues = validValues;
  }
}

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

export function resolveTaskStartPlacement(input: TaskStartPlacementInput): TaskStartPlacement {
  const profile = input.profile ?? null;
  const explicit = input.explicit ?? {};
  const provider = resolveProvider(explicit.provider, profile, input.project);
  const vmLocation = resolveVmLocation(explicit.vmLocation, profile, input.project, provider);
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
    input.inheritedCredentialAttribution
  );

  return {
    entryPoint: input.entryPoint,
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    vmSize: resolveVmSize(explicit.vmSize, profile, input.project),
    vmSizeSource: resolveVmSizeSource(
      explicit,
      profile,
      input.project,
      input.profileVmSizeSource ?? 'agent-profile'
    ),
    provider,
    vmLocation,
    explicitVmLocation: explicit.vmLocation != null,
    workspaceProfile,
    devcontainerConfigName: resolveDevcontainerConfigName(
      workspaceProfile,
      explicit.devcontainerConfigName,
      profile,
      input.project
    ),
    taskMode: resolveTaskMode(explicit.taskMode, profile, workspaceProfile, input.taskModeDefault),
    agentType: explicit.agentType ?? profile?.agentType ?? input.project.defaultAgentType ?? null,
    resolvedReservation: resolveResourceReservation(input.resourceRequirements ?? {}, {
      taskId: input.taskId,
      triggerId: input.triggerId,
      skillId: profile?.skillId ?? undefined,
      agentProfileId: profile?.profileId ?? undefined,
      projectId: input.projectId,
      userId: input.userId,
    }),
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
  options: { ensure?: boolean; failOpen?: boolean } = {}
): Promise<TaskStartCapacityPoolSelection | null> {
  if (placement.runtime.isInstantRuntime) return null;

  try {
    const summary = await resolveEffectiveDefaultCapacityPoolSummary(db, {
      userId: placement.userId,
      projectId: placement.projectId,
      ensure: options.ensure ?? true,
    });
    if (!summary) return null;

    return buildCapacityPoolSelection(summary, placement, 'workspace');
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
  options?: { credentialsRequiredMessage?: string }
): Promise<TaskStartPlacementWithCredential | { error: string }> {
  let placement: TaskStartPlacement;
  try {
    placement = resolveTaskStartPlacement(input);
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message };
    }
    throw err;
  }

  let capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  let credentialLookup: PlacementCredentialLookup;
  try {
    capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement);
    credentialLookup = resolveCapacityAwareCredentialLookup(placement, capacityPoolSelection);
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { error: err.message };
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
    };
  }

  const capacityCandidate = capacityPoolSelection?.candidates[0] ?? null;

  return {
    placement,
    credential,
    capacityPoolSelection,
    ...(capacityCandidate
      ? resolveCapacityPlacementCredentialAttribution(placement, capacityCandidate)
      : resolvePlacementCredentialAttribution(placement, credential)),
  };
}

function noEligibleCapacityCandidateMessage(
  placement: TaskStartPlacement,
  selection: TaskStartCapacityPoolSelection
): string {
  const requirements = [
    `${Math.ceil(placement.resolvedReservation.cpuMillis / 1000)} vCPU`,
    `${placement.resolvedReservation.memoryMb} MB memory`,
    placement.resolvedReservation.diskMb > 0
      ? `${Math.ceil(placement.resolvedReservation.diskMb / 1024)} GB disk`
      : null,
  ].filter(Boolean);
  const provider = placement.provider ? ` provider ${placement.provider}` : '';
  const location = placement.explicitVmLocation ? ` location ${placement.vmLocation}` : '';
  return (
    `No eligible compute-pool offering is available in the ${selection.scope} default pool` +
    `${provider}${location} for this task's requirements (${requirements.join(', ')}). ` +
    'Reconcile the pool or add an active provider-native offering that satisfies the request.'
  );
}

function resolveProvider(
  explicitProvider: CredentialProvider | string | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): CredentialProvider | null {
  if (explicitProvider != null) {
    if (!isValidProvider(explicitProvider)) {
      throw new PlacementResolutionError(
        'invalid-provider',
        `provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`,
        CREDENTIAL_PROVIDERS
      );
    }
    return explicitProvider;
  }

  return (
    providerFromTrustedLayer(profile?.provider) ?? providerFromTrustedLayer(project.defaultProvider)
  );
}

function providerFromTrustedLayer(provider: string | null | undefined): CredentialProvider | null {
  return typeof provider === 'string' && isValidProvider(provider) ? provider : null;
}

function resolveVmSize(
  explicitVmSize: VMSize | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): VMSize {
  return (
    explicitVmSize ??
    (profile?.vmSizeOverride as VMSize | null) ??
    (project.defaultVmSize as VMSize | null) ??
    DEFAULT_VM_SIZE
  );
}

function resolveVmSizeSource(
  explicit: PlacementExplicitOverrides,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults,
  profileVmSizeSource: PlacementProfileVmSizeSource
): ResourceRequirementsSource {
  if (explicit.vmSize) return explicit.vmSizeSource ?? 'task';
  if (profile?.vmSizeOverride) return profileVmSizeSource;
  if (project.defaultVmSize) return 'project';
  return 'platform';
}

function resolveVmLocation(
  explicitLocation: string | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults,
  provider: CredentialProvider | null
): VMLocation {
  return ((explicitLocation as VMLocation | null) ??
    (profile?.vmLocation as VMLocation | null) ??
    (project.defaultLocation as VMLocation | null) ??
    (provider ? (getDefaultLocationForProvider(provider) as VMLocation | null) : null) ??
    DEFAULT_VM_LOCATION) as VMLocation;
}

function validateResolvedLocation(
  provider: CredentialProvider | null,
  vmLocation: VMLocation
): void {
  if (provider === null || isValidLocationForProvider(provider, vmLocation)) return;

  const validLocations = getLocationsForProvider(provider).map((location) => location.id);
  throw new PlacementResolutionError(
    'invalid-location',
    `Location '${vmLocation}' is not valid for provider '${provider}'. Valid locations: ${validLocations.join(', ')}`,
    validLocations
  );
}

function resolveWorkspaceProfile(
  explicitWorkspaceProfile: WorkspaceProfile | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): WorkspaceProfile {
  return (
    explicitWorkspaceProfile ??
    (profile?.workspaceProfile as WorkspaceProfile | null) ??
    (project.defaultWorkspaceProfile as WorkspaceProfile | null) ??
    DEFAULT_WORKSPACE_PROFILE
  );
}

function resolveDevcontainerConfigName(
  workspaceProfile: WorkspaceProfile,
  explicitDevcontainerConfigName: string | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): string | null {
  if (workspaceProfile === 'lightweight') return null;
  return (
    explicitDevcontainerConfigName ??
    profile?.devcontainerConfigName ??
    project.defaultDevcontainerConfigName ??
    null
  );
}

function resolveTaskMode(
  explicitTaskMode: TaskMode | null | undefined,
  profile: PlacementProfileDefaults | null,
  workspaceProfile: WorkspaceProfile,
  defaultPolicy: PlacementTaskModeDefault
): TaskMode {
  if (explicitTaskMode != null) return explicitTaskMode;
  if (profile?.taskMode != null) return profile.taskMode as TaskMode;
  return defaultPolicy === 'workspace-profile' && workspaceProfile === 'lightweight'
    ? 'conversation'
    : 'task';
}

function normalizeCredentialAttribution(
  input: PlacementCredentialAttributionInput | null | undefined
): Required<PlacementCredentialAttributionInput> {
  return {
    userId: input?.userId ?? null,
    projectId: input?.source === 'project' ? (input.projectId ?? null) : null,
    source: input?.source ?? null,
  };
}

function resolveCredentialLookup(input: {
  userId: string;
  projectId: string;
  provider: CredentialProvider | null;
  inheritedCredentialAttribution: Required<PlacementCredentialAttributionInput>;
  projectPolicy: PlacementCredentialProjectPolicy;
}): PlacementCredentialLookup {
  const inheritedUserId = input.inheritedCredentialAttribution.userId;
  const inheritedProjectId =
    input.inheritedCredentialAttribution.source === 'project'
      ? (input.inheritedCredentialAttribution.projectId ?? input.projectId)
      : input.inheritedCredentialAttribution.projectId;
  return {
    userId: inheritedUserId ?? input.userId,
    projectId: resolveCredentialLookupProjectId({
      projectId: input.projectId,
      inheritedUserId,
      inheritedProjectId,
      projectPolicy: input.projectPolicy,
    }),
    provider: input.provider ?? undefined,
  };
}

function resolveCredentialLookupProjectId(input: {
  projectId: string;
  inheritedUserId: string | null;
  inheritedProjectId: string | null;
  projectPolicy: PlacementCredentialProjectPolicy;
}): string | null {
  switch (input.projectPolicy) {
    case 'current-project':
      return input.projectId;
    case 'current-project-unless-inherited':
      return input.inheritedUserId ? input.inheritedProjectId : input.projectId;
    case 'inherited-or-none':
      return input.inheritedProjectId;
    default: {
      const exhaustive: never = input.projectPolicy;
      return exhaustive;
    }
  }
}
