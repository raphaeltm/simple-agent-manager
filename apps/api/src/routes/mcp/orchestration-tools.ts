/**
 * MCP orchestration tools — retry, dependency management, and task removal
 * for agent-to-agent communication.
 */
import type { VMSize } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { generateBranchName } from '../../services/branch-name';
import { capacityPlacementSnapshotDbValues } from '../../services/capacity-placement-snapshot';
import {
  PlacementResolutionError,
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
} from '../../services/placement-resolver';
import * as projectDataService from '../../services/project-data';
import {
  assertReplacementDeletionConfirmed,
  WorkspaceDeletionUnconfirmedError,
} from '../../services/replacement-deletion-fence';
import {
  createPersistedTaskResourcePlanJson,
  firstResourceRequirementLayer,
  firstResourceRequirementLayerJson,
  readPersistedTaskResourcePlan,
  ResourceRequirementsValidationError,
} from '../../services/resource-requirements-input';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../../services/task-title';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';
import { denyWhenMcpActorLacksCurrentProjectCapability } from './orchestration-authority';
import { stopActiveChildAgentForRetry } from './orchestration-retry-stop';

// ─── retry_subtask ──────────────────────────────────────────────────────────

export async function handleRetrySubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const db = drizzle(env.DATABASE, { schema });

  // Validate taskId param
  const childTaskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!childTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const rawNewDescription =
    typeof params.newDescription === 'string'
      ? sanitizeUserInput(params.newDescription.trim())
      : undefined;

  if (rawNewDescription && rawNewDescription.length > limits.dispatchDescriptionMaxLength) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `newDescription exceeds maximum length of ${limits.dispatchDescriptionMaxLength}`
    );
  }
  const newDescription = rawNewDescription;

  // Current authority BEFORE any effect. A valid KV token plus stored parent
  // lineage is not evidence that the actor may still act in this project, and
  // everything below this point stops a child agent, writes task/status rows,
  // creates a chat session, attributes credentials, and starts a runner.
  const staleActor = await denyWhenMcpActorLacksCurrentProjectCapability(
    requestId,
    db,
    tokenData,
    'task:write',
    'retry_subtask'
  );
  if (staleActor) return staleActor;

  // Fetch the child task
  const [childTask] = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, childTaskId), eq(schema.tasks.projectId, tokenData.projectId)))
    .limit(1);

  if (!childTask) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found in this project');
  }

  // Authorization: caller must be direct parent
  if (childTask.parentTaskId !== tokenData.taskId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can retry a subtask'
    );
  }

  try {
    await assertReplacementDeletionConfirmed(env, {
      sourceTaskId: childTaskId,
      projectId: tokenData.projectId,
      userId: childTask.userId,
    });
  } catch (error) {
    if (error instanceof WorkspaceDeletionUnconfirmedError) {
      return jsonRpcError(requestId, INVALID_PARAMS, error.message);
    }
    throw error;
  }

  // Check retry limit — counts ALL children of the parent, not just retries of this specific child.
  // This is intentionally approximate: it caps the total number of child tasks a parent can have,
  // which bounds retry activity without requiring a separate retry lineage column.
  const [retryCountResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.parentTaskId, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId)
      )
    );

  const siblingCount = retryCountResult?.count ?? 0;
  if (siblingCount >= limits.orchestratorMaxRetriesPerTask + 1) {
    // +1 because the original task counts as one
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Retry limit reached (${siblingCount - 1}/${limits.orchestratorMaxRetriesPerTask} retries). ` +
        'Consider adjusting the task description or seeking human input.'
    );
  }

  // If child is still running, stop it
  let stoppedStatus = childTask.status;
  let stoppedChatSessionId: string | null = null;
  if (ACTIVE_STATUSES.includes(childTask.status)) {
    const stopResult = await stopActiveChildAgentForRetry(requestId, childTask, tokenData, env, db);
    if ('jsonrpc' in stopResult) {
      return stopResult;
    }
    stoppedChatSessionId = stopResult.chatSessionId;

    const now = new Date().toISOString();
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: 'Stopped by parent for retry',
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, childTaskId));

    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId: childTaskId,
      fromStatus: childTask.status,
      toStatus: 'failed',
      actorType: 'agent',
      actorId: tokenData.workspaceId,
      reason: 'Stopped by parent for retry',
      createdAt: now,
    });

    stoppedStatus = 'failed';

    // Stop the durable chat session after the node agent is confirmed stopped.
    if (stoppedChatSessionId) {
      try {
        await projectDataService
          .stopSession(env, tokenData.projectId, stoppedChatSessionId)
          .catch((e) => log.warn('orchestration.retry_stop_session_failed', { error: String(e) }));
      } catch {
        // Best-effort session stop
      }
    }
  }

  // Build replacement task description — sanitize errorMessage to avoid reflecting internal details
  const originalDescription = childTask.description ?? '';
  const truncatedError = childTask.errorMessage
    ? sanitizeUserInput(childTask.errorMessage.slice(0, 500))
    : '';
  const replacementDescription =
    newDescription ??
    `${originalDescription}\n\nNote: Previous attempt (${childTaskId}) ended with status '${stoppedStatus}'.${
      truncatedError ? ` Error: ${truncatedError}` : ''
    }${childTask.outputBranch ? ` Branch with partial work: ${childTask.outputBranch}` : ''}`;

  // Dispatch replacement task — reuse logic from dispatch-tool
  const taskId = ulid();
  const now = new Date().toISOString();

  // Fetch project for defaults
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, tokenData.projectId))
    .limit(1);

  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  const inheritedCredentialAttributionUserId =
    childTask.credentialAttributionUserId ?? childTask.userId;
  const inheritedCredentialAttributionSource = (childTask.credentialAttributionSource ??
    'user') as import('@simple-agent-manager/shared').CredentialSource;
  const inheritedCredentialAttributionProjectId =
    inheritedCredentialAttributionSource === 'project'
      ? (childTask.credentialAttributionProjectId ?? childTask.projectId)
      : null;
  const childResourcePlan = (() => {
    try {
      return readPersistedTaskResourcePlan({
        taskId: childTask.id,
        triggerId: childTask.triggerId,
        skillId: childTask.skillId,
        agentProfileId: childTask.agentProfileHint,
        projectId: childTask.projectId,
        userId: childTask.userId,
        resourceRequirementPlanJson: childTask.resourceRequirementPlanJson,
        resourceRequirementsJson: childTask.resourceRequirementsJson,
        resourceRequirementsSource: childTask.resourceRequirementsSource,
        resolvedReservationJson: childTask.resolvedReservationJson,
        requestedVmSize: childTask.requestedVmSize,
        requestedVmSizeSource: childTask.requestedVmSizeSource,
      });
    } catch (err) {
      if (err instanceof ResourceRequirementsValidationError) {
        return jsonRpcError(requestId, INVALID_PARAMS, err.message);
      }
      throw err;
    }
  })();
  if ('jsonrpc' in childResourcePlan) {
    return childResourcePlan;
  }

  const placement = (() => {
    try {
      return resolveTaskStartPlacement({
        entryPoint: 'orchestration-retry',
        taskId,
        projectId: tokenData.projectId,
        userId: tokenData.userId,
        project,
        profile: null,
        inheritedCredentialAttribution: {
          userId: inheritedCredentialAttributionUserId,
          projectId: inheritedCredentialAttributionProjectId,
          source: inheritedCredentialAttributionSource,
        },
        credentialProjectPolicy: 'inherited-or-none',
        taskModeDefault: 'task',
        explicit: childResourcePlan.requestedVmSize
          ? {
              vmSize: childResourcePlan.requestedVmSize,
              vmSizeSource: childResourcePlan.requestedVmSizeSource ?? 'task',
            }
          : undefined,
        resourceRequirements: childResourcePlan.layers,
        resolvedReservationOverride: childResourcePlan.resolvedReservation,
      });
    } catch (err) {
      if (err instanceof PlacementResolutionError) {
        return jsonRpcError(requestId, INVALID_PARAMS, err.message);
      }
      throw err;
    }
  })();
  if ('jsonrpc' in placement) {
    return placement;
  }

  const placementResolution = await resolveTaskStartPlacementCredentialAttributionFromPlacement(
    db,
    placement,
    {
      credentialsRequiredMessage:
        'Cloud provider credentials required. The user must connect a cloud provider in Settings.',
      env,
    }
  );
  if ('error' in placementResolution) {
    return jsonRpcError(requestId, INVALID_PARAMS, placementResolution.error);
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
  if (quotaCredentialSource === 'platform') {
    const quotaEnforcementEnabled = env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
    if (quotaEnforcementEnabled) {
      const { checkQuotaForUser } = await import('../../services/compute-quotas');
      const quotaCheck = await checkQuotaForUser(db, tokenData.userId);
      if (!quotaCheck.allowed) {
        return jsonRpcError(
          requestId,
          INVALID_PARAMS,
          `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
            'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.'
        );
      }
    }
  }

  const {
    vmSize: resolvedVmSize,
    vmSizeSource,
    vmLocation: resolvedVmLocation,
    workspaceProfile: resolvedWorkspaceProfile,
    devcontainerConfigName: resolvedDevcontainerConfigName,
    taskMode: resolvedTaskMode,
    agentType: resolvedAgentType,
    resolvedReservation,
  } = placement;
  const persistedResourceRequirementsJson = firstResourceRequirementLayerJson(
    childResourcePlan.layers
  );
  const taskRunnerResourceRequirements = firstResourceRequirementLayer(childResourcePlan.layers);
  const persistedResourceRequirementPlanJson = createPersistedTaskResourcePlanJson({
    layers: childResourcePlan.layers,
    resolvedReservation,
    requestedVmSize: resolvedVmSize,
    requestedVmSizeSource: vmSizeSource,
  });

  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = await generateTaskTitle(env, replacementDescription, titleConfig);

  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(replacementDescription, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Retried/replacement subtasks have their own output branch. Check that out
  // from the start so VM-agent completion pushes cannot land on the project
  // default branch.
  const checkoutBranch = branchName;

  // Insert replacement task
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    parentTaskId: tokenData.taskId,
    title: taskTitle,
    description: replacementDescription,
    status: 'queued',
    executionStep: 'node_selection',
    priority: childTask.priority,
    dispatchDepth: childTask.dispatchDepth,
    outputBranch: branchName,
    taskMode: resolvedTaskMode,
    requestedVmSize: resolvedVmSize,
    requestedVmSizeSource: vmSizeSource,
    agentProfileHint: childTask.agentProfileHint,
    skillId: childTask.skillId,
    resourceRequirementsJson: persistedResourceRequirementsJson,
    resourceRequirementPlanJson: persistedResourceRequirementPlanJson,
    resourceRequirementsSource: resolvedReservation.source,
    resolvedReservationJson: JSON.stringify(resolvedReservation),
    credentialAttributionUserId,
    credentialAttributionProjectId,
    credentialAttributionSource,
    ...capacityPlacementSnapshotDbValues(capacityPlacementSnapshot),
    createdBy: tokenData.userId,
    createdAt: now,
    updatedAt: now,
  });

  // Record status event
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: null,
    toStatus: 'queued',
    actorType: 'agent',
    actorId: tokenData.workspaceId,
    reason: `Retry of failed task ${childTaskId}`,
    createdAt: now,
  });

  // Create chat session
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      env,
      tokenData.projectId,
      null,
      taskTitle,
      taskId,
      tokenData.userId
    );

    await projectDataService.persistMessage(
      env,
      tokenData.projectId,
      sessionId,
      'user',
      replacementDescription,
      null
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: `Session creation failed: ${errorMsg}`,
        updatedAt: failedAt,
      })
      .where(eq(schema.tasks.id, taskId));
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to create chat session: ${errorMsg}`);
  }

  // Start TaskRunner DO
  const [userRow] = await db
    .select({ name: schema.users.name, email: schema.users.email, githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, tokenData.userId))
    .limit(1);

  try {
    await startTaskRunnerDO(env, {
      taskId,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      vmSize: resolvedVmSize,
      vmLocation: resolvedVmLocation,
      branch: checkoutBranch,
      defaultBranch: project.defaultBranch,
      userName: userRow?.name ?? null,
      userEmail: userRow?.email ?? null,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: replacementDescription,
      repository: project.repository,
      installationId: project.installationId,
      outputBranch: branchName,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType: resolvedAgentType,
      workspaceProfile: resolvedWorkspaceProfile,
      devcontainerConfigName: resolvedDevcontainerConfigName,
      cloudProvider: placement.provider ?? effectiveProvider,
      explicitVmLocation: placement.explicitVmLocation === true,
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
      taskMode: resolvedTaskMode,
      model: null,
      effort: null,
      permissionMode: null,
      agentProfileHint: childTask.agentProfileHint ?? null,
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
      resourceRequirements: taskRunnerResourceRequirements,
      retrySourceTaskId: childTaskId,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: `Task runner startup failed: ${errorMsg}`,
        updatedAt: failedAt,
      })
      .where(eq(schema.tasks.id, taskId));
    log.error('orchestration.retry.do_startup_failed', { taskId, error: errorMsg });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to start task runner: ${errorMsg}`);
  }

  log.info('orchestration.retry_subtask.success', {
    stoppedTaskId: childTaskId,
    newTaskId: taskId,
    sessionId,
    branchName,
    parentTaskId: tokenData.taskId,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            stoppedTaskId: childTaskId,
            newTaskId: taskId,
            newSessionId: sessionId,
            newBranch: branchName,
            message: `Task ${childTaskId} stopped and replacement task ${taskId} dispatched.`,
          },
          null,
          2
        ),
      },
    ],
  });
}

// `add_dependency` and `remove_pending_subtask` live in
// `orchestration-dependency-tools.ts` (rule 18 file-size ceiling); re-exported
// here so importers keep one entry point for the orchestration tool family.
export {
  handleAddDependency,
  handleRemovePendingSubtask,
} from './orchestration-dependency-tools';
