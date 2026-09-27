/**
 * Per-field resolution for task-start placement: provider, size, location, workspace profile,
 * devcontainer, task mode, workload role and credential lookup.
 *
 * Split out of `placement-resolver.ts` (rule 18). Pure code motion.
 */
import type {
  CapacityWorkloadRole,
  CredentialProvider,
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
} from '@simple-agent-manager/shared';

import { PlacementResolutionError } from './placement-resolution-error';
import type {
  PlacementCredentialAttributionInput,
  PlacementCredentialLookup,
  PlacementCredentialProjectPolicy,
  PlacementExplicitOverrides,
  PlacementProfileDefaults,
  PlacementProfileVmSizeSource,
  PlacementProjectDefaults,
  PlacementTaskModeDefault,
} from './placement-resolver-types';

export function resolveWorkloadRole(
  value: CapacityWorkloadRole | null | undefined
): CapacityWorkloadRole {
  return value === 'deployment' ? 'deployment' : 'workspace';
}

export function resolveProvider(
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

export function resolveVmSize(
  explicitVmSize: VMSize | null | undefined,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults
): VMSize {
  return (
    explicitVmSize ??
    (profile?.skillVmSizeOverride as VMSize | null) ??
    (profile?.agentProfileVmSizeOverride as VMSize | null) ??
    (profile?.vmSizeOverride as VMSize | null) ??
    (project.defaultVmSize as VMSize | null) ??
    DEFAULT_VM_SIZE
  );
}

export function resolveVmSizeSource(
  explicit: PlacementExplicitOverrides,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults,
  profileVmSizeSource: PlacementProfileVmSizeSource
): ResourceRequirementsSource {
  if (explicit.vmSize) return explicit.vmSizeSource ?? 'task';
  if (profile?.skillVmSizeOverride) return 'skill';
  if (profile?.agentProfileVmSizeOverride) return 'agent-profile';
  if (profile?.vmSizeOverride) return profileVmSizeSource;
  if (project.defaultVmSize) return 'project';
  return 'platform';
}

/**
 * A preferred location, or null when there is none or it does not fit the provider. Unlike an
 * explicit request nobody asked for it, so an unusable one is dropped rather than rejected.
 */
export function resolvePreferredVmLocation(
  preferredLocation: string | null | undefined,
  provider: CredentialProvider | null
): VMLocation | null {
  if (!preferredLocation) return null;
  if (provider !== null && !isValidLocationForProvider(provider, preferredLocation)) return null;
  return preferredLocation as VMLocation;
}

export function resolveVmLocation(
  explicitLocation: string | null | undefined,
  preferredLocation: VMLocation | null,
  profile: PlacementProfileDefaults | null,
  project: PlacementProjectDefaults,
  provider: CredentialProvider | null
): VMLocation {
  // A preference outranks the profile/project defaults: it is where this work last ran.
  return ((explicitLocation as VMLocation | null) ??
    preferredLocation ??
    (profile?.vmLocation as VMLocation | null) ??
    (project.defaultLocation as VMLocation | null) ??
    (provider ? (getDefaultLocationForProvider(provider) as VMLocation | null) : null) ??
    DEFAULT_VM_LOCATION) as VMLocation;
}

export function validateResolvedLocation(
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

export function resolveWorkspaceProfile(
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

export function resolveDevcontainerConfigName(
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

export function resolveTaskMode(
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

export function normalizeCredentialAttribution(
  input: PlacementCredentialAttributionInput | null | undefined,
  currentUserId: string,
  currentProjectId: string
): Required<PlacementCredentialAttributionInput> {
  if (!input?.source) {
    return {
      userId: null,
      projectId: null,
      source: null,
    };
  }

  if (input.source === 'project') {
    const projectId = input.projectId ?? currentProjectId;
    if (projectId !== currentProjectId) {
      throw new PlacementResolutionError(
        'invalid-credential-attribution',
        'Inherited project credential attribution belongs to a different project',
        []
      );
    }
    return {
      userId: currentUserId,
      projectId,
      source: 'project',
    };
  }

  if (input.source === 'user' || input.source === 'platform') {
    if (input.userId && input.userId !== currentUserId) {
      return {
        userId: null,
        projectId: null,
        source: null,
      };
    }
    return {
      userId: currentUserId,
      projectId: null,
      source: input.source,
    };
  }

  return {
    userId: null,
    projectId: null,
    source: null,
  };
}

export function resolveCredentialLookup(input: {
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
