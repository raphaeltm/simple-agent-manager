/**
 * MCP orchestration tools — retry, dependency management, and task removal
 * for agent-to-agent communication.
 */
import type { CredentialProvider, VMLocation, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE, DEFAULT_WORKSPACE_PROFILE, getDefaultLocationForProvider } from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { generateBranchName } from '../../services/branch-name';
import * as projectDataService from '../../services/project-data';
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

// ─── retry_subtask ──────────────────────────────────────────────────────────

export async function handleRetrySubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const db = drizzle(env.DATABASE, { schema });

  // Validate taskId param
  const childTaskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!childTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const rawNewDescription = typeof params.newDescription === 'string'
    ? sanitizeUserInput(params.newDescription.trim())
    : undefined;

  if (rawNewDescription && rawNewDescription.length > limits.dispatchDescriptionMaxLength) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `newDescription exceeds maximum length of ${limits.dispatchDescriptionMaxLength}`,
    );
  }
  const newDescription = rawNewDescription;

  // Fetch the child task
  const [childTask] = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, childTaskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  if (!childTask) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found in this project');
  }

  // Authorization: caller must be direct parent
  if (childTask.parentTaskId !== tokenData.taskId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can retry a subtask',
    );
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
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    );

  const siblingCount = retryCountResult?.count ?? 0;
  if (siblingCount >= limits.orchestratorMaxRetriesPerTask + 1) {
    // +1 because the original task counts as one
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Retry limit reached (${siblingCount - 1}/${limits.orchestratorMaxRetriesPerTask} retries). ` +
      'Consider adjusting the task description or seeking human input.',
    );
  }

  // If child is still running, stop it
  let stoppedStatus = childTask.status;
  if (ACTIVE_STATUSES.includes(childTask.status)) {
    const now = new Date().toISOString();
    await db.update(schema.tasks)
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

    // Stop the session if one exists — find workspace via the task's workspaceId
    if (childTask.workspaceId) {
      try {
        const [workspace] = await db
          .select({ chatSessionId: schema.workspaces.chatSessionId })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, childTask.workspaceId))
          .limit(1);
        if (workspace?.chatSessionId) {
          await projectDataService.stopSession(env, tokenData.projectId, workspace.chatSessionId)
            .catch((e) => log.warn('orchestration.retry_stop_session_failed', { error: String(e) }));
        }
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
  const replacementDescription = newDescription
    ?? `${originalDescription}\n\nNote: Previous attempt (${childTaskId}) ended with status '${stoppedStatus}'.${
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

  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = await generateTaskTitle(env.AI, replacementDescription, titleConfig);

  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(replacementDescription, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Resolve VM size from project defaults (not executionStep, which tracks runner state)
  const resolvedVmSize: VMSize = (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  const resolvedProvider: CredentialProvider | null = (project.defaultProvider as CredentialProvider | null) ?? null;
  const resolvedVmLocation: VMLocation = (project.defaultLocation as VMLocation | null)
    ?? (resolvedProvider ? getDefaultLocationForProvider(resolvedProvider) as VMLocation | null : null)
    ?? DEFAULT_VM_LOCATION;
  const resolvedWorkspaceProfile: WorkspaceProfile = (project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;

  const checkoutBranch = project.defaultBranch;

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
    );

    await projectDataService.persistMessage(
      env,
      tokenData.projectId,
      sessionId,
      'user',
      replacementDescription,
      null,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Session creation failed: ${errorMsg}`, updatedAt: failedAt })
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
      agentType: project.defaultAgentType ?? null,
      workspaceProfile: resolvedWorkspaceProfile,
      cloudProvider: resolvedProvider,
      model: null,
      permissionMode: null,
      projectScaling: {
        taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
        maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
        nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Task runner startup failed: ${errorMsg}`, updatedAt: failedAt })
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
    content: [{
      type: 'text',
      text: JSON.stringify({
        stoppedTaskId: childTaskId,
        newTaskId: taskId,
        newSessionId: sessionId,
        newBranch: branchName,
        message: `Task ${childTaskId} stopped and replacement task ${taskId} dispatched.`,
      }, null, 2),
    }],
  });
}

// ─── add_dependency ─────────────────────────────────────────────────────────

export async function handleAddDependency(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const db = drizzle(env.DATABASE, { schema });

  // Validate params
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  const dependsOnTaskId = typeof params.dependsOnTaskId === 'string' ? params.dependsOnTaskId.trim() : '';

  if (!taskId || !dependsOnTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId and dependsOnTaskId are required');
  }

  if (taskId === dependsOnTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'A task cannot depend on itself');
  }

  // Verify both tasks belong to the same project
  const tasks = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      parentTaskId: schema.tasks.parentTaskId,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.id, [taskId, dependsOnTaskId]),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    );

  if (tasks.length !== 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'One or both tasks not found in this project');
  }

  // Authorization: caller must be parent of both tasks, or caller is a sibling
  const taskA = tasks.find((t) => t.id === taskId)!;
  const taskB = tasks.find((t) => t.id === dependsOnTaskId)!;

  const callerIsParentOfBoth =
    taskA.parentTaskId === tokenData.taskId &&
    taskB.parentTaskId === tokenData.taskId;

  // Allow if caller IS the dependent task (taskId) and both share the same parent.
  // Restricting to taskId only prevents a task from declaring itself as a blocker
  // for siblings — a task can only add dependencies on itself, not block others.
  const callerIsSibling =
    tokenData.taskId === taskId &&
    taskA.parentTaskId != null &&
    taskA.parentTaskId === taskB.parentTaskId;

  if (!callerIsParentOfBoth && !callerIsSibling) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Caller must be the parent of both tasks, or both tasks must be siblings under the caller',
    );
  }

  // Check max edges for the project — use raw SQL for cross-table join
  const projectEdgeCount = await env.DATABASE.prepare(
    `SELECT count(*) as count FROM task_dependencies td
     JOIN tasks t ON td.task_id = t.id
     WHERE t.project_id = ?`,
  ).bind(tokenData.projectId).first<{ count: number }>();

  if ((projectEdgeCount?.count ?? 0) >= limits.orchestratorDependencyMaxEdges) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Dependency edge limit reached (${projectEdgeCount?.count}/${limits.orchestratorDependencyMaxEdges}). ` +
      'Cannot add more dependency edges to this project.',
    );
  }

  // Cycle detection: pre-fetch all project edges, then BFS in memory
  // This avoids N+1 queries — one query gets all edges for the project
  const allEdges = await db
    .select({
      fromTask: schema.taskDependencies.taskId,
      toTask: schema.taskDependencies.dependsOnTaskId,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.taskDependencies.taskId, schema.tasks.id))
    .where(eq(schema.tasks.projectId, tokenData.projectId));

  // Build adjacency list: taskId -> [dependsOnTaskIds]
  const adjacency = new Map<string, string[]>();
  for (const edge of allEdges) {
    const existing = adjacency.get(edge.fromTask);
    if (existing) {
      existing.push(edge.toTask);
    } else {
      adjacency.set(edge.fromTask, [edge.toTask]);
    }
  }

  // BFS from dependsOnTaskId — if we can reach taskId, adding this edge creates a cycle
  // Hard cap on iterations to prevent runaway memory/CPU in misconfigured environments
  const MAX_BFS_ITERATIONS = 500;
  const visited = new Set<string>();
  const queue = [dependsOnTaskId];
  let bfsIterations = 0;

  while (queue.length > 0) {
    if (++bfsIterations > MAX_BFS_ITERATIONS) {
      return jsonRpcError(requestId, INTERNAL_ERROR, 'Dependency graph too complex for cycle check');
    }
    const current = queue.shift()!;
    if (current === taskId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Adding this dependency would create a cycle in the task graph',
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = adjacency.get(current) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        queue.push(dep);
      }
    }
  }

  // Insert the dependency edge
  try {
    await db.insert(schema.taskDependencies).values({
      taskId,
      dependsOnTaskId,
      createdBy: tokenData.userId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Primary key violation means the edge already exists
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('UNIQUE') || errorMsg.includes('PRIMARY KEY')) {
      return jsonRpcSuccess(requestId, {
        content: [{
          type: 'text',
          text: JSON.stringify({ added: true, message: 'Dependency already exists (idempotent)' }),
        }],
      });
    }
    throw err;
  }

  log.info('orchestration.add_dependency.success', {
    taskId,
    dependsOnTaskId,
    projectId: tokenData.projectId,
    addedBy: tokenData.taskId,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({ added: true }),
    }],
  });
}

// ─── remove_pending_subtask ─────────────────────────────────────────────────

export async function handleRemovePendingSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  // Validate taskId param
  const childTaskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!childTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  // Fetch the child task
  const [childTask] = await db
    .select({
      id: schema.tasks.id,
      parentTaskId: schema.tasks.parentTaskId,
      status: schema.tasks.status,
      projectId: schema.tasks.projectId,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, childTaskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  if (!childTask) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found in this project');
  }

  // Authorization: caller must be direct parent
  if (childTask.parentTaskId !== tokenData.taskId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can remove a pending subtask',
    );
  }

  // Only queued tasks can be removed — running tasks must use retry_subtask
  if (childTask.status !== 'queued') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Cannot remove task in '${childTask.status}' status. Only 'queued' tasks can be removed. ` +
      (ACTIVE_STATUSES.includes(childTask.status)
        ? 'Use retry_subtask to stop and retry running tasks.'
        : 'Task has already completed.'),
    );
  }

  const now = new Date().toISOString();

  // Cancel the task
  await db.update(schema.tasks)
    .set({
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, childTaskId));

  // Record status event
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId: childTaskId,
    fromStatus: 'queued',
    toStatus: 'cancelled',
    actorType: 'agent',
    actorId: tokenData.workspaceId,
    reason: `Removed by parent task ${tokenData.taskId}`,
    createdAt: now,
  });

  // Clean up dependency edges
  await env.DATABASE.prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?',
  ).bind(childTaskId, childTaskId).run();

  log.info('orchestration.remove_pending_subtask.success', {
    taskId: childTaskId,
    parentTaskId: tokenData.taskId,
    projectId: tokenData.projectId,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({ removed: true, taskId: childTaskId }),
    }],
  });
}
