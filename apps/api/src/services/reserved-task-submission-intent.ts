import type { VMSize } from '@simple-agent-manager/shared';
import { isJsonRecord, isTaskMode, TRIGGERED_BY_VALUES } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { generateBranchName } from './branch-name';
import {
  PlacementResolutionError,
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
  type TaskStartPlacement,
  type TaskStartPlacementWithCredential,
} from './placement-resolver';
import type {
  AcceptedSnapshot,
  CheckpointRow,
  CredentialSnapshotGuard,
  PlacementSnapshotGuard,
  PreparedSubmission,
  ProfileSnapshotGuard,
  ReservedTaskSubmissionConflictReason,
  ReservedTaskSubmissionInput,
  ReservedTaskSubmissionResult,
  ResolvedReservedTaskSubmissionDependencies,
} from './reserved-task-submission-contracts';
import { parseSkillResourceRequirementsJson, resolveSkillProfile } from './skills';
import { type startTaskRunnerDO } from './task-runner-do';
import {
  assertTaskRunnerStartGuard,
  type TaskRunnerReservedSubmissionGuard,
  TaskRunnerStartGuardRevokedError,
} from './task-runner-start-guard';
import { getTaskTitleConfig } from './task-title';

const FINGERPRINT_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const MAX_RESERVED_ID_LENGTH = 160;
const DEFAULT_RESERVED_PROMPT_MAX_LENGTH = 16_000;
const DEFAULT_RESERVED_BRANCH_NAME_SEED_MAX_LENGTH = 512;
const DEFAULT_RESERVED_SOURCE_DISPLAY_NAME_MAX_LENGTH = 512;
const DEFAULT_RESERVED_REPOSITORY_ACCESS_FLOW_MAX_LENGTH = 512;
const DEFAULT_RESERVED_INITIAL_STATUS_REASON_MAX_LENGTH = 1_024;
const SOURCE_KINDS = new Set<string>(['trigger', 'schedule', 'standing_watch']);
const TASK_ACTOR_TYPES = new Set<string>(['user', 'system', 'workspace_callback']);
const TRIGGERED_BY = new Set<string>(TRIGGERED_BY_VALUES);

type Db = ReturnType<typeof drizzle<typeof schema>>;
type ResolvedProfile = Awaited<ReturnType<typeof resolveSkillProfile>> | null;
type TaskRunnerStartInput = Parameters<typeof startTaskRunnerDO>[1];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function nonEmptyIdentity(value: string, field: string): string {
  nonEmpty(value, field);
  if (value.length > MAX_RESERVED_ID_LENGTH) {
    throw new Error(`${field} must be ${MAX_RESERVED_ID_LENGTH} characters or fewer`);
  }
  return value;
}

function nonEmptyBoundedText(value: string, field: string, maxLength: number): string {
  nonEmpty(value, field);
  if (value.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return value;
}

export function validateReservedTaskSubmissionInput(
  input: ReservedTaskSubmissionInput,
  env: Pick<
    Env,
    | 'MAX_TASK_MESSAGE_LENGTH'
    | 'RESERVED_TASK_BRANCH_NAME_SEED_MAX_LENGTH'
    | 'RESERVED_TASK_SOURCE_DISPLAY_NAME_MAX_LENGTH'
    | 'RESERVED_TASK_REPOSITORY_ACCESS_FLOW_MAX_LENGTH'
    | 'RESERVED_TASK_INITIAL_STATUS_REASON_MAX_LENGTH'
  >
): string | null {
  try {
    nonEmptyIdentity(input.identities.taskId, 'identities.taskId');
    nonEmptyIdentity(input.identities.chatSessionId, 'identities.chatSessionId');
    nonEmptyIdentity(input.identities.initialMessageId, 'identities.initialMessageId');
    nonEmptyIdentity(input.identities.initialStatusEventId, 'identities.initialStatusEventId');
    nonEmptyIdentity(input.projectId, 'projectId');
    nonEmptyIdentity(input.userId, 'userId');
    nonEmptyBoundedText(
      input.prompt,
      'prompt',
      parsePositiveInt(env.MAX_TASK_MESSAGE_LENGTH, DEFAULT_RESERVED_PROMPT_MAX_LENGTH)
    );
    nonEmptyBoundedText(
      input.branchNameSeed,
      'branchNameSeed',
      parsePositiveInt(
        env.RESERVED_TASK_BRANCH_NAME_SEED_MAX_LENGTH,
        DEFAULT_RESERVED_BRANCH_NAME_SEED_MAX_LENGTH
      )
    );
    if (
      input.source.expiresAt !== undefined &&
      (!Number.isSafeInteger(input.source.expiresAt) || input.source.expiresAt <= 0)
    ) {
      throw new Error('source.expiresAt must be a positive UTC timestamp');
    }
    if (!SOURCE_KINDS.has(input.source.kind)) {
      throw new Error(`source.kind is invalid: ${input.source.kind}`);
    }
    if (!TRIGGERED_BY.has(input.source.triggeredBy)) {
      throw new Error(`source.triggeredBy is invalid: ${input.source.triggeredBy}`);
    }
    if (!TASK_ACTOR_TYPES.has(input.source.initialStatusActorType)) {
      throw new Error(
        `source.initialStatusActorType is invalid: ${input.source.initialStatusActorType}`
      );
    }
    if (!isTaskMode(input.taskMode)) {
      throw new Error(`taskMode is invalid: ${input.taskMode}`);
    }
    nonEmptyIdentity(input.source.sourceId, 'source.sourceId');
    nonEmptyIdentity(input.source.sourceExecutionId, 'source.sourceExecutionId');
    nonEmptyBoundedText(
      input.source.displayName,
      'source.displayName',
      parsePositiveInt(
        env.RESERVED_TASK_SOURCE_DISPLAY_NAME_MAX_LENGTH,
        DEFAULT_RESERVED_SOURCE_DISPLAY_NAME_MAX_LENGTH
      )
    );
    nonEmptyBoundedText(
      input.source.repositoryAccessFlow,
      'source.repositoryAccessFlow',
      parsePositiveInt(
        env.RESERVED_TASK_REPOSITORY_ACCESS_FLOW_MAX_LENGTH,
        DEFAULT_RESERVED_REPOSITORY_ACCESS_FLOW_MAX_LENGTH
      )
    );
    nonEmptyBoundedText(
      input.source.initialStatusReason,
      'source.initialStatusReason',
      parsePositiveInt(
        env.RESERVED_TASK_INITIAL_STATUS_REASON_MAX_LENGTH,
        DEFAULT_RESERVED_INITIAL_STATUS_REASON_MAX_LENGTH
      )
    );
    if (input.source.kind === 'trigger') {
      if (input.source.triggerId !== input.source.sourceId) {
        throw new Error('trigger sourceId must match triggerId');
      }
      if (input.source.triggerExecutionId !== input.source.sourceExecutionId) {
        throw new Error('trigger sourceExecutionId must match triggerExecutionId');
      }
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

export async function submissionFingerprint(input: ReservedTaskSubmissionInput): Promise<string> {
  return sha256(
    canonicalJson({
      version: FINGERPRINT_VERSION,
      identities: input.identities,
      projectId: input.projectId,
      userId: input.userId,
      prompt: input.prompt,
      branchNameSeed: input.branchNameSeed,
      agentProfileId: input.agentProfileId,
      skillId: input.skillId,
      taskMode: input.taskMode,
      vmSizeOverride: input.vmSizeOverride,
      source: input.source,
    })
  );
}

export function reservedTaskSubmissionConflict(
  input: ReservedTaskSubmissionInput,
  reason: ReservedTaskSubmissionConflictReason,
  message: string,
  branchName: string | null = null
): ReservedTaskSubmissionResult {
  return {
    outcome: 'conflict',
    taskId: input.identities.taskId,
    sessionId: input.identities.chatSessionId,
    branchName,
    reason,
    message,
  };
}

async function loadProject(db: Db, projectId: string): Promise<schema.Project | null> {
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return project ?? null;
}

async function loadUserStartSnapshot(
  db: Db,
  userId: string
): Promise<{ githubId: string | null; name: string | null; email: string | null }> {
  const [userRow] = await db
    .select({ githubId: schema.users.githubId, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return {
    githubId: userRow?.githubId ?? null,
    name: userRow?.name ?? null,
    email: userRow?.email ?? null,
  };
}

function profileGuard(profile: ResolvedProfile): ProfileSnapshotGuard {
  return {
    profileId: profile?.profileId ?? null,
    skillId: profile?.skillId ?? null,
    skillHint: profile?.skillHint ?? null,
    agentType: profile?.agentType ?? null,
    model: profile?.model ?? null,
    effort: profile?.effort ?? null,
    permissionMode: profile?.permissionMode ?? null,
    systemPromptAppend: profile?.systemPromptAppend ?? null,
    resourceRequirementsJson: profile?.resourceRequirementsJson ?? null,
  };
}

function placementGuard(placement: TaskStartPlacement): PlacementSnapshotGuard {
  return {
    vmSize: placement.vmSize,
    vmSizeSource: placement.vmSizeSource,
    provider: placement.provider,
    vmLocation: placement.vmLocation,
    explicitVmLocation: placement.explicitVmLocation === true,
    workspaceProfile: placement.workspaceProfile,
    devcontainerConfigName: placement.devcontainerConfigName,
    taskMode: placement.taskMode,
    agentType: placement.agentType,
    resolvedReservation: placement.resolvedReservation,
    credentialLookup: placement.credentialLookup,
    inheritedCredentialAttribution: placement.inheritedCredentialAttribution,
    runtime: placement.runtime,
  };
}

function credentialGuard(resolution: TaskStartPlacementWithCredential): CredentialSnapshotGuard {
  return {
    effectiveProvider: resolution.effectiveProvider,
    credentialAttributionUserId: resolution.credentialAttributionUserId,
    credentialAttributionProjectId: resolution.credentialAttributionProjectId,
    credentialAttributionSource: resolution.credentialAttributionSource,
    quotaCredentialSource: resolution.quotaCredentialSource,
    capacityPlacementSnapshot: stableCapacityPlacementSnapshot(
      resolution.capacityPlacementSnapshot
    ),
  };
}

function stableCapacityPlacementSnapshot(
  snapshot: TaskStartPlacementWithCredential['capacityPlacementSnapshot']
): TaskStartPlacementWithCredential['capacityPlacementSnapshot'] {
  if (!snapshot) return null;
  return { ...snapshot, placementExplanationJson: null };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function resolvePlacementForInput(
  db: Db,
  env: Env,
  input: ReservedTaskSubmissionInput,
  project: schema.Project
): Promise<
  | {
      profile: ResolvedProfile;
      placement: TaskStartPlacement;
      resolution: TaskStartPlacementWithCredential;
    }
  | {
      reason: 'profile_unavailable' | 'placement_unavailable' | 'credentials_unavailable';
      message: string;
    }
> {
  let profile: ResolvedProfile;
  try {
    profile =
      input.agentProfileId || input.skillId
        ? await resolveSkillProfile(
            db,
            input.projectId,
            input.agentProfileId,
            input.skillId,
            input.userId,
            env
          )
        : null;
  } catch (error) {
    return {
      reason: 'profile_unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const skillResourceRequirements = parseSkillResourceRequirementsJson(
    profile?.resourceRequirementsJson
  );

  let placement: TaskStartPlacement;
  try {
    placement = resolveTaskStartPlacement({
      entryPoint: 'trigger-submit',
      taskId: input.identities.taskId,
      triggerId: input.source.kind === 'trigger' ? input.source.sourceId : undefined,
      projectId: input.projectId,
      userId: input.userId,
      project,
      profile,
      explicit: {
        vmSize: (input.vmSizeOverride as VMSize | null) ?? null,
        vmSizeSource: input.source.kind === 'trigger' ? 'trigger' : 'task',
        taskMode: input.taskMode ?? null,
      },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'workspace-profile',
      resourceRequirements: {
        skill: skillResourceRequirements,
      },
    });
  } catch (err) {
    if (err instanceof PlacementResolutionError) {
      return { reason: 'placement_unavailable', message: err.message };
    }
    throw err;
  }

  const placementResolution = await resolveTaskStartPlacementCredentialAttributionFromPlacement(
    db,
    placement,
    {
      credentialsRequiredMessage: `No cloud provider credentials available for ${input.source.kind} ${input.source.sourceId}`,
      env,
    }
  );
  if ('error' in placementResolution) {
    return {
      reason:
        placementResolution.errorKind === 'credentials'
          ? 'credentials_unavailable'
          : 'placement_unavailable',
      message: placementResolution.error,
    };
  }

  return { profile, placement, resolution: placementResolution };
}

export async function prepareNewSubmission(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  intentFingerprint: string,
  deps: ResolvedReservedTaskSubmissionDependencies
): Promise<PreparedSubmission | ReservedTaskSubmissionResult> {
  const project = await loadProject(db, input.projectId);
  if (!project) {
    return reservedTaskSubmissionConflict(
      input,
      'project_not_found',
      `Project ${input.projectId} not found`
    );
  }

  const resolved = await resolvePlacementForInput(db, env, input, project);
  if ('reason' in resolved) {
    return reservedTaskSubmissionConflict(input, resolved.reason, resolved.message);
  }

  try {
    await deps.requireRepositoryAccess(
      env,
      db,
      project,
      input.userId,
      `${input.source.repositoryAccessFlow}-admission`
    );
  } catch (error) {
    return reservedTaskSubmissionConflict(
      input,
      'authority_unavailable',
      error instanceof Error ? error.message : String(error)
    );
  }

  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(input.branchNameSeed, input.identities.taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });
  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = await deps.generateTitle(env, input.prompt, titleConfig);
  const user = await loadUserStartSnapshot(db, input.userId);
  const { placement, profile, resolution } = resolved;
  const task = {
    taskId: input.identities.taskId,
    projectId: input.projectId,
    userId: input.userId,
    chatSessionId: input.identities.chatSessionId,
    title: taskTitle,
    description: input.prompt,
    taskMode: placement.taskMode,
    outputBranch: branchName,
    triggeredBy: input.source.triggeredBy,
    triggerId: input.source.kind === 'trigger' ? input.source.sourceId : null,
    triggerExecutionId: input.source.kind === 'trigger' ? input.source.sourceExecutionId : null,
    agentProfileHint: profile?.profileId ?? null,
    skillId: profile?.skillId ?? null,
    skillHint: input.skillId,
    requestedVmSize: placement.vmSize,
    requestedVmSizeSource: placement.vmSizeSource,
    resourceRequirementsJson: profile?.resourceRequirementsJson ?? null,
    resourceRequirementsSource: placement.resolvedReservation.source,
    resolvedReservationJson: JSON.stringify(placement.resolvedReservation),
    credentialAttributionUserId: resolution.credentialAttributionUserId,
    credentialAttributionProjectId: resolution.credentialAttributionProjectId,
    credentialAttributionSource: resolution.credentialAttributionSource,
    capacityPlacementSnapshot: resolution.capacityPlacementSnapshot,
  };
  const runner = {
    taskId: input.identities.taskId,
    projectId: input.projectId,
    userId: input.userId,
    vmSize: placement.vmSize,
    vmLocation: placement.vmLocation,
    branch: project.defaultBranch,
    defaultBranch: project.defaultBranch,
    userName: user.name,
    userEmail: user.email,
    githubId: user.githubId,
    taskTitle,
    taskDescription: input.prompt,
    repository: project.repository,
    installationId: project.installationId,
    outputBranch: branchName,
    projectDefaultVmSize: project.defaultVmSize as VMSize | null,
    chatSessionId: input.identities.chatSessionId,
    agentType: placement.agentType,
    workspaceProfile: placement.workspaceProfile,
    devcontainerConfigName: placement.devcontainerConfigName,
    cloudProvider: placement.provider ?? resolution.effectiveProvider,
    explicitVmLocation: placement.explicitVmLocation === true,
    credentialAttributionUserId: resolution.credentialAttributionUserId,
    credentialAttributionProjectId: resolution.credentialAttributionProjectId,
    credentialAttributionSource: resolution.credentialAttributionSource,
    taskMode: placement.taskMode,
    model: profile?.model ?? null,
    effort: profile?.effort ?? null,
    permissionMode: profile?.permissionMode ?? null,
    opencodeProvider: null,
    opencodeBaseUrl: null,
    systemPromptAppend: profile?.systemPromptAppend ?? null,
    agentProfileHint: profile?.profileId ?? null,
    projectScaling: {
      taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
      maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
      nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
      nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
      warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
    },
    resolvedReservation: placement.resolvedReservation,
    capacityPoolSelection: resolution.capacityPoolSelection,
    vmSizeSource: placement.vmSizeSource,
  };

  const snapshot: AcceptedSnapshot = {
    version: SNAPSHOT_VERSION,
    source: input.source,
    intentFingerprint,
    task,
    runner,
    projectGuard: {
      repository: project.repository,
      installationId: project.installationId,
      defaultBranch: project.defaultBranch,
    },
    profileGuard: profileGuard(profile),
    placementGuard: placementGuard(placement),
    credentialGuard: credentialGuard(resolution),
  };
  return { snapshot, acceptedSnapshotJson: canonicalJson(snapshot) };
}

export function parseAcceptedSnapshot(row: CheckpointRow): AcceptedSnapshot | null {
  try {
    const parsed = JSON.parse(row.accepted_snapshot_json) as unknown;
    if (!isJsonRecord(parsed)) return null;
    const task = parsed.task;
    if (!isJsonRecord(task)) return null;
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    if (task.taskId !== row.task_id) return null;
    if (task.chatSessionId !== row.chat_session_id) return null;
    if (parsed.intentFingerprint !== row.intent_fingerprint) return null;
    return parsed as unknown as AcceptedSnapshot;
  } catch {
    return null;
  }
}

export async function revalidateBeforePhysicalStart(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ResolvedReservedTaskSubmissionDependencies,
  reused: boolean
): Promise<ReservedTaskSubmissionResult | null> {
  const project = await loadProject(db, input.projectId);
  if (!project) {
    return reservedTaskSubmissionConflict(
      input,
      'project_not_found',
      `Project ${input.projectId} not found`,
      snapshot.task.outputBranch
    );
  }
  const projectGuard = {
    repository: project.repository,
    installationId: project.installationId,
    defaultBranch: project.defaultBranch,
  };
  if (!sameJson(projectGuard, snapshot.projectGuard)) {
    return reservedTaskSubmissionConflict(
      input,
      'accepted_configuration_changed',
      'Project repository configuration changed after task submission was accepted',
      snapshot.task.outputBranch
    );
  }

  const resolved = await resolvePlacementForInput(db, env, input, project);
  if ('reason' in resolved) {
    return reservedTaskSubmissionConflict(
      input,
      resolved.reason,
      resolved.message,
      snapshot.task.outputBranch
    );
  }

  if (
    !sameJson(profileGuard(resolved.profile), snapshot.profileGuard) ||
    !sameJson(placementGuard(resolved.placement), snapshot.placementGuard) ||
    !sameJson(credentialGuard(resolved.resolution), snapshot.credentialGuard)
  ) {
    return reservedTaskSubmissionConflict(
      input,
      'accepted_configuration_changed',
      'Resolved profile, placement or credential attribution changed after task submission was accepted',
      snapshot.task.outputBranch
    );
  }

  try {
    await deps.requireRepositoryAccess(
      env,
      db,
      project,
      input.userId,
      `${input.source.repositoryAccessFlow}-start`
    );
  } catch (error) {
    return reservedTaskSubmissionConflict(
      input,
      'authority_unavailable',
      error instanceof Error ? error.message : String(error),
      snapshot.task.outputBranch
    );
  }
  try {
    await assertTaskRunnerStartGuard(env, reservedSubmissionGuardFromSnapshot(snapshot), {
      requireQueuedTask: true,
    });
  } catch (error) {
    if (error instanceof TaskRunnerStartGuardRevokedError) {
      return reservedTaskSubmissionConflict(
        input,
        'authority_unavailable',
        error.message,
        snapshot.task.outputBranch
      );
    }
    return {
      outcome: 'pending',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      pendingAt: 'task_runner_start',
      reason: error instanceof Error ? error.message : String(error),
      reused,
    };
  }
  return null;
}

export function reservedSubmissionGuardFromSnapshot(
  snapshot: AcceptedSnapshot
): TaskRunnerReservedSubmissionGuard {
  return {
    kind: 'reserved_submission',
    taskId: snapshot.runner.taskId,
    projectId: snapshot.runner.projectId,
    userId: snapshot.runner.userId,
    chatSessionId: snapshot.runner.chatSessionId,
    intentFingerprint: snapshot.intentFingerprint,
    ...(snapshot.source.expiresAt === undefined ? {} : { expiresAt: snapshot.source.expiresAt }),
  };
}

export function startInputFromSnapshot(snapshot: AcceptedSnapshot): TaskRunnerStartInput {
  const runner = snapshot.runner;
  return {
    taskId: runner.taskId,
    projectId: runner.projectId,
    userId: runner.userId,
    vmSize: runner.vmSize,
    vmLocation: runner.vmLocation,
    branch: runner.branch,
    defaultBranch: runner.defaultBranch,
    userName: runner.userName,
    userEmail: runner.userEmail,
    githubId: runner.githubId,
    taskTitle: runner.taskTitle,
    taskDescription: runner.taskDescription,
    repository: runner.repository,
    installationId: runner.installationId,
    outputBranch: runner.outputBranch,
    projectDefaultVmSize: runner.projectDefaultVmSize,
    chatSessionId: runner.chatSessionId,
    agentType: runner.agentType,
    workspaceProfile: runner.workspaceProfile,
    devcontainerConfigName: runner.devcontainerConfigName,
    cloudProvider: runner.cloudProvider,
    explicitVmLocation: runner.explicitVmLocation,
    credentialAttributionUserId: runner.credentialAttributionUserId,
    credentialAttributionProjectId: runner.credentialAttributionProjectId,
    credentialAttributionSource: runner.credentialAttributionSource,
    taskMode: runner.taskMode,
    model: runner.model,
    effort: runner.effort,
    permissionMode: runner.permissionMode,
    opencodeProvider: runner.opencodeProvider,
    opencodeBaseUrl: runner.opencodeBaseUrl,
    systemPromptAppend: runner.systemPromptAppend,
    agentProfileHint: runner.agentProfileHint,
    projectScaling: runner.projectScaling,
    resolvedReservation: runner.resolvedReservation,
    capacityPoolSelection: runner.capacityPoolSelection,
    vmSizeSource: runner.vmSizeSource,
    startGuard: reservedSubmissionGuardFromSnapshot(snapshot),
  };
}
