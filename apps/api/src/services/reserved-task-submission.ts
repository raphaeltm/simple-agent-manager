/**
 * Retry-safe normal task submission adapter.
 *
 * Callers must durably reserve the immutable task/session/message/status identities
 * and source execution before invoking this adapter. The adapter records the D1
 * task, initial status event, and checkpoint in one batch, then reconciles the
 * ProjectData and TaskRunner boundaries by intent fingerprint on retry.
 */
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
import {
  isTaskMode,
  TASK_TERMINAL_STATUSES,
  TRIGGERED_BY_VALUES,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { log } from '../lib/logger';
import { generateBranchName } from './branch-name';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotDbValues,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import {
  PlacementResolutionError,
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
  type TaskStartCapacityPoolSelection,
  type TaskStartPlacement,
  type TaskStartPlacementWithCredential,
} from './placement-resolver';
import * as projectDataService from './project-data';
import { parseSkillResourceRequirementsJson, resolveSkillProfile } from './skills';
import { markQueuedTaskFailed } from './task-failure';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from './task-title';

const FINGERPRINT_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const MAX_RESERVED_ID_LENGTH = 160;
const TERMINAL_STATUSES = new Set<string>(TASK_TERMINAL_STATUSES);
const ALREADY_STARTED_STATUSES = new Set<string>(['delegated', 'in_progress']);
const SOURCE_KINDS = new Set<string>(['trigger', 'schedule', 'standing_watch']);
const TASK_ACTOR_TYPES = new Set<string>(['user', 'system', 'workspace_callback']);
const TRIGGERED_BY = new Set<string>(TRIGGERED_BY_VALUES);

type Db = DrizzleD1Database<typeof schema>;
type ResolvedProfile = Awaited<ReturnType<typeof resolveSkillProfile>> | null;
type TaskRunnerStartInput = Parameters<typeof startTaskRunnerDO>[1];

export interface ReservedTaskSubmissionIdentities {
  taskId: string;
  chatSessionId: string;
  initialMessageId: string;
  initialStatusEventId: string;
}

export type ReservedTaskSubmissionSourceKind = 'trigger' | 'schedule' | 'standing_watch';

export interface ReservedTaskSubmissionSourceProvenance {
  kind: ReservedTaskSubmissionSourceKind;
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

interface CheckpointRow {
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

interface TaskInsertValues {
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
  capacityPlacementSnapshot: ReturnType<typeof capacityPlacementSnapshotDbValues>;
}

interface TaskRunnerStartSnapshot {
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

interface AcceptedSnapshot {
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
  profileGuard: ReturnType<typeof profileGuard>;
  placementGuard: ReturnType<typeof placementGuard>;
  credentialGuard: ReturnType<typeof credentialGuard>;
}

interface PreparedSubmission {
  snapshot: AcceptedSnapshot;
  acceptedSnapshotJson: string;
}

function dependencySet(deps: ReservedTaskSubmissionDependencies) {
  return {
    startTaskRunner: deps.startTaskRunner ?? startTaskRunnerDO,
    ensureTaskRunnerStarted: deps.ensureTaskRunnerStarted ?? ensureTaskRunnerStarted,
    requireRepositoryAccess:
      deps.requireRepositoryAccess ??
      (async (...args: Parameters<NonNullable<ReservedTaskSubmissionDependencies['requireRepositoryAccess']>>) => {
        const { requireRepositoryOwnerAccess } = await import('../routes/projects/_helpers');
        return requireRepositoryOwnerAccess(...args);
      }),
    now: deps.now ?? (() => new Date().toISOString()),
    generateTitle: deps.generateTitle ?? generateTaskTitle,
    afterD1Commit: deps.afterD1Commit ?? (async () => {}),
    afterProjectDataCommit: deps.afterProjectDataCommit ?? (async () => {}),
    afterRunnerStartConfirmed: deps.afterRunnerStartConfirmed ?? (async () => {}),
  };
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  if (value.length > MAX_RESERVED_ID_LENGTH) {
    throw new Error(`${field} must be ${MAX_RESERVED_ID_LENGTH} characters or fewer`);
  }
  return value;
}

function validateInput(input: ReservedTaskSubmissionInput): string | null {
  try {
    nonEmpty(input.identities.taskId, 'identities.taskId');
    nonEmpty(input.identities.chatSessionId, 'identities.chatSessionId');
    nonEmpty(input.identities.initialMessageId, 'identities.initialMessageId');
    nonEmpty(input.identities.initialStatusEventId, 'identities.initialStatusEventId');
    nonEmpty(input.projectId, 'projectId');
    nonEmpty(input.userId, 'userId');
    nonEmpty(input.prompt, 'prompt');
    nonEmpty(input.branchNameSeed, 'branchNameSeed');
    if (!SOURCE_KINDS.has(input.source.kind)) {
      throw new Error(`source.kind is invalid: ${input.source.kind}`);
    }
    if (!TRIGGERED_BY.has(input.source.triggeredBy)) {
      throw new Error(`source.triggeredBy is invalid: ${input.source.triggeredBy}`);
    }
    if (!TASK_ACTOR_TYPES.has(input.source.initialStatusActorType)) {
      throw new Error(`source.initialStatusActorType is invalid: ${input.source.initialStatusActorType}`);
    }
    if (!isTaskMode(input.taskMode)) {
      throw new Error(`taskMode is invalid: ${input.taskMode}`);
    }
    nonEmpty(input.source.sourceId, 'source.sourceId');
    nonEmpty(input.source.sourceExecutionId, 'source.sourceExecutionId');
    nonEmpty(input.source.displayName, 'source.displayName');
    nonEmpty(input.source.repositoryAccessFlow, 'source.repositoryAccessFlow');
    nonEmpty(input.source.initialStatusReason, 'source.initialStatusReason');
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

async function submissionFingerprint(input: ReservedTaskSubmissionInput): Promise<string> {
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

function conflict(
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

async function readCheckpoint(db: D1Database, taskId: string): Promise<CheckpointRow | null> {
  return db
    .prepare(
      `SELECT c.task_id, c.project_id, c.user_id, c.chat_session_id, c.initial_message_id,
              c.initial_status_event_id, c.source_kind, c.source_id, c.source_execution_id,
              c.triggered_by, c.intent_fingerprint, c.accepted_snapshot_json, c.branch_name,
              c.task_title, c.checkpoint_state, c.project_data_committed_at,
              c.runner_start_attempted_at, c.runner_started_at,
              t.status AS task_status, t.error_message AS task_error_message,
              t.chat_session_id AS task_chat_session_id
         FROM task_submission_checkpoints c
         INNER JOIN tasks t ON t.id = c.task_id
        WHERE c.task_id = ?
        LIMIT 1`
    )
    .bind(taskId)
    .first<CheckpointRow>();
}

async function readTaskByIdentity(db: D1Database, input: ReservedTaskSubmissionInput): Promise<{
  id: string;
  status: string;
  chat_session_id: string | null;
} | null> {
  return db
    .prepare('SELECT id, status, chat_session_id FROM tasks WHERE id = ? LIMIT 1')
    .bind(input.identities.taskId)
    .first<{ id: string; status: string; chat_session_id: string | null }>();
}

async function readCheckpointByReservedIdentity(
  db: D1Database,
  input: ReservedTaskSubmissionInput
): Promise<Pick<CheckpointRow, 'task_id' | 'branch_name' | 'source_kind' | 'source_id' | 'source_execution_id'> | null> {
  return db
    .prepare(
      `SELECT task_id, branch_name, source_kind, source_id, source_execution_id
         FROM task_submission_checkpoints
        WHERE chat_session_id = ?
           OR initial_message_id = ?
           OR initial_status_event_id = ?
           OR (
             project_id = ?
             AND source_kind = ?
             AND source_id = ?
             AND source_execution_id = ?
           )
        LIMIT 1`
    )
    .bind(
      input.identities.chatSessionId,
      input.identities.initialMessageId,
      input.identities.initialStatusEventId,
      input.projectId,
      input.source.kind,
      input.source.sourceId,
      input.source.sourceExecutionId
    )
    .first<
      Pick<
        CheckpointRow,
        'task_id' | 'branch_name' | 'source_kind' | 'source_id' | 'source_execution_id'
      >
    >();
}

async function validateTriggerReservation(
  db: D1Database,
  input: ReservedTaskSubmissionInput
): Promise<ReservedTaskSubmissionResult | null> {
  if (input.source.kind !== 'trigger') return null;
  const row = await db
    .prepare(
      `SELECT task_id
         FROM trigger_executions
        WHERE id = ?
          AND trigger_id = ?
          AND project_id = ?
        LIMIT 1`
    )
    .bind(input.source.sourceExecutionId, input.source.sourceId, input.projectId)
    .first<{ task_id: string | null }>();
  if (!row) {
    return conflict(
      input,
      'source_reservation_missing',
      `Trigger execution ${input.source.sourceExecutionId} is not reserved`
    );
  }
  if (row.task_id && row.task_id !== input.identities.taskId) {
    return conflict(
      input,
      'source_reservation_conflict',
      `Trigger execution ${input.source.sourceExecutionId} is already linked to task ${row.task_id}`
    );
  }
  return null;
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

function profileGuard(profile: ResolvedProfile): {
  profileId: string | null;
  skillId: string | null;
  skillHint: string | null;
  agentType: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  resourceRequirementsJson: string | null;
} {
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

function placementGuard(placement: TaskStartPlacement): {
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
} {
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

function credentialGuard(resolution: TaskStartPlacementWithCredential): {
  effectiveProvider: string;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
  quotaCredentialSource: CredentialSource;
  capacityPlacementSnapshot: TaskStartPlacementWithCredential['capacityPlacementSnapshot'];
} {
  return {
    effectiveProvider: resolution.effectiveProvider,
    credentialAttributionUserId: resolution.credentialAttributionUserId,
    credentialAttributionProjectId: resolution.credentialAttributionProjectId,
    credentialAttributionSource: resolution.credentialAttributionSource,
    quotaCredentialSource: resolution.quotaCredentialSource,
    capacityPlacementSnapshot: resolution.capacityPlacementSnapshot,
  };
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
        vmSizeSource: 'trigger',
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

async function prepareNewSubmission(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  intentFingerprint: string,
  deps: ReturnType<typeof dependencySet>
): Promise<PreparedSubmission | ReservedTaskSubmissionResult> {
  const project = await loadProject(db, input.projectId);
  if (!project) {
    return conflict(input, 'project_not_found', `Project ${input.projectId} not found`);
  }

  const resolved = await resolvePlacementForInput(db, env, input, project);
  if ('reason' in resolved) return conflict(input, resolved.reason, resolved.message);

  try {
    await deps.requireRepositoryAccess(
      env,
      db,
      project,
      input.userId,
      `${input.source.repositoryAccessFlow}-admission`
    );
  } catch (error) {
    return conflict(
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
  const capacityValues = capacityPlacementSnapshotDbValues(resolution.capacityPlacementSnapshot);
  const task: TaskInsertValues = {
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
    capacityPlacementSnapshot: capacityValues,
  };
  const runner: TaskRunnerStartSnapshot = {
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

function parseAcceptedSnapshot(row: CheckpointRow): AcceptedSnapshot | null {
  try {
    const parsed = JSON.parse(row.accepted_snapshot_json) as AcceptedSnapshot;
    if (parsed?.version !== SNAPSHOT_VERSION) return null;
    if (parsed.task?.taskId !== row.task_id) return null;
    if (parsed.task?.chatSessionId !== row.chat_session_id) return null;
    if (parsed.intentFingerprint !== row.intent_fingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function revalidateBeforePhysicalStart(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ReturnType<typeof dependencySet>
): Promise<ReservedTaskSubmissionResult | null> {
  const project = await loadProject(db, input.projectId);
  if (!project) {
    return conflict(input, 'project_not_found', `Project ${input.projectId} not found`, snapshot.task.outputBranch);
  }
  const projectGuard = {
    repository: project.repository,
    installationId: project.installationId,
    defaultBranch: project.defaultBranch,
  };
  if (!sameJson(projectGuard, snapshot.projectGuard)) {
    return conflict(
      input,
      'accepted_configuration_changed',
      'Project repository configuration changed after task submission was accepted',
      snapshot.task.outputBranch
    );
  }

  const resolved = await resolvePlacementForInput(db, env, input, project);
  if ('reason' in resolved) {
    return conflict(input, resolved.reason, resolved.message, snapshot.task.outputBranch);
  }

  if (
    !sameJson(profileGuard(resolved.profile), snapshot.profileGuard) ||
    !sameJson(placementGuard(resolved.placement), snapshot.placementGuard) ||
    !sameJson(credentialGuard(resolved.resolution), snapshot.credentialGuard)
  ) {
    return conflict(
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
    return conflict(
      input,
      'authority_unavailable',
      error instanceof Error ? error.message : String(error),
      snapshot.task.outputBranch
    );
  }
  return null;
}

async function commitD1Submission(
  env: Env,
  input: ReservedTaskSubmissionInput,
  fingerprint: string,
  prepared: PreparedSubmission,
  now: string
): Promise<void> {
  const t = prepared.snapshot.task;
  const capacity = t.capacityPlacementSnapshot;
  const insertTask = env.DATABASE.prepare(
    `INSERT INTO tasks (
       id, project_id, user_id, chat_session_id, title, description, status, execution_step,
       priority, agent_profile_hint, skill_id, skill_hint, task_mode, output_branch,
       triggered_by, trigger_id, trigger_execution_id, requested_vm_size, requested_vm_size_source,
       resource_requirements_json, resource_requirements_source, resolved_reservation_json,
       credential_attribution_user_id, credential_attribution_project_id, credential_attribution_source,
       ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
       created_by, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, 'queued', 'node_selection',
       0, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
       ?, ?, ?
     )`
  ).bind(
    t.taskId,
    t.projectId,
    t.userId,
    t.chatSessionId,
    t.title,
    t.description,
    t.agentProfileHint,
    t.skillId,
    t.skillHint,
    t.taskMode,
    t.outputBranch,
    t.triggeredBy,
    t.triggerId,
    t.triggerExecutionId,
    t.requestedVmSize,
    t.requestedVmSizeSource,
    t.resourceRequirementsJson,
    t.resourceRequirementsSource,
    t.resolvedReservationJson,
    t.credentialAttributionUserId,
    t.credentialAttributionProjectId,
    t.credentialAttributionSource,
    ...capacityPlacementSnapshotSqlValues(capacity),
    t.userId,
    now,
    now
  );
  const insertStatus = env.DATABASE.prepare(
    `INSERT INTO task_status_events
       (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', ?, ?, ?, ?)`
  ).bind(
    input.identities.initialStatusEventId,
    input.identities.taskId,
    input.source.initialStatusActorType,
    input.source.initialStatusActorId,
    input.source.initialStatusReason,
    now
  );
  const insertCheckpoint = env.DATABASE.prepare(
    `INSERT INTO task_submission_checkpoints
       (task_id, project_id, user_id, chat_session_id, initial_message_id,
        initial_status_event_id, source_kind, source_id, source_execution_id, triggered_by,
        intent_fingerprint, accepted_snapshot_json, branch_name, task_title,
        checkpoint_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1_committed', ?, ?)`
  ).bind(
    input.identities.taskId,
    input.projectId,
    input.userId,
    input.identities.chatSessionId,
    input.identities.initialMessageId,
    input.identities.initialStatusEventId,
    input.source.kind,
    input.source.sourceId,
    input.source.sourceExecutionId,
    input.source.triggeredBy,
    fingerprint,
    prepared.acceptedSnapshotJson,
    prepared.snapshot.task.outputBranch,
    prepared.snapshot.task.title,
    now,
    now
  );

  if (input.source.kind === 'trigger') {
    const linkSource = env.DATABASE.prepare(
      `UPDATE trigger_executions
          SET task_id = ?
        WHERE id = ?
          AND trigger_id = ?
          AND project_id = ?
          AND (task_id IS NULL OR task_id = ?)`
    ).bind(
      input.identities.taskId,
      input.source.sourceExecutionId,
      input.source.sourceId,
      input.projectId,
      input.identities.taskId
    );
    await env.DATABASE.batch([insertTask, insertStatus, insertCheckpoint, linkSource]);
    return;
  }

  await env.DATABASE.batch([insertTask, insertStatus, insertCheckpoint]);
}

async function markProjectDataCommitted(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET checkpoint_state = CASE
              WHEN checkpoint_state = 'd1_committed' THEN 'project_data_committed'
              ELSE checkpoint_state
            END,
            project_data_committed_at = COALESCE(project_data_committed_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function markRunnerStartAttempted(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET checkpoint_state = 'start_pending',
            runner_start_attempted_at = COALESCE(runner_start_attempted_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function markRunnerStarted(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET checkpoint_state = 'start_confirmed',
            runner_started_at = COALESCE(runner_started_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function markTerminalObserved(env: Env, taskId: string, now: string): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE task_submission_checkpoints
        SET terminal_observed_at = COALESCE(terminal_observed_at, ?),
            updated_at = ?
      WHERE task_id = ?`
  )
    .bind(now, now, taskId)
    .run();
}

async function ensureProjectDataBoundary(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ReturnType<typeof dependencySet>,
  reused: boolean
): Promise<ReservedTaskSubmissionResult | null> {
  try {
    const result = await projectDataService.createReservedTaskSessionWithInitialMessage(
      env,
      input.projectId,
      {
        sessionId: input.identities.chatSessionId,
        workspaceId: null,
        topic: snapshot.task.title,
        taskId: input.identities.taskId,
        createdByUserId: input.userId,
        initialMessageId: input.identities.initialMessageId,
        initialMessageRole: 'user',
        initialMessageContent: input.prompt,
        initialMessageToolMetadata: null,
      }
    );
    if (result.outcome === 'conflict') {
      return conflict(input, 'project_data_conflict', result.message, snapshot.task.outputBranch);
    }
    await markProjectDataCommitted(env, input.identities.taskId, deps.now());
    return null;
  } catch (error) {
    log.warn('reserved_task_submission.project_data_pending', {
      taskId: input.identities.taskId,
      projectId: input.projectId,
      sourceKind: input.source.kind,
      sourceId: input.source.sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'pending',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      pendingAt: 'project_data',
      reason: 'ProjectData session/message commit could not be confirmed',
      reused,
    };
  }
}

async function failUnstartedTask(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  reason: string,
  now: string,
  reused: boolean
): Promise<ReservedTaskSubmissionResult> {
  const changed = await markQueuedTaskFailed(dbForEnv(env), input.identities.taskId, reason, {
    env,
    projectId: input.projectId,
    source: 'reserved_task_submission.task_runner_startup',
    sessionId: input.identities.chatSessionId,
  });
  if (changed) {
    await projectDataService
      .stopSession(env, input.projectId, input.identities.chatSessionId)
      .catch((error) => {
        log.warn('reserved_task_submission.orphaned_session_stop_failed', {
          taskId: input.identities.taskId,
          projectId: input.projectId,
          sessionId: input.identities.chatSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  await markTerminalObserved(env, input.identities.taskId, now);
  return {
    outcome: 'terminal',
    taskId: input.identities.taskId,
    sessionId: input.identities.chatSessionId,
    branchName: snapshot.task.outputBranch,
    status: 'failed',
    reason,
    reused,
  };
}

function dbForEnv(env: Env): Db {
  return drizzle(env.DATABASE, { schema });
}

function startInputFromSnapshot(snapshot: AcceptedSnapshot): TaskRunnerStartInput {
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
  };
}

async function startOrConfirmRunner(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ReturnType<typeof dependencySet>,
  reused: boolean,
  existingStartAttempted: boolean
): Promise<ReservedTaskSubmissionResult> {
  if (existingStartAttempted) {
    try {
      if (await deps.ensureTaskRunnerStarted(env, input.identities.taskId)) {
        await markRunnerStarted(env, input.identities.taskId, deps.now());
        return {
          outcome: 'admitted',
          taskId: input.identities.taskId,
          sessionId: input.identities.chatSessionId,
          branchName: snapshot.task.outputBranch,
          startState: 'confirmed_after_lost_ack',
          reused,
        };
      }
    } catch (error) {
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
  }

  await markRunnerStartAttempted(env, input.identities.taskId, deps.now());
  try {
    await deps.startTaskRunner(env, startInputFromSnapshot(snapshot));
    await markRunnerStarted(env, input.identities.taskId, deps.now());
    return {
      outcome: 'admitted',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: snapshot.task.outputBranch,
      startState: 'started',
      reused,
    };
  } catch (startError) {
    let durableStart: boolean;
    try {
      durableStart = await deps.ensureTaskRunnerStarted(env, input.identities.taskId);
    } catch (statusError) {
      log.warn('reserved_task_submission.task_runner_status_check_failed', {
        taskId: input.identities.taskId,
        projectId: input.projectId,
        sourceKind: input.source.kind,
        sourceId: input.source.sourceId,
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
      return {
        outcome: 'pending',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
        branchName: snapshot.task.outputBranch,
        pendingAt: 'task_runner_start',
        reason: 'TaskRunner start confirmation is unavailable',
        reused,
      };
    }
    if (durableStart) {
      await markRunnerStarted(env, input.identities.taskId, deps.now());
      log.warn('reserved_task_submission.task_runner_start_ack_lost', {
        taskId: input.identities.taskId,
        projectId: input.projectId,
        sourceKind: input.source.kind,
        sourceId: input.source.sourceId,
      });
      return {
        outcome: 'admitted',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
        branchName: snapshot.task.outputBranch,
        startState: 'confirmed_after_lost_ack',
        reused,
      };
    }
    const message = startError instanceof Error ? startError.message : String(startError);
    return failUnstartedTask(
      env,
      input,
      snapshot,
      `Task runner startup failed: ${message}`,
      deps.now(),
      reused
    );
  }
}

async function runTaskRunnerBoundary(
  env: Env,
  input: ReservedTaskSubmissionInput,
  snapshot: AcceptedSnapshot,
  deps: ReturnType<typeof dependencySet>,
  reused: boolean,
  existingStartAttempted: boolean
): Promise<ReservedTaskSubmissionResult> {
  const result = await startOrConfirmRunner(
    env,
    input,
    snapshot,
    deps,
    reused,
    existingStartAttempted
  );
  if (result.outcome === 'admitted' && result.startState !== 'already_started') {
    await deps.afterRunnerStartConfirmed();
  }
  return result;
}

async function reconcileCheckpoint(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  row: CheckpointRow,
  fingerprint: string,
  deps: ReturnType<typeof dependencySet>
): Promise<ReservedTaskSubmissionResult> {
  if (row.intent_fingerprint !== fingerprint) {
    return conflict(
      input,
      'intent_fingerprint_mismatch',
      `Task identity ${input.identities.taskId} is already reserved for a different submission intent`,
      row.branch_name
    );
  }
  if (
    row.project_id !== input.projectId ||
    row.user_id !== input.userId ||
    row.chat_session_id !== input.identities.chatSessionId ||
    row.initial_message_id !== input.identities.initialMessageId ||
    row.initial_status_event_id !== input.identities.initialStatusEventId ||
    row.source_kind !== input.source.kind ||
    row.source_id !== input.source.sourceId ||
    row.source_execution_id !== input.source.sourceExecutionId ||
    row.triggered_by !== input.source.triggeredBy ||
    row.task_chat_session_id !== input.identities.chatSessionId
  ) {
    return conflict(
      input,
      'identity_reuse_conflict',
      `Task identity ${input.identities.taskId} checkpoint does not match the reserved identities`,
      row.branch_name
    );
  }
  const snapshot = parseAcceptedSnapshot(row);
  if (!snapshot) {
    return conflict(
      input,
      'malformed_checkpoint',
      `Task identity ${input.identities.taskId} has a malformed submission checkpoint`,
      row.branch_name
    );
  }
  if (TERMINAL_STATUSES.has(row.task_status)) {
    await markTerminalObserved(env, input.identities.taskId, deps.now());
    return {
      outcome: 'terminal',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: row.branch_name,
      status: row.task_status as TaskTerminalStatus,
      reason: row.task_error_message,
      reused: true,
    };
  }
  if (ALREADY_STARTED_STATUSES.has(row.task_status)) {
    return {
      outcome: 'admitted',
      taskId: input.identities.taskId,
      sessionId: input.identities.chatSessionId,
      branchName: row.branch_name,
      startState: 'already_started',
      reused: true,
    };
  }

  const projectDataPending = await ensureProjectDataBoundary(env, input, snapshot, deps, true);
  if (projectDataPending) return projectDataPending;
  await deps.afterProjectDataCommit();

  const revalidationConflict = await revalidateBeforePhysicalStart(env, db, input, snapshot, deps);
  if (revalidationConflict) return revalidationConflict;

  return runTaskRunnerBoundary(
    env,
    input,
    snapshot,
    deps,
    true,
    row.runner_start_attempted_at !== null || row.runner_started_at !== null
  );
}

async function reconcileD1InsertConflict(
  env: Env,
  db: Db,
  input: ReservedTaskSubmissionInput,
  fingerprint: string,
  deps: ReturnType<typeof dependencySet>,
  error: unknown
): Promise<ReservedTaskSubmissionResult> {
  const row = await readCheckpoint(env.DATABASE, input.identities.taskId);
  if (row) return reconcileCheckpoint(env, db, input, row, fingerprint, deps);

  const identityCheckpoint = await readCheckpointByReservedIdentity(env.DATABASE, input);
  if (identityCheckpoint) {
    const sourceMatches =
      identityCheckpoint.source_kind === input.source.kind &&
      identityCheckpoint.source_id === input.source.sourceId &&
      identityCheckpoint.source_execution_id === input.source.sourceExecutionId;
    return conflict(
      input,
      sourceMatches ? 'source_reservation_conflict' : 'identity_reuse_conflict',
      sourceMatches
        ? `Source reservation ${input.source.kind}:${input.source.sourceExecutionId} is already linked to task ${identityCheckpoint.task_id}`
        : 'One or more reserved identities already belong to a different task submission',
      identityCheckpoint.branch_name
    );
  }

  const task = await readTaskByIdentity(env.DATABASE, input);
  if (task) {
    return conflict(
      input,
      'identity_reuse_conflict',
      `Task identity ${input.identities.taskId} already exists without a reserved submission checkpoint`,
      null
    );
  }
  throw error;
}

export async function submitReservedTask(
  env: Env,
  input: ReservedTaskSubmissionInput,
  dependencyOverrides: ReservedTaskSubmissionDependencies = {}
): Promise<ReservedTaskSubmissionResult> {
  const validationError = validateInput(input);
  if (validationError) return conflict(input, 'invalid_input', validationError);

  const deps = dependencySet(dependencyOverrides);
  const db = dbForEnv(env);
  const fingerprint = await submissionFingerprint(input);

  const existing = await readCheckpoint(env.DATABASE, input.identities.taskId);
  if (existing) {
    return reconcileCheckpoint(env, db, input, existing, fingerprint, deps);
  }

  const sourceConflict = await validateTriggerReservation(env.DATABASE, input);
  if (sourceConflict) return sourceConflict;

  const prepared = await prepareNewSubmission(env, db, input, fingerprint, deps);
  if ('outcome' in prepared) return prepared;

  try {
    await commitD1Submission(env, input, fingerprint, prepared, deps.now());
  } catch (error) {
    return reconcileD1InsertConflict(env, db, input, fingerprint, deps, error);
  }
  await deps.afterD1Commit();

  const projectDataPending = await ensureProjectDataBoundary(
    env,
    input,
    prepared.snapshot,
    deps,
    false
  );
  if (projectDataPending) return projectDataPending;
  await deps.afterProjectDataCommit();

  const revalidationConflict = await revalidateBeforePhysicalStart(
    env,
    db,
    input,
    prepared.snapshot,
    deps
  );
  if (revalidationConflict) return revalidationConflict;

  return runTaskRunnerBoundary(env, input, prepared.snapshot, deps, false, false);
}

export function reservedIdentitiesForTriggerExecution(
  triggerExecutionId: string
): ReservedTaskSubmissionIdentities {
  return {
    taskId: triggerExecutionId,
    chatSessionId: `chat_${triggerExecutionId}`,
    initialMessageId: `msg_${triggerExecutionId}`,
    initialStatusEventId: `status_${triggerExecutionId}`,
  };
}
