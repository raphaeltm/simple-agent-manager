/**
 * Trigger Task Submission Bridge
 *
 * Bridges from trigger execution to the existing TaskRunner pipeline.
 * Called by both the cron sweep engine and the manual "Run Now" endpoint.
 *
 * Flow: trigger fires → submitTriggeredTask() → creates task + session → starts TaskRunner DO
 */
import type { TaskMode, TriggeredBy, VMSize } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { requireRepositoryOwnerAccess } from '../routes/projects/_helpers';
import { generateBranchName } from './branch-name';
import { capacityPlacementSnapshotDbValues } from './capacity-placement-snapshot';
import {
  capacityPlacementSnapshotForTaskStart,
  PlacementResolutionError,
  resolveCapacityAwareCredentialLookup,
  resolveCapacityPlacementCredentialAttribution,
  resolvePlacementCredentialAttribution,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from './placement-resolver';
import * as projectDataService from './project-data';
import { parseSkillResourceRequirementsJson, resolveSkillProfile } from './skills';
import { markQueuedTaskFailed } from './task-failure';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from './task-title';
import { type SubmittedTriggerTask, TriggerTaskSubmissionPendingError } from './trigger-submission';

export { TriggerTaskSubmissionPendingError } from './trigger-submission';
export type SubmitTriggeredTaskResult = SubmittedTriggerTask;

export interface SubmitTriggeredTaskInput {
  /** The trigger that's firing. */
  triggerId: string;
  /** The execution record ID. */
  triggerExecutionId: string;
  /** Project this trigger belongs to. */
  projectId: string;
  /** User who owns the trigger. */
  userId: string;
  /** The rendered prompt to use as the task description. */
  renderedPrompt: string;
  /** How the task was triggered (e.g., 'cron'). */
  triggeredBy: Exclude<TriggeredBy, 'mcp'>;
  /** Agent profile ID to use (from trigger config). */
  agentProfileId: string | null;
  /** Skill ID to use (from trigger config). */
  skillId: string | null;
  /** Task execution mode from trigger config. */
  taskMode: TaskMode;
  /** VM size override from trigger config. */
  vmSizeOverride: string | null;
  /** Trigger name (for branch naming). */
  triggerName: string;
}

/**
 * Submit a task from a trigger execution. Resolves project config,
 * user credentials, agent profile, and starts the TaskRunner DO.
 */
export async function submitTriggeredTask(
  env: Env,
  input: SubmitTriggeredTaskInput
): Promise<SubmittedTriggerTask> {
  const db = drizzle(env.DATABASE, { schema });

  // Resolve project config
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .limit(1);

  if (!project) {
    throw new Error(`Project ${input.projectId} not found`);
  }

  // Resolve agent profile if specified
  const resolvedProfile =
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
  const skillResourceRequirements = parseSkillResourceRequirementsJson(
    resolvedProfile?.resourceRequirementsJson
  );

  const taskId = ulid();
  const placement = (() => {
    try {
      return resolveTaskStartPlacement({
        entryPoint: 'trigger-submit',
        taskId,
        triggerId: input.triggerId,
        projectId: input.projectId,
        userId: input.userId,
        project,
        profile: resolvedProfile,
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
        throw new Error(err.message);
      }
      throw err;
    }
  })();

  const { resolveCredentialSource } = await import('./provider-credentials');
  const capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement);
  const credentialLookup = resolveCapacityAwareCredentialLookup(placement, capacityPoolSelection);
  const credResult = await resolveCredentialSource(
    db,
    credentialLookup.userId,
    credentialLookup.provider,
    credentialLookup.projectId
  );
  if (!credResult) {
    throw new Error(`No cloud provider credentials available for trigger ${input.triggerId}`);
  }
  const {
    effectiveProvider,
    credentialAttributionUserId,
    credentialAttributionProjectId,
    credentialAttributionSource,
  } = capacityPoolSelection?.candidates[0]
    ? resolveCapacityPlacementCredentialAttribution(placement, capacityPoolSelection.candidates[0])
    : resolvePlacementCredentialAttribution(placement, credResult);
  const capacityPlacementSnapshot = capacityPlacementSnapshotForTaskStart(capacityPoolSelection);
  const {
    vmSize,
    vmSizeSource,
    vmLocation,
    workspaceProfile,
    devcontainerConfigName,
    taskMode,
    resolvedReservation,
    agentType,
  } = placement;

  // Generate branch name from trigger name + date
  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(input.triggerName, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Generate concise task title
  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = await generateTaskTitle(env, input.renderedPrompt, titleConfig);

  const now = new Date().toISOString();

  // Create task in D1 with trigger metadata
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: input.projectId,
    userId: input.userId,
    title: taskTitle,
    description: input.renderedPrompt,
    status: 'queued',
    executionStep: 'node_selection',
    priority: 0,
    agentProfileHint: resolvedProfile?.profileId ?? null,
    skillId: resolvedProfile?.skillId ?? null,
    skillHint: input.skillId,
    taskMode,
    outputBranch: branchName,
    triggeredBy: input.triggeredBy,
    triggerId: input.triggerId,
    triggerExecutionId: input.triggerExecutionId,
    requestedVmSize: vmSize,
    requestedVmSizeSource: vmSizeSource,
    resourceRequirementsJson: resolvedProfile?.resourceRequirementsJson ?? null,
    resourceRequirementsSource: resolvedReservation.source,
    resolvedReservationJson: JSON.stringify(resolvedReservation),
    credentialAttributionUserId,
    credentialAttributionProjectId,
    credentialAttributionSource,
    ...capacityPlacementSnapshotDbValues(capacityPlacementSnapshot),
    createdBy: input.userId,
    createdAt: now,
    updatedAt: now,
  });

  // Record status event: null -> queued
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: null,
    toStatus: 'queued',
    actorType: 'system',
    actorId: null,
    reason: `Triggered by ${input.triggeredBy} (trigger: ${input.triggerId})`,
    createdAt: now,
  });

  // Create chat session
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      env,
      input.projectId,
      null, // workspaceId — linked later by TaskRunner DO
      taskTitle,
      taskId,
      input.userId
    );

    // Persist the rendered prompt as the initial user message
    await projectDataService.persistMessage(
      env,
      input.projectId,
      sessionId,
      'user',
      input.renderedPrompt,
      null
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await markQueuedTaskFailed(db, taskId, `Session creation failed: ${errorMsg}`);
    throw err;
  }

  // Look up user's githubId for noreply email fallback
  const [userRow] = await db
    .select({ githubId: schema.users.githubId, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);

  const branch = project.defaultBranch;

  // Start TaskRunner DO
  try {
    await requireRepositoryOwnerAccess(
      env,
      db,
      project,
      input.userId,
      `trigger-${input.triggeredBy}`
    );
    try {
      await startTaskRunnerDO(env, {
        taskId,
        projectId: input.projectId,
        userId: input.userId,
        vmSize,
        vmLocation,
        branch,
        defaultBranch: project.defaultBranch,
        userName: userRow?.name ?? null,
        userEmail: userRow?.email ?? null,
        githubId: userRow?.githubId ?? null,
        taskTitle,
        taskDescription: input.renderedPrompt,
        repository: project.repository,
        installationId: project.installationId,
        outputBranch: branchName,
        projectDefaultVmSize: project.defaultVmSize as VMSize | null,
        chatSessionId: sessionId,
        agentType,
        workspaceProfile,
        devcontainerConfigName,
        cloudProvider: effectiveProvider,
        credentialAttributionUserId,
        credentialAttributionProjectId,
        credentialAttributionSource,
        taskMode,
        model: resolvedProfile?.model ?? null,
        effort: resolvedProfile?.effort ?? null,
        permissionMode: resolvedProfile?.permissionMode ?? null,
        // OpenCode settings: VM agent fetches user-level settings via callback
        opencodeProvider: null,
        opencodeBaseUrl: null,
        systemPromptAppend: resolvedProfile?.systemPromptAppend ?? null,
        agentProfileHint: resolvedProfile?.profileId ?? null,
        projectScaling: {
          taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
          maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
          nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
          nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
          warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
        },
        resolvedReservation,
        capacityPoolSelection,
        vmSizeSource,
      });
    } catch (startError) {
      let durableStart: boolean;
      try {
        durableStart = await ensureTaskRunnerStarted(env, taskId);
      } catch (statusError) {
        log.warn('trigger_submit.task_runner_status_check_failed', {
          taskId,
          triggerId: input.triggerId,
          triggerExecutionId: input.triggerExecutionId,
          error: statusError instanceof Error ? statusError.message : String(statusError),
        });
        throw new TriggerTaskSubmissionPendingError({ taskId, sessionId, branchName });
      }
      if (!durableStart) throw startError;
      log.warn('trigger_submit.task_runner_start_ack_lost', {
        taskId,
        triggerId: input.triggerId,
        triggerExecutionId: input.triggerExecutionId,
      });
    }
  } catch (err) {
    if (err instanceof TriggerTaskSubmissionPendingError) throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await markQueuedTaskFailed(db, taskId, `Task runner startup failed: ${errorMsg}`);
    // Stop orphaned session (best-effort)
    await projectDataService.stopSession(env, input.projectId, sessionId).catch(() => {});
    throw err;
  }

  log.info('trigger_submit.created', {
    taskId,
    triggerId: input.triggerId,
    triggerExecutionId: input.triggerExecutionId,
    projectId: input.projectId,
    sessionId,
    branchName,
    vmSize,
    vmLocation,
    triggeredBy: input.triggeredBy,
  });

  return { taskId, sessionId, branchName };
}
