/**
 * Task Runs Route
 *
 * Provides the API endpoint for triggering autonomous task execution.
 * POST /api/projects/:projectId/tasks/:taskId/run
 *
 * This endpoint:
 * 1. Validates the task is in 'ready' status and unblocked
 * 2. Queues the task for autonomous execution
 * 3. Returns immediately with 202 Accepted
 * 4. Async: selects/creates node, creates workspace, runs agent, creates PR, cleans up
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { RunTaskRequest, RunTaskResponse, TaskStatus } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { getAuth, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject, requireOwnedTask } from '../middleware/project-auth';
import { initiateTaskRun, cleanupTaskRun, TaskRunError } from '../services/task-runner';
import { isTaskBlocked } from '../services/task-graph';

const taskRunsRoutes = new Hono<{ Bindings: Env }>();

taskRunsRoutes.use('/*', requireAuth());

/**
 * POST /projects/:projectId/tasks/:taskId/run
 *
 * Trigger autonomous execution of a task.
 * The task must be in 'ready' status and not blocked by dependencies.
 *
 * Request body (all optional):
 *   vmSize: 'small' | 'medium' | 'large' — VM size for workspace (default: medium)
 *   vmLocation: 'nbg1' | 'fsn1' | 'hel1' — VM location (default: nbg1)
 *   nodeId: string — force a specific node (must be running and owned by user)
 *   branch: string — override project default branch
 *
 * Response 202:
 *   taskId, status, workspaceId, nodeId, autoProvisionedNode
 */
taskRunsRoutes.post('/:taskId/run', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }
  if (!taskId) {
    throw errors.badRequest('taskId is required');
  }

  // Validate ownership
  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  // Check task status
  if (task.status !== 'ready') {
    throw errors.conflict(
      `Task must be in 'ready' status to run autonomously, currently '${task.status}'`
    );
  }

  // Check for blocked dependencies
  const dependencies = await db
    .select({
      taskId: schema.taskDependencies.taskId,
      dependsOnTaskId: schema.taskDependencies.dependsOnTaskId,
    })
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, task.id));

  if (dependencies.length > 0) {
    const depTasks = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          eq(schema.tasks.userId, userId)
        )
      );

    const statusMap: Record<string, TaskStatus> = {};
    for (const t of depTasks) {
      statusMap[t.id] = t.status as TaskStatus;
    }

    if (isTaskBlocked(task.id, dependencies, statusMap)) {
      throw errors.conflict('Task is blocked by unresolved dependencies');
    }
  }

  // Check the user has Hetzner credentials (required for node provisioning)
  const [credential] = await db
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  if (!credential) {
    throw errors.badRequest('Hetzner credentials required. Connect your account in Settings.');
  }

  // Parse request body
  const body = await c.req.json<RunTaskRequest>().catch(() => ({}) as RunTaskRequest);

  // Validate vmSize if provided
  if (body.vmSize && !['small', 'medium', 'large'].includes(body.vmSize)) {
    throw errors.badRequest('vmSize must be small, medium, or large');
  }

  // Validate vmLocation if provided
  if (body.vmLocation && !['nbg1', 'fsn1', 'hel1'].includes(body.vmLocation)) {
    throw errors.badRequest('vmLocation must be nbg1, fsn1, or hel1');
  }

  try {
    const result = await initiateTaskRun(
      {
        taskId: task.id,
        projectId,
        userId,
        vmSize: body.vmSize,
        vmLocation: body.vmLocation,
        nodeId: body.nodeId,
        branch: body.branch,
        userName: auth.user.name,
        userEmail: auth.user.email,
      },
      c.env,
      (promise) => c.executionCtx.waitUntil(promise)
    );

    const response: RunTaskResponse = {
      taskId: result.taskId,
      status: result.status,
      workspaceId: result.workspaceId,
      nodeId: result.nodeId,
      autoProvisionedNode: result.autoProvisionedNode,
    };

    return c.json(response, 202);
  } catch (err) {
    if (err instanceof TaskRunError) {
      switch (err.code) {
        case 'NOT_FOUND':
          throw errors.notFound('Task');
        case 'INVALID_STATUS':
          throw errors.conflict(err.message);
        case 'NODE_UNAVAILABLE':
          throw errors.badRequest(err.message);
        case 'LIMIT_EXCEEDED':
          throw errors.badRequest(err.message);
        default:
          throw errors.internal(err.message);
      }
    }
    throw err;
  }
});

/**
 * POST /projects/:projectId/tasks/:taskId/run/cleanup
 *
 * Trigger cleanup of a completed/failed task run.
 * Stops the workspace and optionally the auto-provisioned node.
 * This can be called manually or is triggered automatically by the callback mechanism.
 */
taskRunsRoutes.post('/:taskId/run/cleanup', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !taskId) {
    throw errors.badRequest('projectId and taskId are required');
  }

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  // Only allow cleanup for terminal states
  if (
    task.status !== 'completed' &&
    task.status !== 'failed' &&
    task.status !== 'cancelled'
  ) {
    throw errors.conflict(
      `Task must be in completed, failed, or cancelled status for cleanup, currently '${task.status}'`
    );
  }

  c.executionCtx.waitUntil(cleanupTaskRun(task.id, c.env));

  return c.json({ success: true, message: 'Cleanup initiated' });
});

export { taskRunsRoutes };
