import type {
  AgentProfileRuntime,
  CredentialProvider,
  CredentialSource,
  ResolvedResourceReservation,
  ResourceRequirementsSource,
  ResourceResolutionInput,
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

import type { WorkspaceRuntimeDecision } from './workspace-runtime';

export type PlacementEntryPoint =
  | 'task-submit'
  | 'mcp-dispatch'
  | 'sam-session-dispatch'
  | 'trigger-submit'
  | 'retry-subtask'
  | 'task-run'
  | 'orchestrator-dispatch'
  | 'orchestration-retry';

export type PlacementCredentialProjectPolicy =
  | 'current-project'
  | 'current-project-unless-inherited'
  | 'inherited-or-none';

export type PlacementTaskModeDefault = 'task' | 'workspace-profile';
export type PlacementProfileVmSizeSource = Extract<
  ResourceRequirementsSource,
  'agent-profile' | 'skill'
>;

export interface PlacementProjectDefaults {
  id: string;
  defaultVmSize?: string | null;
  defaultProvider?: string | null;
  defaultLocation?: string | null;
  defaultWorkspaceProfile?: string | null;
  defaultDevcontainerConfigName?: string | null;
  defaultAgentType?: string | null;
}

export interface PlacementProfileDefaults {
  profileId?: string | null;
  skillId?: string | null;
  agentType?: string | null;
  vmSizeOverride?: string | null;
  provider?: string | null;
  vmLocation?: string | null;
  workspaceProfile?: string | null;
  runtime?: AgentProfileRuntime | null;
  devcontainerConfigName?: string | null;
  taskMode?: string | null;
  resourceRequirementsJson?: string | null;
}

export interface PlacementExplicitOverrides {
  vmSize?: VMSize | null;
  vmSizeSource?: Extract<ResourceRequirementsSource, 'task' | 'trigger'>;
  provider?: CredentialProvider | string | null;
  vmLocation?: string | null;
  workspaceProfile?: WorkspaceProfile | null;
  devcontainerConfigName?: string | null;
  taskMode?: TaskMode | null;
  agentType?: string | null;
  runtime?: AgentProfileRuntime | null;
}

export interface PlacementCredentialAttributionInput {
  userId?: string | null;
  projectId?: string | null;
  source?: CredentialSource | null;
}

export interface PlacementCredentialSourceResult {
  credentialSource: CredentialSource;
  providerName: CredentialProvider;
}

export interface TaskStartPlacementInput {
  entryPoint: PlacementEntryPoint;
  taskId: string;
  triggerId?: string;
  projectId: string;
  userId: string;
  project: PlacementProjectDefaults;
  profile?: PlacementProfileDefaults | null;
  explicit?: PlacementExplicitOverrides;
  inheritedCredentialAttribution?: PlacementCredentialAttributionInput | null;
  credentialProjectPolicy: PlacementCredentialProjectPolicy;
  taskModeDefault: PlacementTaskModeDefault;
  profileVmSizeSource?: PlacementProfileVmSizeSource;
  resourceRequirements?: ResourceResolutionInput;
  validateLocation?: boolean;
  runtimeDecision?: WorkspaceRuntimeDecision | null;
}

export interface PlacementCredentialLookup {
  userId: string;
  projectId: string | null;
  provider: CredentialProvider | undefined;
}

export interface PlacementRuntimeResolution {
  requestedRuntime: AgentProfileRuntime | null;
  decision: WorkspaceRuntimeDecision | null;
  executionRuntime: AgentProfileRuntime;
  isInstantRuntime: boolean;
  reason: WorkspaceRuntimeDecision['reason'] | 'vm-only';
}

export interface TaskStartPlacement {
  entryPoint: PlacementEntryPoint;
  projectId: string;
  userId: string;
  vmSize: VMSize;
  vmSizeSource: ResourceRequirementsSource;
  provider: CredentialProvider | null;
  vmLocation: VMLocation;
  workspaceProfile: WorkspaceProfile;
  devcontainerConfigName: string | null;
  taskMode: TaskMode;
  agentType: string | null;
  resolvedReservation: ResolvedResourceReservation;
  credentialLookup: PlacementCredentialLookup;
  inheritedCredentialAttribution: Required<PlacementCredentialAttributionInput>;
  runtime: PlacementRuntimeResolution;
}

export interface PlacementCredentialAttribution {
  effectiveProvider: CredentialProvider;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
}

export type PlacementResolutionErrorCode = 'invalid-provider' | 'invalid-location';

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
