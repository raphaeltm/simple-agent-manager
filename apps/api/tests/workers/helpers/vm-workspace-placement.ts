import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';

import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { WorkspacePlacementInput } from '../../../src/services/workspace-placement';
import { seedInstallation, seedNode, seedProject, seedUser } from './seed-d1';

export const VM_ADMISSION_USER_ID = 'user-vm-admission-races';
export const VM_ADMISSION_OTHER_USER_ID = 'user-vm-admission-races-other';
export const VM_ADMISSION_INSTALLATION_ID = 'installation-vm-admission-races';
export const VM_ADMISSION_PROJECT_ID = 'project-vm-admission-races';

const SMALL_RESERVATION: ResolvedResourceReservation = {
  cpuMillis: 2_000,
  memoryMb: 4_096,
  diskMb: 40_960,
  exclusiveNode: false,
  maxCoTenants: 4,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
};

export function reservation(
  overrides: Partial<ResolvedResourceReservation> = {}
): ResolvedResourceReservation {
  return { ...SMALL_RESERVATION, ...overrides };
}

export async function seedVmAdmissionPlacementScope(): Promise<void> {
  await seedUser(VM_ADMISSION_USER_ID);
  await seedUser(VM_ADMISSION_OTHER_USER_ID);
  await seedInstallation(VM_ADMISSION_INSTALLATION_ID, VM_ADMISSION_USER_ID);
  await seedProject(VM_ADMISSION_PROJECT_ID, VM_ADMISSION_USER_ID, VM_ADMISSION_INSTALLATION_ID);
}

export function placement(
  workspaceId: string,
  nodeId: string,
  overrides: Partial<
    Pick<
      WorkspacePlacementInput,
      | 'projectId'
      | 'userId'
      | 'installationId'
      | 'repository'
      | 'vmSize'
      | 'vmLocation'
      | 'capacityPlacementSnapshot'
      | 'resolvedReservation'
    >
  > = {}
): WorkspacePlacementInput {
  return {
    id: workspaceId,
    nodeId,
    projectId: overrides.projectId ?? VM_ADMISSION_PROJECT_ID,
    userId: overrides.userId ?? VM_ADMISSION_USER_ID,
    installationId: overrides.installationId ?? VM_ADMISSION_INSTALLATION_ID,
    name: `Workspace ${workspaceId}`,
    displayName: `Workspace ${workspaceId}`,
    normalizedDisplayName: workspaceId,
    repository: overrides.repository ?? 'test-org/vm-admission-races',
    branch: 'main',
    vmSize: overrides.vmSize ?? 'medium',
    vmLocation: overrides.vmLocation ?? 'nbg1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    resolvedReservation: overrides.resolvedReservation ?? reservation(),
    capacityPlacementSnapshot: overrides.capacityPlacementSnapshot ?? null,
    createdAt: new Date().toISOString(),
  };
}

export function taskState(
  userId: string,
  vmSize: 'small' | 'medium' | 'large',
  overrides: Partial<Pick<TaskRunnerState, 'projectId'>> & {
    installationId?: string;
    repository?: string;
    capacityPoolSelection?: NonNullable<TaskRunnerState['config']['capacityPoolSelection']>;
    resolvedReservation?: ResolvedResourceReservation;
  } = {}
): TaskRunnerState {
  const now = Date.now();
  return {
    version: 1,
    taskId: `task-selector-${userId}-${vmSize}`,
    projectId: overrides.projectId ?? VM_ADMISSION_PROJECT_ID,
    userId,
    currentStep: 'node_selection',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      claimedWarmNodeId: null,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize,
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'selector packing',
      taskDescription: null,
      repository: overrides.repository ?? 'test-org/vm-admission-races',
      installationId: overrides.installationId ?? VM_ADMISSION_INSTALLATION_ID,
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'openai-codex',
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      cloudProvider: 'hetzner',
      credentialAttributionUserId: userId,
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
      projectScaling: { maxWorkspacesPerNode: 2 },
      resourceRequirements: null,
      resolvedReservation: overrides.resolvedReservation ?? reservation(),
      capacityPoolSelection: overrides.capacityPoolSelection ?? null,
      vmSizeSource: null,
      resumeSnapshotChatSessionId: null,
      recoverySourceTaskId: null,
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: now,
    lastStepAt: now,
    provisioningStartedAt: null,
    admissionScopeKey: null,
    admissionLeaseToken: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: null,
    completed: false,
  };
}

export function capacitySnapshot(input: {
  poolId: string;
  sourceId: string;
  candidateId: string;
  scope: 'project' | 'user' | 'installation';
  projectId?: string | null;
}): CapacityPlacementSnapshot {
  return {
    capacityPoolId: input.poolId,
    capacityPoolScope: input.scope,
    capacityPoolRevision: 1,
    capacitySourceId: input.sourceId,
    capacityPoolCandidateId: input.candidateId,
    placementCredentialSource: input.scope === 'installation' ? 'platform' : input.scope,
    placementCredentialReference: `test:${input.sourceId}`,
    placementCredentialVersion: 1,
    capacityPoolProjectId:
      input.scope === 'project' ? (input.projectId ?? VM_ADMISSION_PROJECT_ID) : null,
    workloadRole: 'workspace',
    providerInstanceType: 'cx42',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16_384,
    providerInstanceDiskGb: 160,
    placementExplanationJson: JSON.stringify({
      poolId: input.poolId,
      sourceId: input.sourceId,
      candidateId: input.candidateId,
    }),
  };
}

export async function seedCapacityRecords(
  snapshot: CapacityPlacementSnapshot,
  ownerUserId = VM_ADMISSION_USER_ID
): Promise<void> {
  if (!snapshot.capacityPoolId || !snapshot.capacityPoolScope || !snapshot.capacitySourceId) {
    throw new Error('snapshot must include pool and source IDs');
  }
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_pools
       (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status, strategy,
        exhaustion_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'active', 'balanced', 'queue', ?, ?)`
  )
    .bind(
      snapshot.capacityPoolId,
      snapshot.capacityPoolScope,
      snapshot.capacityPoolScope === 'user' ? ownerUserId : null,
      snapshot.capacityPoolScope === 'project' ? snapshot.capacityPoolProjectId : null,
      `Pool ${snapshot.capacityPoolId}`,
      snapshot.capacityPoolRevision ?? 1,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_sources
       (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
        credential_id, platform_credential_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'registered-runner', NULL, NULL, NULL, NULL, 'active', ?, ?)`
  )
    .bind(
      snapshot.capacitySourceId,
      snapshot.capacityPoolScope,
      snapshot.capacityPoolScope === 'user' ? ownerUserId : null,
      snapshot.capacityPoolScope === 'project' ? snapshot.capacityPoolProjectId : null,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
}

export async function assignNodeCapacity(
  nodeId: string,
  snapshot: CapacityPlacementSnapshot
): Promise<void> {
  await seedCapacityRecords(snapshot);
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET capacity_pool_id = ?, capacity_pool_scope = ?, capacity_pool_revision = ?,
         capacity_source_id = ?, capacity_pool_candidate_id = ?,
         placement_credential_source = ?, placement_credential_reference = ?,
         placement_credential_version = ?, capacity_pool_project_id = ?, workload_role = ?,
         provider_instance_type = ?, provider_instance_vcpu_count = ?,
         provider_instance_memory_mb = ?, provider_instance_disk_gb = ?,
         placement_explanation_json = ?
     WHERE id = ?`
  )
    .bind(
      snapshot.capacityPoolId,
      snapshot.capacityPoolScope,
      snapshot.capacityPoolRevision,
      snapshot.capacitySourceId,
      snapshot.capacityPoolCandidateId,
      snapshot.placementCredentialSource,
      snapshot.placementCredentialReference,
      snapshot.placementCredentialVersion,
      snapshot.capacityPoolProjectId,
      snapshot.workloadRole,
      snapshot.providerInstanceType,
      snapshot.providerInstanceVcpuCount,
      snapshot.providerInstanceMemoryMb,
      snapshot.providerInstanceDiskGb,
      snapshot.placementExplanationJson,
      nodeId
    )
    .run();
}

export function selectorContext(): TaskRunnerContext {
  return {
    env: {
      DATABASE: env.DATABASE,
      MAX_WORKSPACES_PER_NODE: '2',
      TASK_RUN_NODE_CPU_THRESHOLD_PERCENT: '90',
      TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT: '90',
      VM_AGENT_REQUIRED_VERSION: 'current-sha',
    },
  } as unknown as TaskRunnerContext;
}

export async function makeReadyNode(
  nodeId: string,
  userId: string,
  vmSize: 'small' | 'medium' | 'large',
  opts: { nodeClass?: 'managed' | 'user-owned' } = {}
): Promise<void> {
  const now = new Date().toISOString();
  const capacity = {
    small: { instanceType: 'cx23', vcpuCount: 2, memoryMb: 4_096, diskGb: 40 },
    medium: { instanceType: 'cx42', vcpuCount: 4, memoryMb: 8_192, diskGb: 80 },
    large: { instanceType: 'cx52', vcpuCount: 8, memoryMb: 16_384, diskGb: 160 },
  }[vmSize];
  await seedNode(nodeId, userId, {
    vmSize,
    vmLocation: 'nbg1',
    status: 'running',
    nodeClass: opts.nodeClass ?? 'managed',
  });
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET health_status = 'healthy', last_heartbeat_at = ?, agent_ready_at = ?,
         agent_version = 'current-sha', runtime = 'vm', node_role = 'workspace',
         provider_instance_type = ?, provider_instance_vcpu_count = ?,
         provider_instance_memory_mb = ?, provider_instance_disk_gb = ?, last_metrics = ?
     WHERE id = ?`
  )
    .bind(
      now,
      now,
      capacity.instanceType,
      capacity.vcpuCount,
      capacity.memoryMb,
      capacity.diskGb,
      JSON.stringify({ cpuLoadAvg1: 5, memoryPercent: 10 }),
      nodeId
    )
    .run();
}

export async function createIsolatedPlacementScope(suffix: string): Promise<{
  userId: string;
  installationId: string;
  projectId: string;
  repository: string;
}> {
  const userId = `user-vm-reservation-${suffix}`;
  const installationId = `installation-vm-reservation-${suffix}`;
  const projectId = `project-vm-reservation-${suffix}`;
  const repository = `test-org/vm-reservation-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId, {
    installationIdValue: `inst-vm-reservation-${suffix}`,
    accountName: `vm-reservation-${suffix}`,
  });
  await seedProject(projectId, userId, installationId, { repository });
  return { userId, installationId, projectId, repository };
}
