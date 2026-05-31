import type {
  CredentialProvider,
  ResolvedResourceReservation,
  ResourceRequirements,
  ResourceRequirementsSource,
  TaskMode,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import {
  assertValidResourceRequirements,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  isValidProvider,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';

type AuditSource = ResourceRequirementsSource | 'explicit';

export interface ResourceAuditSnapshot {
  resourceRequirements: ResourceRequirements | null;
  resourceRequirementsJson: string | null;
  resourceRequirementsSource: ResourceRequirementsSource;
  resolvedReservation: ResolvedResourceReservation;
  resolvedReservationJson: string;
}

export interface TaskStartAuditSnapshot {
  vmSize: VMSize;
  vmSizeSource: AuditSource;
  provider: CredentialProvider | null;
  providerSource: AuditSource;
  vmLocation: VMLocation;
  vmLocationSource: AuditSource;
  workspaceProfile: WorkspaceProfile;
  workspaceProfileSource: AuditSource;
  taskMode: TaskMode;
  taskModeSource: AuditSource;
  resources: ResourceAuditSnapshot;
}

export interface TaskStartAuditInput {
  taskId: string;
  triggerId?: string | null;
  agentProfileId?: string | null;
  projectId: string;
  userId: string;
  explicit?: {
    vmSize?: VMSize | null;
    provider?: CredentialProvider | null;
    vmLocation?: VMLocation | null;
    workspaceProfile?: WorkspaceProfile | null;
    taskMode?: TaskMode | null;
    resourceRequirements?: ResourceRequirements | null;
  };
  trigger?: {
    vmSize?: VMSize | null;
    taskMode?: TaskMode | null;
    resourceRequirements?: ResourceRequirements | null;
  };
  agentProfile?: {
    vmSize?: VMSize | string | null;
    provider?: CredentialProvider | string | null;
    vmLocation?: VMLocation | string | null;
    workspaceProfile?: WorkspaceProfile | string | null;
    taskMode?: TaskMode | string | null;
    resourceRequirements?: ResourceRequirements | null;
  } | null;
  project: {
    defaultVmSize?: VMSize | string | null;
    defaultProvider?: CredentialProvider | string | null;
    defaultLocation?: VMLocation | string | null;
    defaultWorkspaceProfile?: WorkspaceProfile | string | null;
    defaultResourceRequirements?: ResourceRequirements | null;
  };
  taskModeFallback: 'task' | 'workspace-profile';
}

function nullableResourceRequirements(value: ResourceRequirements | null | undefined): ResourceRequirements | undefined {
  if (value === null || value === undefined) return undefined;
  assertValidResourceRequirements(value);
  return value;
}

export function parseResourceRequirementsJson(
  json: string | null | undefined,
  label = 'resource requirements',
): ResourceRequirements | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  assertValidResourceRequirements(parsed);
  return parsed;
}

function resolveResourceAudit(input: TaskStartAuditInput): ResourceAuditSnapshot {
  const task = nullableResourceRequirements(input.explicit?.resourceRequirements);
  const trigger = nullableResourceRequirements(input.trigger?.resourceRequirements);
  const agentProfile = nullableResourceRequirements(input.agentProfile?.resourceRequirements);
  const project = nullableResourceRequirements(input.project.defaultResourceRequirements);
  const resolvedReservation = resolveResourceReservation(
    { task, trigger, agentProfile, project },
    {
      taskId: input.taskId,
      triggerId: input.triggerId ?? undefined,
      agentProfileId: input.agentProfileId ?? undefined,
      projectId: input.projectId,
      userId: input.userId,
    },
  );
  const resolvedRequirements = resolvedReservation.requirements;

  return {
    resourceRequirements: resolvedRequirements,
    resourceRequirementsJson: JSON.stringify(resolvedRequirements),
    resourceRequirementsSource: resolvedReservation.source,
    resolvedReservation,
    resolvedReservationJson: JSON.stringify(resolvedReservation),
  };
}

export function resolveTaskStartAudit(input: TaskStartAuditInput): TaskStartAuditSnapshot {
  const profileProvider =
    typeof input.agentProfile?.provider === 'string' && isValidProvider(input.agentProfile.provider)
      ? input.agentProfile.provider
      : null;
  const projectProvider =
    typeof input.project.defaultProvider === 'string' && isValidProvider(input.project.defaultProvider)
      ? input.project.defaultProvider
      : null;

  const provider = input.explicit?.provider ?? profileProvider ?? projectProvider ?? null;
  const providerSource: AuditSource = input.explicit?.provider ? 'task'
    : profileProvider ? 'agent-profile'
    : projectProvider ? 'project'
    : 'platform';

  const vmSize = input.explicit?.vmSize
    ?? (input.trigger?.vmSize as VMSize | null)
    ?? (input.agentProfile?.vmSize as VMSize | null)
    ?? (input.project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  const vmSizeSource: AuditSource = input.explicit?.vmSize ? 'task'
    : input.trigger?.vmSize ? 'trigger'
    : input.agentProfile?.vmSize ? 'agent-profile'
    : input.project.defaultVmSize ? 'project'
    : 'platform';

  const vmLocation = input.explicit?.vmLocation
    ?? (input.agentProfile?.vmLocation as VMLocation | null)
    ?? (input.project.defaultLocation as VMLocation | null)
    ?? (provider ? (getDefaultLocationForProvider(provider) as VMLocation | null) : null)
    ?? DEFAULT_VM_LOCATION;
  const vmLocationSource: AuditSource = input.explicit?.vmLocation ? 'task'
    : input.agentProfile?.vmLocation ? 'agent-profile'
    : input.project.defaultLocation ? 'project'
    : provider ? providerSource
    : 'platform';

  const workspaceProfile = input.explicit?.workspaceProfile
    ?? (input.agentProfile?.workspaceProfile as WorkspaceProfile | null)
    ?? (input.project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;
  const workspaceProfileSource: AuditSource = input.explicit?.workspaceProfile ? 'task'
    : input.agentProfile?.workspaceProfile ? 'agent-profile'
    : input.project.defaultWorkspaceProfile ? 'project'
    : 'platform';

  const fallbackTaskMode = input.taskModeFallback === 'workspace-profile' && workspaceProfile === 'lightweight'
    ? 'conversation'
    : 'task';
  const taskMode = input.explicit?.taskMode
    ?? input.trigger?.taskMode
    ?? (input.agentProfile?.taskMode as TaskMode | null)
    ?? fallbackTaskMode;
  const taskModeSource: AuditSource = input.explicit?.taskMode ? 'task'
    : input.trigger?.taskMode ? 'trigger'
    : input.agentProfile?.taskMode ? 'agent-profile'
    : 'platform';

  return {
    vmSize,
    vmSizeSource,
    provider,
    providerSource,
    vmLocation,
    vmLocationSource,
    workspaceProfile,
    workspaceProfileSource,
    taskMode,
    taskModeSource,
    resources: resolveResourceAudit(input),
  };
}
