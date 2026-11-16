/** VM submission after shared input validation and runtime resolution. */
import { type requireOpenIdeaForWorkStart } from '@simple-agent-manager/operations';
import {
  collectStoredResourceRequirementLayers,
  createPersistedTaskResourcePlanJson,
  firstResourceRequirementLayer,
  firstResourceRequirementLayerJson,
  mergeResourceRequirementLayers,
  type normalizeResourceRequirementsInput,
  ResourceRequirementsValidationError,
} from '@simple-agent-manager/scheduler-core';
import type { SubmitTaskResponse, VMSize } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { markTaskSubmitOperation, type TaskSubmitOperation } from '../lib/task-submit-diagnostics';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { type SubmitTaskSchema } from '../schemas';
import { resolveTaskAgentOverrides } from '../services/agent-profiles';
import { capacityPlacementSnapshotDbValues } from '../services/capacity-placement-snapshot';
import { enrichMessageWithMentions } from '../services/mention-enrichment';
import {
  PlacementResolutionError,
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
} from '../services/placement-resolver';
import { resolveProjectAgentDefault } from '../services/project-agent-defaults';
import * as projectDataService from '../services/project-data';
import { validateRunAgentConfiguration } from '../services/run-agent-configuration';
import { type resolveSkillProfile } from '../services/skills';
import { markTaskFailedIfNonTerminal } from '../services/task-failure';
import { startTaskRunnerDO } from '../services/task-runner-do';
import { getTaskTitleConfig } from '../services/task-title';
import { type buildArchivedForkContext } from './archived-chat-fork';
import { type SamDispatchReservation } from './sam-dispatch-reservation';
import {
  enforcePlatformQuota,
  linkVmTaskSourceIdea,
  persistVmTaskSession,
} from './submit-vm-task-effects';
import { getInitialTaskTitle, schedulePostSubmitWork } from './task-submit-title';

export type SubmitVmTaskInput = {
  env: Env;
  user: { id: string; name: string | null; email: string };
  projectId: string;
  body: v.InferOutput<typeof SubmitTaskSchema>;
  waitUntil: (promise: Promise<unknown>) => void;
  via: string;
  clientName: string | undefined;
  samReservation: SamDispatchReservation | undefined;
  assertEffectAllowed: (() => Promise<void>) | undefined;
  beforeTaskEffects: () => void;
  setOperation: (operation: TaskSubmitOperation) => void;
  getOperation: () => TaskSubmitOperation;
  project: schema.Project;
  taskResourceRequirements: ReturnType<typeof normalizeResourceRequirementsInput> | undefined;
  validatedAttachments: import('@simple-agent-manager/shared').TaskAttachment[];
  fork: Awaited<ReturnType<typeof buildArchivedForkContext>> | null;
  inheritedAttributionUserId: string | null;
  inheritedAttributionProjectId: string | null;
  inheritedAttributionSource: import('@simple-agent-manager/shared').CredentialSource | null;
  message: string;
  taskId: string;
  now: string;
  branchName: string;
  sourceIdea: Awaited<ReturnType<typeof requireOpenIdeaForWorkStart>> | null;
  resolvedProfile: Awaited<ReturnType<typeof resolveSkillProfile>> | null;
};

export async function submitVmTask(input: SubmitVmTaskInput): Promise<SubmitTaskResponse> {
  const {
    env,
    user,
    projectId,
    body,
    waitUntil,
    via,
    clientName,
    samReservation,
    assertEffectAllowed,
    beforeTaskEffects,
    setOperation,
    getOperation,
    project,
    taskResourceRequirements,
    validatedAttachments,
    fork,
    inheritedAttributionUserId,
    inheritedAttributionProjectId,
    inheritedAttributionSource,
    message,
    taskId,
    now,
    branchName,
    resolvedProfile,
  } = input;
  const userId = user.id;
  const db = drizzle(env.DATABASE, { schema });
  const {
    resourceRequirementLayers,
    persistedResourceRequirementsJson,
    taskRunnerResourceRequirements,
  } = (() => {
    try {
      const layers = mergeResourceRequirementLayers(
        collectStoredResourceRequirementLayers({
          skill: resolvedProfile?.skillId ? resolvedProfile.resourceRequirementsJson : null,
          agentProfile:
            resolvedProfile?.agentProfileResourceRequirementsJson ??
            (resolvedProfile?.skillId ? null : resolvedProfile?.resourceRequirementsJson),
          project: project.resourceRequirementsJson,
        }),
        {
          task: taskResourceRequirements,
        }
      );
      return {
        resourceRequirementLayers: layers,
        persistedResourceRequirementsJson: firstResourceRequirementLayerJson(layers),
        taskRunnerResourceRequirements: firstResourceRequirementLayer(layers),
      };
    } catch (err) {
      if (err instanceof ResourceRequirementsValidationError) {
        throw errors.badRequest(err.message);
      }
      throw err;
    }
  })();
  const placement = (() => {
    try {
      return resolveTaskStartPlacement({
        entryPoint: 'task-submit',
        taskId,
        projectId,
        userId,
        project,
        profile: resolvedProfile,
        explicit: {
          vmSize: body.vmSize ?? null,
          vmSizeSource: 'task',
          provider: body.provider ?? null,
          vmLocation: body.vmLocation ?? null,
          workspaceProfile: body.workspaceProfile ?? null,
          devcontainerConfigName: body.devcontainerConfigName,
          taskMode: body.taskMode ?? null,
          agentType: body.agentType ?? null,
        },
        inheritedCredentialAttribution: {
          userId: inheritedAttributionUserId,
          projectId: inheritedAttributionProjectId,
          source: inheritedAttributionSource,
        },
        credentialProjectPolicy: 'current-project-unless-inherited',
        taskModeDefault: 'workspace-profile',
        resourceRequirements: resourceRequirementLayers,
      });
    } catch (err) {
      if (err instanceof PlacementResolutionError) {
        throw errors.badRequest(err.message);
      }
      throw err;
    }
  })();
  setOperation('placement_credentials');
  const placementResolution = await resolveTaskStartPlacementCredentialAttributionFromPlacement(
    db,
    placement,
    {
      credentialsRequiredMessage:
        'Cloud provider credentials required. Connect your account in Settings.',
      env: env,
    }
  );
  if ('error' in placementResolution) {
    if (placementResolution.errorKind === 'credentials') {
      throw errors.forbidden(placementResolution.error);
    }
    throw errors.badRequest(placementResolution.error);
  }
  const {
    capacityPoolSelection,
    quotaCredentialSource,
    capacityPlacementSnapshot,
    effectiveProvider,
    credentialAttributionUserId,
    credentialAttributionProjectId,
    credentialAttributionSource,
  } = placementResolution;
  await enforcePlatformQuota(input, db, quotaCredentialSource);
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
  const persistedResourceRequirementPlanJson = createPersistedTaskResourcePlanJson({
    layers: resourceRequirementLayers,
    resolvedReservation,
    requestedVmSize: vmSize,
    requestedVmSizeSource: vmSizeSource,
  });
  const projectAgentDefaults = resolveProjectAgentDefault(project.agentDefaults, agentType);
  // Validate overrides against the agent the runner will launch, before task effects.
  const launchAgentType = agentType || env.DEFAULT_TASK_AGENT_TYPE || 'opencode';
  const agentRun = resolveTaskAgentOverrides(launchAgentType, body, {
    model: resolvedProfile?.model ?? projectAgentDefaults.model,
    effort: resolvedProfile?.effort,
  });
  setOperation('run_account');
  const agentConfigurationId = await validateRunAgentConfiguration(db, {
    userId,
    configurationId: body.agentConfigurationId,
    agentType: launchAgentType,
  });
  // A generated branch keeps completion pushes off the repository default branch.
  const branch = branchName;
  // Refine the title asynchronously after task/session creation.
  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = getInitialTaskTitle(message, titleConfig);
  // Profile hints belong in the agent description, not the visible chat prompt.
  setOperation('mention_enrichment');
  const { enrichedMessage } = await enrichMessageWithMentions(message, db, projectId, userId, env);

  // Mark before issuing SQL: an insert error may have an uncertain commit outcome.
  await assertEffectAllowed?.();
  beforeTaskEffects();
  setOperation('task_insert');
  await db.insert(schema.tasks).values({
    id: taskId,
    chatSessionId: samReservation?.sessionId,
    projectId,
    userId,
    parentTaskId: body.parentTaskId ?? null,
    title: taskTitle,
    description: fork ? `${fork.context}\n\nNew user prompt:\n${enrichedMessage}` : enrichedMessage,
    status: 'queued',
    executionStep: 'node_selection',
    priority: 0,
    agentProfileHint: resolvedProfile?.profileId ?? null,
    skillId: resolvedProfile?.skillId ?? null,
    skillHint: body.skillId ?? null,
    agentConfigurationId,
    taskMode,
    outputBranch: branchName,
    requestedVmSize: vmSize,
    requestedVmSizeSource: vmSizeSource,
    resourceRequirementsJson: persistedResourceRequirementsJson,
    resourceRequirementPlanJson: persistedResourceRequirementPlanJson,
    resourceRequirementsSource: resolvedReservation.source,
    resolvedReservationJson: JSON.stringify(resolvedReservation),
    credentialAttributionUserId,
    credentialAttributionProjectId,
    credentialAttributionSource,
    ...capacityPlacementSnapshotDbValues(capacityPlacementSnapshot),
    triggeredBy: via === 'connector' || via === 'pat' ? 'connector' : 'user',
    connectorClientName: via === 'connector' || via === 'pat' ? (clientName ?? 'Connector') : null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  setOperation('task_status_event_insert');
  await db.insert(schema.taskStatusEvents).values({
    id: samReservation?.statusEventId ?? ulid(),
    taskId,
    fromStatus: null,
    toStatus: 'queued',
    actorType: 'user',
    actorId: userId,
    reason: 'Task submitted via chat',
    createdAt: now,
  });

  const sessionId = await persistVmTaskSession(input, db, taskTitle);
  await linkVmTaskSourceIdea(input, sessionId, taskMode);

  schedulePostSubmitWork({
    via,
    clientName,
    env: env,
    projectId,
    taskId,
    sessionId,
    message,
    initialTitle: taskTitle,
    titleConfig,
    waitUntil: (promise) => waitUntil(promise),
    userId,
    branchName,
  });

  log.info('task_submit.created', {
    taskId,
    projectId,
    sessionId,
    branchName,
    vmSize,
    vmLocation,
    workspaceProfile,
    taskMode,
    parentTaskId: body.parentTaskId ?? null,
    hasContextSummary: !!body.contextSummary,
    checkoutBranch: branch,
    attachmentCount: validatedAttachments.length,
  });
  setOperation('runner_user_lookup');
  const [userRow] = await db
    .select({ githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // The runner links this existing chat to the workspace it allocates.
  try {
    setOperation('runner_start');
    await assertEffectAllowed?.();
    await startTaskRunnerDO(env, {
      taskId,
      projectId,
      userId,
      vmSize,
      vmLocation,
      branch,
      defaultBranch: project.defaultBranch,
      preferredNodeId: body.nodeId,
      userName: user.name ?? undefined,
      userEmail: user.email,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: message,
      historicalContext: fork?.context,
      repository: project.repository,
      installationId: project.installationId,
      outputBranch: branchName,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType,
      workspaceProfile,
      devcontainerConfigName,
      cloudProvider: placement.provider ?? effectiveProvider,
      explicitVmLocation: placement.explicitVmLocation === true,
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
      taskMode,
      model: agentRun.model,
      effort: agentRun.effort,
      permissionMode: resolvedProfile?.permissionMode ?? projectAgentDefaults.permissionMode,
      // Null retains user-level settings fetched through the agent-settings callback.
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: resolvedProfile?.systemPromptAppend ?? null,
      agentProfileHint: resolvedProfile?.profileId ?? null,
      attachments: validatedAttachments.length > 0 ? validatedAttachments : null,
      projectScaling: {
        taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
        nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
      },
      resourceRequirements: taskRunnerResourceRequirements,
      resolvedReservation,
      capacityPoolSelection,
      vmSizeSource,
    });
  } catch (err) {
    // Preserve reserved identities after a lost acknowledgement; recovery reconciles them.
    if (samReservation) throw err;
    markTaskSubmitOperation(err, getOperation());
    const errorMsg = err instanceof Error ? err.message : String(err);
    setOperation('runner_failure_task_update');
    await markTaskFailedIfNonTerminal(
      env.DATABASE,
      taskId,
      `Task runner startup failed: ${errorMsg}`
    );
    log.error('task_submit.do_startup_failed', { taskId, projectId, error: errorMsg });
    // Stop the orphaned session (best-effort — it has no workspace and will never be cleaned up otherwise)
    await projectDataService.stopSession(env, projectId, sessionId).catch((e) => {
      log.error('task_submit.orphaned_session_stop_failed', {
        projectId,
        sessionId,
        error: String(e),
      });
    });
    throw err; // Re-throw to return 500 to the frontend
  }

  const response: SubmitTaskResponse = {
    taskId,
    sessionId,
    branchName,
    status: 'queued',
  };

  return response;
}
