import type {
  AgentProfileRuntime,
  CapacityPlacementSnapshot,
  CapacityPoolScope,
  CapacityPoolStrategy,
  CapacityWorkloadRole,
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
  taskId: string;
  projectId: string;
  userId: string;
  vmSize: VMSize;
  vmSizeSource: ResourceRequirementsSource;
  provider: CredentialProvider | null;
  vmLocation: VMLocation;
  explicitVmLocation?: boolean;
  workspaceProfile: WorkspaceProfile;
  devcontainerConfigName: string | null;
  taskMode: TaskMode;
  agentType: string | null;
  resolvedReservation: ResolvedResourceReservation;
  credentialLookup: PlacementCredentialLookup;
  inheritedCredentialAttribution: Required<PlacementCredentialAttributionInput>;
  runtime: PlacementRuntimeResolution;
}

export interface TaskStartCapacityCandidate {
  id: string;
  poolId: string;
  capacitySourceId: string;
  provider: CredentialProvider;
  location: VMLocation;
  workloadRole: CapacityWorkloadRole;
  runtime: string | null;
  machineClass: string | null;
  /** Backward-compatible requested-size preset. Not capacity-pool candidate identity. */
  machineSize: VMSize | null;
  providerInstanceType: string;
  providerInstanceVcpuCount: number;
  providerInstanceMemoryMb: number;
  providerInstanceDiskGb: number | null;
  providerInstancePriceDisplay: string | null;
  providerInstancePriceCurrency: string | null;
  providerInstancePriceMonthlyCents: number | null;
  providerInstancePriceHourlyMicros: number | null;
  priority: number;
  candidateOrder: number;
  credentialAttributionSource: CredentialSource;
  placementCredentialSource: CredentialSource;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  capacityPoolProjectId: string | null;
  snapshot: CapacityPlacementSnapshot;
}

export interface TaskStartCapacityPoolSelection {
  poolId: string;
  scope: CapacityPoolScope;
  revision: number;
  strategy: CapacityPoolStrategy;
  capacityPoolProjectId: string | null;
  workloadRole: CapacityWorkloadRole;
  poolSnapshot: CapacityPlacementSnapshot;
  candidates: TaskStartCapacityCandidate[];
}

export interface CapacityAwareNodePlacementRow {
  vmSize: string | null;
  vmLocation: string | null;
  cloudProvider: string | null;
  capacityPoolId: string | null;
  capacityPoolScope: string | null;
  capacityPoolRevision?: number | null;
  capacitySourceId: string | null;
  capacityPoolCandidateId?: string | null;
  placementCredentialSource?: string | null;
  placementCredentialReference?: string | null;
  placementCredentialVersion?: number | null;
  capacityPoolProjectId: string | null;
  workloadRole: string | null;
  providerInstanceType?: string | null;
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
  providerInstancePriceDisplay?: string | null;
  providerInstancePriceCurrency?: string | null;
  providerInstancePriceMonthlyCents?: number | null;
  providerInstancePriceHourlyMicros?: number | null;
  placementExplanationJson?: string | null;
}

export interface PlacementCredentialAttribution {
  effectiveProvider: CredentialProvider;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
}

export interface TaskStartPlacementWithCredential extends PlacementCredentialAttribution {
  placement: TaskStartPlacement;
  credential: PlacementCredentialSourceResult;
  capacityPoolSelection: TaskStartCapacityPoolSelection | null;
}

export type PlacementResolutionErrorCode =
  | 'invalid-provider'
  | 'invalid-location'
  | 'no-eligible-capacity-candidate';
