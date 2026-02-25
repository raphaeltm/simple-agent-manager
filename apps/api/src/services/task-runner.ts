/**
 * Task Runner Service
 *
 * Orchestrates the full autonomous task execution lifecycle:
 * 1. Select or create a node
 * 2. Create a workspace on the node
 * 3. Create an agent session with the task as the initial prompt
 * 4. Wait for completion (via callback mechanism)
 * 5. Create a PR from any file changes
 * 6. Clean up workspace and (optionally) node
 *
 * RESILIENCE: Each step is persisted to the task's `executionStep` column
 * before performing the operation. If the Worker is killed mid-execution
 * (waitUntil timeout), the stuck-task cron can identify WHERE it stalled
 * and report a meaningful error.
 *
 * The `delegated` transition is deferred until AFTER the workspace is
 * created on the node (not before), reducing the window where a silent
 * Worker death leaves the task in a misleading state.
 */

import { and, eq, count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { TaskStatus, TaskExecutionStep, VMSize, VMLocation } from '@simple-agent-manager/shared';
import {
  DEFAULT_TASK_RUN_CLEANUP_DELAY_MS,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_READY_POLL_INTERVAL_MS,
  DEFAULT_WORKSPACE_READY_MAX_POLL_INTERVAL_MS,
} from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { log } from '../lib/logger';
import { selectNodeForTaskRun } from './node-selector';
import { createNodeRecord, provisionNode } from './nodes';
import * as nodeLifecycleService from './node-lifecycle';
import {
  createWorkspaceOnNode,
  waitForNodeAgentReady,
  createAgentSessionOnNode,
  stopWorkspaceOnNode,
} from './node-agent';
import { signCallbackToken } from './jwt';
import { resolveUniqueWorkspaceDisplayName } from './workspace-names';
import { getRuntimeLimits } from './limits';
import * as projectDataService from './project-data';

export interface TaskRunInput {
  taskId: string;
  projectId: string;
  userId: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  nodeId?: string;
  branch?: string;
  userName?: string | null;
  userEmail?: string | null;
  githubId?: string | null;
}

export interface TaskRunResult {
  taskId: string;
  status: TaskStatus;
  workspaceId: string | null;
  nodeId: string | null;
  autoProvisionedNode: boolean;
}

function getCleanupDelayMs(env: Env): number {
  const value = env.TASK_RUN_CLEANUP_DELAY_MS;
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_TASK_RUN_CLEANUP_DELAY_MS;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TASK_RUN_CLEANUP_DELAY_MS;
  }
  return parsed;
}

/**
 * Initiate an autonomous task run. Returns immediately after queuing.
 * The actual provisioning and execution happen asynchronously via waitUntil.
 */
export async function initiateTaskRun(
  input: TaskRunInput,
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<TaskRunResult> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Load task and project
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, input.taskId),
        eq(schema.tasks.projectId, input.projectId),
        eq(schema.tasks.userId, input.userId)
      )
    )
    .limit(1);

  if (!task) {
    throw new TaskRunError('Task not found', 'NOT_FOUND');
  }

  if (task.status !== 'ready') {
    throw new TaskRunError(
      `Task must be in 'ready' status to run, currently '${task.status}'`,
      'INVALID_STATUS'
    );
  }

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, input.userId)
      )
    )
    .limit(1);

  if (!project) {
    throw new TaskRunError('Project not found', 'NOT_FOUND');
  }

  // Transition task to queued with initial execution step
  await db
    .update(schema.tasks)
    .set({ status: 'queued', executionStep: 'node_selection', updatedAt: now })
    .where(eq(schema.tasks.id, task.id));

  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId: task.id,
    fromStatus: 'ready',
    toStatus: 'queued',
    actorType: 'system',
    actorId: null,
    reason: 'Autonomous task run initiated',
    createdAt: now,
  });

  // Determine node strategy
  // Precedence: explicit override > project default > platform default
  const vmSize = input.vmSize
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  const vmLocation = input.vmLocation ?? 'nbg1';
  const branch = input.branch ?? project.defaultBranch;

  log.info('task_run.initiated', {
    taskId: task.id,
    projectId: input.projectId,
    userId: input.userId,
    vmSize,
    vmLocation,
    branch,
    preferredNodeId: input.nodeId ?? null,
  });

  // Kick off async execution
  waitUntil(
    executeTaskRun(
      db,
      env,
      {
        task,
        project,
        userId: input.userId,
        vmSize,
        vmLocation,
        branch,
        preferredNodeId: input.nodeId,
        userName: input.userName,
        userEmail: input.userEmail,
      }
    )
  );

  return {
    taskId: task.id,
    status: 'queued',
    workspaceId: null,
    nodeId: null,
    autoProvisionedNode: false,
  };
}

export interface ExecuteTaskRunParams {
  task: schema.Task;
  project: schema.Project;
  userId: string;
  vmSize: VMSize;
  vmLocation: VMLocation;
  branch: string;
  preferredNodeId?: string;
  userName?: string | null;
  userEmail?: string | null;
  githubId?: string | null;
}

/**
 * Persist the current execution step to the task record.
 * This is the key resilience mechanism: if the Worker is killed,
 * the stuck-task recovery cron can read this to know WHERE it stalled.
 */
async function setExecutionStep(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string,
  step: TaskExecutionStep
): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ executionStep: step, updatedAt: new Date().toISOString() })
    .where(eq(schema.tasks.id, taskId));
}

/**
 * Core async execution of a task run.
 * This runs inside waitUntil and handles the full lifecycle.
 *
 * Each step is persisted to `executionStep` BEFORE the long-running operation,
 * providing a breadcrumb trail for debugging and stuck-task recovery.
 */
export async function executeTaskRun(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  params: ExecuteTaskRunParams
): Promise<void> {
  const { task, project, userId, vmSize, vmLocation, branch, preferredNodeId, userName, userEmail, githubId } = params;
  const now = () => new Date().toISOString();
  const runStartMs = Date.now();
  let nodeId: string | null = null;
  let workspaceId: string | null = null;
  let autoProvisioned = false;

  const ctx = { taskId: task.id, projectId: project.id, userId };

  try {
    // =========================================================================
    // Step 1: Select or create a node
    // =========================================================================
    await setExecutionStep(db, task.id, 'node_selection');
    log.info('task_run.step.node_selection', { ...ctx, preferredNodeId: preferredNodeId ?? null });
    const stepStartMs = Date.now();

    if (preferredNodeId) {
      // Validate the preferred node
      const [node] = await db
        .select()
        .from(schema.nodes)
        .where(
          and(
            eq(schema.nodes.id, preferredNodeId),
            eq(schema.nodes.userId, userId)
          )
        )
        .limit(1);

      if (!node || node.status !== 'running') {
        throw new TaskRunError('Specified node is not available', 'NODE_UNAVAILABLE');
      }
      nodeId = node.id;
      log.info('task_run.step.node_selected', { ...ctx, nodeId, source: 'preferred', durationMs: Date.now() - stepStartMs });
    } else {
      // Try to find an existing node with capacity
      const selectedNode = await selectNodeForTaskRun(db, userId, env, vmLocation, vmSize, task.id);
      if (selectedNode) {
        nodeId = selectedNode.id;
        log.info('task_run.step.node_selected', { ...ctx, nodeId, source: 'existing', durationMs: Date.now() - stepStartMs });
      } else {
        // Create a new node
        await setExecutionStep(db, task.id, 'node_provisioning');

        const limits = getRuntimeLimits(env);
        const [userNodeCount] = await db
          .select({ count: count() })
          .from(schema.nodes)
          .where(eq(schema.nodes.userId, userId));

        if ((userNodeCount?.count ?? 0) >= limits.maxNodesPerUser) {
          throw new TaskRunError(
            `Maximum ${limits.maxNodesPerUser} nodes allowed. Cannot auto-provision.`,
            'LIMIT_EXCEEDED'
          );
        }

        const createdNode = await createNodeRecord(env, {
          userId,
          name: `Auto: ${task.title.slice(0, 40)}`,
          vmSize,
          vmLocation,
          heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
        });

        nodeId = createdNode.id;
        autoProvisioned = true;
        log.info('task_run.step.node_provisioning', { ...ctx, nodeId, vmSize, vmLocation });

        // Store autoProvisionedNodeId on the task
        await db
          .update(schema.tasks)
          .set({ autoProvisionedNodeId: nodeId, updatedAt: now() })
          .where(eq(schema.tasks.id, task.id));

        // Provision the node (creates Hetzner server)
        await provisionNode(nodeId, env);

        // Verify node is actually running after provisioning
        const [provisionedNode] = await db
          .select({ status: schema.nodes.status, errorMessage: schema.nodes.errorMessage })
          .from(schema.nodes)
          .where(eq(schema.nodes.id, nodeId))
          .limit(1);

        if (!provisionedNode || provisionedNode.status !== 'running') {
          throw new TaskRunError(
            provisionedNode?.errorMessage || 'Node provisioning failed',
            'PROVISION_FAILED'
          );
        }

        // Wait for node agent to be ready
        await setExecutionStep(db, task.id, 'node_agent_ready');
        await waitForNodeAgentReady(nodeId, env);
        log.info('task_run.step.node_ready', { ...ctx, nodeId, source: 'auto_provisioned', durationMs: Date.now() - stepStartMs });
      }
    }

    // =========================================================================
    // Step 2: Create workspace
    // =========================================================================
    await setExecutionStep(db, task.id, 'workspace_creation');
    log.info('task_run.step.workspace_creation', { ...ctx, nodeId });
    const workspaceName = `Task: ${task.title.slice(0, 50)}`;
    const uniqueName = await resolveUniqueWorkspaceDisplayName(db, nodeId, workspaceName);
    workspaceId = ulid();

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      nodeId,
      projectId: project.id,
      userId,
      installationId: project.installationId,
      name: workspaceName,
      displayName: uniqueName.displayName,
      normalizedDisplayName: uniqueName.normalizedDisplayName,
      repository: project.repository,
      branch,
      status: 'creating',
      vmSize,
      vmLocation,
      createdAt: now(),
      updatedAt: now(),
    });

    // Update task with workspace ID (but do NOT transition to delegated yet)
    await db
      .update(schema.tasks)
      .set({ workspaceId, updatedAt: now() })
      .where(eq(schema.tasks.id, task.id));

    // Create chat session in ProjectData DO for task message persistence.
    // Best-effort: session creation failure should not block workspace creation.
    let chatSessionId: string | null = null;
    try {
      chatSessionId = await projectDataService.createSession(
        env,
        project.id,
        workspaceId,
        task.title,
        task.id // taskId
      );
      await db
        .update(schema.workspaces)
        .set({ chatSessionId, updatedAt: now() })
        .where(eq(schema.workspaces.id, workspaceId));
    } catch (err) {
      console.error('Failed to create chat session for task workspace:', err);
    }

    // Set output_branch to task/{taskId} format
    const outputBranch = `task/${task.id}`;
    await db
      .update(schema.tasks)
      .set({ outputBranch, updatedAt: now() })
      .where(eq(schema.tasks.id, task.id));

    // Create workspace on node agent
    const callbackToken = await signCallbackToken(workspaceId, env);
    await createWorkspaceOnNode(nodeId, env, userId, {
      workspaceId,
      repository: project.repository,
      branch,
      callbackToken,
      gitUserName: userName,
      gitUserEmail: userEmail,
      githubId: githubId,
    });

    // NOW transition to delegated — workspace is actually created on the node.
    // Use optimistic locking: only transition if still queued (cron may have failed it).
    const delegatedRows = await db
      .update(schema.tasks)
      .set({ status: 'delegated', updatedAt: now() })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'queued')))
      .returning({ id: schema.tasks.id });

    if (delegatedRows.length === 0) {
      log.warn('task_run.aborted_by_recovery', { ...ctx, expectedStatus: 'queued', step: 'delegated_transition' });
      return; // Task was failed by cron recovery — abort gracefully
    }

    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId: task.id,
      fromStatus: 'queued',
      toStatus: 'delegated',
      actorType: 'system',
      actorId: null,
      reason: `Delegated to workspace ${workspaceId} on node ${nodeId}`,
      createdAt: now(),
    });

    // Wait for workspace to be ready (poll status)
    await setExecutionStep(db, task.id, 'workspace_ready');
    await waitForWorkspaceReady(db, workspaceId, env);
    log.info('task_run.step.workspace_ready', { ...ctx, workspaceId, nodeId });

    // =========================================================================
    // Step 3: Create agent session with task as initial prompt
    // =========================================================================
    await setExecutionStep(db, task.id, 'agent_session');
    log.info('task_run.step.agent_session_creation', { ...ctx, workspaceId, nodeId });
    const sessionId = ulid();
    const sessionLabel = `Task: ${task.title.slice(0, 40)}`;

    await db.insert(schema.agentSessions).values({
      id: sessionId,
      workspaceId,
      userId,
      status: 'running',
      label: sessionLabel,
      createdAt: now(),
      updatedAt: now(),
    });

    await createAgentSessionOnNode(
      nodeId,
      workspaceId,
      sessionId,
      sessionLabel,
      env,
      userId
    );

    // =========================================================================
    // Step 4: Mark as in_progress — agent is running
    // =========================================================================
    await setExecutionStep(db, task.id, 'running');

    // Use optimistic locking: only transition if still delegated (cron may have failed it).
    const inProgressRows = await db
      .update(schema.tasks)
      .set({ status: 'in_progress', startedAt: now(), updatedAt: now() })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'delegated')))
      .returning({ id: schema.tasks.id });

    if (inProgressRows.length === 0) {
      log.warn('task_run.aborted_by_recovery', { ...ctx, expectedStatus: 'delegated', step: 'in_progress_transition' });
      return; // Task was failed by cron recovery — abort gracefully
    }

    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId: task.id,
      fromStatus: 'delegated',
      toStatus: 'in_progress',
      actorType: 'system',
      actorId: null,
      reason: `Agent session ${sessionId} created. Task execution started.`,
      createdAt: now(),
    });

    log.info('task_run.step.in_progress', {
      ...ctx,
      workspaceId,
      nodeId,
      agentSessionId: sessionId,
      autoProvisioned,
      totalDurationMs: Date.now() - runStartMs,
    });

  } catch (err) {
    // Transition task to failed
    const errorMessage = err instanceof Error ? err.message : 'Unknown error during task run';
    const errorCode = err instanceof TaskRunError ? err.code : 'UNKNOWN';

    log.error('task_run.failed', {
      ...ctx,
      errorMessage,
      errorCode,
      workspaceId,
      nodeId,
      autoProvisioned,
      totalDurationMs: Date.now() - runStartMs,
    });

    await failTask(db, task.id, errorMessage);

    // Best-effort cleanup
    if (workspaceId && nodeId) {
      try {
        await stopWorkspaceOnNode(nodeId, workspaceId, env, userId);
      } catch (stopErr) {
        log.error('task_run.cleanup.workspace_stop_failed', {
          ...ctx,
          workspaceId,
          nodeId,
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }

      await db
        .update(schema.workspaces)
        .set({ status: 'stopped', updatedAt: now() })
        .where(eq(schema.workspaces.id, workspaceId));
    }

    // If we auto-provisioned a node and it has no other workspaces, clean it up
    if (autoProvisioned && nodeId) {
      await cleanupAutoProvisionedNode(db, nodeId, userId, workspaceId, env);
    }
  }
}

/**
 * Wait for a workspace to transition to 'running' status.
 * Polls the database with exponential backoff.
 */
async function waitForWorkspaceReady(
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspaceId: string,
  env: Env
): Promise<void> {
  const parsedTimeout = env.WORKSPACE_READY_TIMEOUT_MS ? Number.parseInt(env.WORKSPACE_READY_TIMEOUT_MS, 10) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 300_000;
  const deadline = Date.now() + timeoutMs;
  const parsedPoll = env.WORKSPACE_READY_POLL_INTERVAL_MS ? Number.parseInt(env.WORKSPACE_READY_POLL_INTERVAL_MS, 10) : NaN;
  const basePollInterval = Number.isFinite(parsedPoll) && parsedPoll > 0 ? parsedPoll : DEFAULT_WORKSPACE_READY_POLL_INTERVAL_MS;
  const parsedMaxPoll = env.WORKSPACE_READY_MAX_POLL_INTERVAL_MS ? Number.parseInt(env.WORKSPACE_READY_MAX_POLL_INTERVAL_MS, 10) : NaN;
  const maxPollInterval = Number.isFinite(parsedMaxPoll) && parsedMaxPoll > 0 ? parsedMaxPoll : DEFAULT_WORKSPACE_READY_MAX_POLL_INTERVAL_MS;
  let pollInterval = basePollInterval;

  while (Date.now() < deadline) {
    const [ws] = await db
      .select({ status: schema.workspaces.status, errorMessage: schema.workspaces.errorMessage })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    if (!ws) {
      throw new TaskRunError('Workspace disappeared during creation', 'WORKSPACE_LOST');
    }

    if (ws.status === 'running' || ws.status === 'recovery') {
      return;
    }

    if (ws.status === 'error') {
      throw new TaskRunError(
        ws.errorMessage || 'Workspace creation failed',
        'WORKSPACE_CREATION_FAILED'
      );
    }

    if (ws.status === 'stopped') {
      throw new TaskRunError('Workspace was stopped during creation', 'WORKSPACE_STOPPED');
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, maxPollInterval);
  }

  throw new TaskRunError(
    `Workspace did not become ready within ${timeoutMs}ms`,
    'WORKSPACE_TIMEOUT'
  );
}

/**
 * Mark a task as failed with an error message.
 * Clears executionStep since the task is in a terminal state.
 *
 * Idempotent: if the task is already in a terminal state (e.g., failed by
 * the stuck-task cron), this is a no-op to avoid duplicate status events.
 */
async function failTask(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string,
  errorMessage: string
): Promise<void> {
  const now = new Date().toISOString();

  // Get current status for event
  const [task] = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  const fromStatus = (task?.status ?? 'queued') as TaskStatus;

  // Skip if already in a terminal state (idempotent — avoids duplicate events)
  if (fromStatus === 'failed' || fromStatus === 'completed' || fromStatus === 'cancelled') {
    return;
  }

  await db
    .update(schema.tasks)
    .set({
      status: 'failed',
      executionStep: null,
      errorMessage,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, taskId));

  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus,
    toStatus: 'failed',
    actorType: 'system',
    actorId: null,
    reason: errorMessage,
    createdAt: now,
  });
}

/**
 * Clean up a workspace and optionally its auto-provisioned node after task completion.
 * Called when a task run finishes (either success or failure).
 */
export async function cleanupTaskRun(
  taskId: string,
  env: Env
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const cleanupDelay = getCleanupDelayMs(env);

  // Wait a bit for any final writes
  if (cleanupDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, cleanupDelay));
  }

  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  if (!task || !task.workspaceId) {
    return;
  }

  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, task.workspaceId))
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    return;
  }

  log.info('task_run.cleanup.started', { taskId, workspaceId: task.workspaceId, nodeId: workspace.nodeId });

  // Stop the workspace
  if (workspace.status === 'running' || workspace.status === 'recovery') {
    try {
      await stopWorkspaceOnNode(workspace.nodeId, workspace.id, env, task.userId);
    } catch (err) {
      log.error('task_run.cleanup.workspace_stop_failed', {
        taskId,
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await db
      .update(schema.workspaces)
      .set({ status: 'stopped', updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspace.id));
  }

  // If node was auto-provisioned for this task, check if it can be cleaned up
  if (task.autoProvisionedNodeId) {
    await cleanupAutoProvisionedNode(
      db,
      task.autoProvisionedNodeId,
      task.userId,
      workspace.id,
      env
    );
  }
}

/**
 * Check if an auto-provisioned node has no other active workspaces.
 * If empty, marks the node as warm (idle) via the NodeLifecycle DO
 * so it stays available for fast reuse. The DO alarm handles eventual
 * teardown if not reclaimed within the warm timeout.
 */
async function cleanupAutoProvisionedNode(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeId: string,
  userId: string,
  excludeWorkspaceId: string | null,
  env: Env
): Promise<void> {
  // Count active workspaces on this node (excluding the one we're cleaning up)
  const workspaces = await db
    .select({ id: schema.workspaces.id, status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId)
      )
    );

  const activeWorkspaces = workspaces.filter(
    (ws) =>
      ws.id !== excludeWorkspaceId &&
      (ws.status === 'running' || ws.status === 'creating' || ws.status === 'recovery')
  );

  if (activeWorkspaces.length > 0) {
    // Other workspaces still running, don't mark idle
    return;
  }

  // No active workspaces — mark node as warm for reuse.
  // The NodeLifecycle DO will schedule an alarm for eventual teardown.
  try {
    await nodeLifecycleService.markIdle(env, nodeId, userId);
    log.info('task_run.cleanup.node_marked_warm', { nodeId, userId });
  } catch (err) {
    log.error('task_run.cleanup.mark_idle_failed', {
      nodeId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback: stop node directly if DO fails
    try {
      const { stopNodeResources } = await import('./nodes');
      await stopNodeResources(nodeId, userId, env);
      log.info('task_run.cleanup.node_stopped_fallback', { nodeId, userId });
    } catch (stopErr) {
      // Both markIdle and fallback stop failed — log for cron sweep to catch
      log.error('task_run.cleanup.node_cleanup_total_failure', {
        nodeId,
        userId,
        markIdleError: err instanceof Error ? err.message : String(err),
        stopError: stopErr instanceof Error ? stopErr.message : String(stopErr),
      });
    }
  }
}

/**
 * Typed error for task run failures.
 */
export class TaskRunError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'INVALID_STATUS'
      | 'NODE_UNAVAILABLE'
      | 'LIMIT_EXCEEDED'
      | 'PROVISION_FAILED'
      | 'WORKSPACE_CREATION_FAILED'
      | 'WORKSPACE_LOST'
      | 'WORKSPACE_STOPPED'
      | 'WORKSPACE_TIMEOUT'
      | 'EXECUTION_FAILED'
  ) {
    super(message);
    this.name = 'TaskRunError';
  }
}
