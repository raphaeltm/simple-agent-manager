import type {
  AgentEffort,
  CredentialProvider,
  CredentialSource,
  ResourceRequirementsSource,
  TaskActorType,
  TaskMode,
  TaskTerminalStatus,
  TriggeredBy,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';

import type {
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
  TaskStartPlacementWithCredential,
} from './placement-resolver';
import type { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';
import type { generateTaskTitle } from './task-title';

export interface ReservedTaskSubmissionIdentities {
  taskId: string;
  chatSessionId: string;
  initialMessageId: string;
  initialStatusEventId: string;
}

export type ReservedTaskSubmissionSourceKind = 'trigger' | 'schedule' | 'standing_watch';

export interface ReservedTaskSubmissionSourceProvenance {
  kind: ReservedTaskSubmissionSourceKind;
  /** Absolute latest initial start; already-running tasks may continue. */
  expiresAt?: number;
  sourceId: string;
  sourceExecutionId: string;
  triggeredBy: TriggeredBy;
  displayName: string;
  repositoryAccessFlow: string;
  initialStatusReason: string;
  initialStatusActorType: TaskActorType;
  initialStatusActorId: string | null;
  triggerId?: string | null;
  triggerExecutionId?: string | null;
}

export interface ReservedTaskSubmissionInput {
  identities: ReservedTaskSubmissionIdentities;
  projectId: string;
  userId: string;
  prompt: string;
  branchNameSeed: string;
  agentProfileId: string | null;
  skillId: string | null;
  taskMode: TaskMode;
  vmSizeOverride: string | null;
  source: ReservedTaskSubmissionSourceProvenance;
}

export type ReservedTaskSubmissionStartState =
  | 'started'
  | 'already_started'
  | 'confirmed_after_lost_ack';

export type ReservedTaskSubmissionConflictReason =
  | 'invalid_input'
  | 'source_reservation_missing'
  | 'source_reservation_conflict'
  | 'intent_fingerprint_mismatch'
  | 'identity_reuse_conflict'
  | 'project_not_found'
  | 'profile_unavailable'
  | 'placement_unavailable'
  | 'credentials_unavailable'
  | 'authority_unavailable'
  | 'accepted_configuration_changed'
  | 'project_data_conflict'
  | 'malformed_checkpoint';

export type ReservedTaskSubmissionResult =
  | {
      outcome: 'admitted';
      taskId: string;
      sessionId: string;
      branchName: string;
      startState: ReservedTaskSubmissionStartState;
      reused: boolean;
    }
  | {
      outcome: 'pending';
      taskId: string;
      sessionId: string;
      branchName: string;
      pendingAt: 'project_data' | 'task_runner_start';
      reason: string;
      reused: boolean;
    }
  | {
      outcome: 'conflict';
      taskId: string;
      sessionId: string;
      branchName: string | null;
      reason: ReservedTaskSubmissionConflictReason;
      message: string;
    }
  | {
      outcome: 'terminal';
      taskId: string;
      sessionId: string;
      branchName: string | null;
      status: TaskTerminalStatus;
      reason: string | null;
      reused: boolean;
    };

export interface ReservedTaskSubmissionDependencies {
  startTaskRunner?: typeof startTaskRunnerDO;
  ensureTaskRunnerStarted?: typeof ensureTaskRunnerStarted;
  requireRepositoryAccess?: typeof import('../routes/projects/_helpers').requireRepositoryOwnerAccess;
  now?: () => string;
  generateTitle?: typeof generateTaskTitle;
  afterD1Commit?: () => Promise<void> | void;
  afterProjectDataCommit?: () => Promise<void> | void;
  afterRunnerStartConfirmed?: () => Promise<void> | void;
}

export interface ResolvedReservedTaskSubmissionDependencies {
  startTaskRunner: typeof startTaskRunnerDO;
  ensureTaskRunnerStarted: typeof ensureTaskRunnerStarted;
  requireRepositoryAccess: typeof import('../routes/projects/_helpers').requireRepositoryOwnerAccess;
  now: () => string;
  generateTitle: typeof generateTaskTitle;
  afterD1Commit: () => Promise<void> | void;
  afterProjectDataCommit: () => Promise<void> | void;
  afterRunnerStartConfirmed: () => Promise<void> | void;
}

export interface CheckpointRow {
  task_id: string;
  project_id: string;
  user_id: string;
  chat_session_id: string;
  initial_message_id: string;
  initial_status_event_id: string;
  source_kind: ReservedTaskSubmissionSourceKind;
  source_id: string;
  source_execution_id: string;
  triggered_by: TriggeredBy;
  intent_fingerprint: string;
  accepted_snapshot_json: string;
  branch_name: string;
  task_title: string;
  checkpoint_state: string;
  project_data_committed_at: string | null;
  runner_start_attempted_at: string | null;
  runner_started_at: string | null;
  task_status: string;
  task_error_message: string | null;
  task_chat_session_id: string | null;
}

export interface TaskInsertValues {
  taskId: string;
  projectId: string;
  userId: string;
  chatSessionId: string;
  title: string;
  description: string;
  taskMode: TaskMode;
  outputBranch: string;
  triggeredBy: TriggeredBy;
  triggerId: string | null;
  triggerExecutionId: string | null;
  agentProfileHint: string | null;
  skillId: string | null;
  skillHint: string | null;
  requestedVmSize: VMSize;
  requestedVmSizeSource: ResourceRequirementsSource;
  resourceRequirementsJson: string | null;
  resourceRequirementsSource: ResourceRequirementsSource;
  resolvedReservationJson: string;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
  capacityPlacementSnapshot: TaskStartPlacementWithCredential['capacityPlacementSnapshot'];
}

export interface TaskRunnerStartSnapshot {
  taskId: string;
  projectId: string;
  userId: string;
  vmSize: VMSize;
  vmLocation: VMLocation;
  branch: string;
  defaultBranch: string;
  userName: string | null;
  userEmail: string | null;
  githubId: string | null;
  taskTitle: string;
  taskDescription: string;
  repository: string;
  installationId: string;
  outputBranch: string;
  projectDefaultVmSize: VMSize | null;
  chatSessionId: string;
  agentType: string | null;
  workspaceProfile: WorkspaceProfile | null;
  devcontainerConfigName: string | null;
  cloudProvider: CredentialProvider | null;
  explicitVmLocation: boolean;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
  taskMode: TaskMode;
  model: string | null;
  effort: AgentEffort | null;
  permissionMode: string | null;
  opencodeProvider: null;
  opencodeBaseUrl: null;
  systemPromptAppend: string | null;
  agentProfileHint: string | null;
  projectScaling: {
    taskExecutionTimeoutMs: number | null;
    maxWorkspacesPerNode: number | null;
    nodeCpuThresholdPercent: number | null;
    nodeMemoryThresholdPercent: number | null;
    warmNodeTimeoutMs: number | null;
  };
  resolvedReservation: TaskStartPlacement['resolvedReservation'];
  capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  vmSizeSource: ResourceRequirementsSource;
}

export interface ProfileSnapshotGuard {
  profileId: string | null;
  skillId: string | null;
  skillHint: string | null;
  agentType: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  resourceRequirementsJson: string | null;
}

export interface PlacementSnapshotGuard {
  vmSize: string;
  vmSizeSource: string;
  provider: string | null;
  vmLocation: string;
  explicitVmLocation: boolean;
  workspaceProfile: string;
  devcontainerConfigName: string | null;
  taskMode: string;
  agentType: string | null;
  resolvedReservation: TaskStartPlacement['resolvedReservation'];
  credentialLookup: TaskStartPlacement['credentialLookup'];
  inheritedCredentialAttribution: TaskStartPlacement['inheritedCredentialAttribution'];
  runtime: TaskStartPlacement['runtime'];
}

export interface CredentialSnapshotGuard {
  effectiveProvider: string;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
  quotaCredentialSource: CredentialSource;
  capacityPlacementSnapshot: TaskStartPlacementWithCredential['capacityPlacementSnapshot'];
}

export interface AcceptedSnapshot {
  version: 1;
  source: ReservedTaskSubmissionSourceProvenance;
  intentFingerprint: string;
  task: TaskInsertValues;
  runner: TaskRunnerStartSnapshot;
  projectGuard: {
    repository: string;
    installationId: string;
    defaultBranch: string;
  };
  profileGuard: ProfileSnapshotGuard;
  placementGuard: PlacementSnapshotGuard;
  credentialGuard: CredentialSnapshotGuard;
}

export interface PreparedSubmission {
  snapshot: AcceptedSnapshot;
  acceptedSnapshotJson: string;
}
