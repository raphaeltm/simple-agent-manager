import {
  isTaskExecutionStep,
  type ListTaskEventsResponse,
  type ListTasksResponse,
  type TaskActorType,
  type TaskDetailResponse,
  type TaskStatus,
  type TaskTriggerExecutionInfo,
  type TaskTriggerInfo,
} from '@simple-agent-manager/shared';
import type { SQL } from 'drizzle-orm';
import {
  and,
  count,
  desc,
  eq,
  gte,
  lt,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { toDependencyResponse,toTaskResponse } from '../../lib/mappers';
import { parsePositiveInt, requireRouteParam } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { getUserId, requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject, requireOwnedTask, requireOwnedWorkspace } from '../../middleware/project-auth';
import {
  CreateTaskDependencySchema,
  CreateTaskSchema,
  DelegateTaskSchema,
  jsonValidator,
  UpdateTaskSchema,
  UpdateTaskStatusSchema,
} from '../../schemas';
import { cronToHumanReadable } from '../../services/cron-utils';
import { verifyCallbackToken } from '../../services/jwt';
import { getRuntimeLimits } from '../../services/limits';
import * as notificationService from '../../services/notification';
import * as projectDataService from '../../services/project-data';
import {
  type TaskDependencyEdge,
  wouldCreateTaskDependencyCycle,
} from '../../services/task-graph';
import { cleanupTaskRun } from '../../services/task-runner';
import {
  canTransitionTaskStatus,
  getAllowedTaskTransitions,
  isExecutableTaskStatus,
  isTaskStatus,
} from '../../services/task-status';
import {
  appendStatusEvent,
  computeBlockedForTask,
  computeBlockedSet,
  getTaskDependencies,
  parseTaskSortOrder,
  requireOwnedTaskById,
  setTaskStatus,
} from './_helpers';

const crudRoutes = new Hono<{ Bindings: Env }>();

crudRoutes.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/status/callback')) {
    return next();
  }
  return requireAuth()(c, async () => {
    await requireApproved()(c, next);
  });
});

crudRoutes.post('/', jsonValidator(CreateTaskSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);
  const body = c.req.valid('json');

  const project = await requireOwnedProject(db, projectId, userId);

  const title = body.title?.trim();
  if (!title) {
    throw errors.badRequest('title is required');
  }

  const [taskCountRow] = await db
    .select({ count: count() })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, project.id));

  if ((taskCountRow?.count ?? 0) >= limits.maxTasksPerProject) {
    throw errors.badRequest(`Maximum ${limits.maxTasksPerProject} tasks allowed per project`);
  }

  let parentTaskId: string | null = null;
  if (body.parentTaskId) {
    const parent = await requireOwnedTaskById(db, body.parentTaskId, userId);
    if (parent.projectId !== project.id) {
      throw errors.badRequest('parentTaskId must reference a task in the same project');
    }
    parentTaskId = parent.id;
  }

  const now = new Date().toISOString();
  const taskId = ulid();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: project.id,
    userId,
    parentTaskId,
    workspaceId: null,
    title,
    description: body.description?.trim() || null,
    status: 'draft',
    priority: body.priority ?? 0,
    agentProfileHint: body.agentProfileHint?.trim() || null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  await appendStatusEvent(db, taskId, null, 'draft', 'user', userId, 'Task created');

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  const task = rows[0];
  if (!task) {
    throw errors.internal('Failed to load created task');
  }

  return c.json(toTaskResponse(task, false), 201);
});

crudRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);

  await requireOwnedProject(db, projectId, userId);

  const requestedStatus = c.req.query('status');
  if (requestedStatus && !isTaskStatus(requestedStatus)) {
    throw errors.badRequest('Invalid status filter');
  }

  const minPriorityQuery = c.req.query('minPriority');
  const minPriority = minPriorityQuery ? Number.parseInt(minPriorityQuery, 10) : undefined;
  if (minPriorityQuery && (!Number.isFinite(minPriority) || Number.isNaN(minPriority))) {
    throw errors.badRequest('minPriority must be an integer');
  }

  const sort = parseTaskSortOrder(c.req.query('sort'));
  const requestedLimit = parsePositiveInt(c.req.query('limit'), limits.taskListDefaultPageSize);
  const limit = Math.min(requestedLimit, limits.taskListMaxPageSize);
  const cursor = c.req.query('cursor')?.trim();

  const conditions: SQL[] = [
    eq(schema.tasks.projectId, projectId),
    eq(schema.tasks.userId, userId),
  ];

  if (requestedStatus) {
    conditions.push(eq(schema.tasks.status, requestedStatus));
  }

  if (minPriority !== undefined) {
    conditions.push(gte(schema.tasks.priority, minPriority));
  }

  if (cursor) {
    conditions.push(lt(schema.tasks.id, cursor));
  }

  let query = db
    .select()
    .from(schema.tasks)
    .where(and(...conditions))
    .$dynamic();

  if (sort === 'updatedAtDesc') {
    query = query.orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.id));
  } else if (sort === 'priorityDesc') {
    query = query.orderBy(desc(schema.tasks.priority), desc(schema.tasks.updatedAt), desc(schema.tasks.id));
  } else {
    query = query.orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id));
  }

  const rows = await query.limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const tasks = hasNextPage ? rows.slice(0, limit) : rows;
  const taskIds = tasks.map((task) => task.id);
  const blockedSet = await computeBlockedSet(db, taskIds);

  const response: ListTasksResponse = {
    tasks: tasks.map((task) => toTaskResponse(task, blockedSet.has(task.id))),
    nextCursor: hasNextPage ? (tasks[tasks.length - 1]?.id ?? null) : null,
  };

  return c.json(response);
});

crudRoutes.get('/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);
  const dependencies = await getTaskDependencies(db, task.id);
  const blocked = await computeBlockedForTask(db, task.id);

  // Enrich with trigger info when task was trigger-spawned
  let trigger: TaskTriggerInfo | undefined;
  let triggerExecution: TaskTriggerExecutionInfo | undefined;

  if (task.triggerId) {
    const [triggerRow] = await db
      .select({
        id: schema.triggers.id,
        name: schema.triggers.name,
        cronExpression: schema.triggers.cronExpression,
        cronTimezone: schema.triggers.cronTimezone,
      })
      .from(schema.triggers)
      .where(eq(schema.triggers.id, task.triggerId))
      .limit(1);

    if (triggerRow) {
      trigger = {
        id: triggerRow.id,
        name: triggerRow.name,
        cronExpression: triggerRow.cronExpression,
        cronTimezone: triggerRow.cronTimezone ?? 'UTC',
        cronHumanReadable: triggerRow.cronExpression
          ? cronToHumanReadable(triggerRow.cronExpression, triggerRow.cronTimezone ?? 'UTC')
          : undefined,
      };
    }
  }

  if (task.triggerExecutionId) {
    const [execRow] = await db
      .select({
        id: schema.triggerExecutions.id,
        sequenceNumber: schema.triggerExecutions.sequenceNumber,
        scheduledAt: schema.triggerExecutions.scheduledAt,
      })
      .from(schema.triggerExecutions)
      .where(eq(schema.triggerExecutions.id, task.triggerExecutionId))
      .limit(1);

    if (execRow) {
      triggerExecution = {
        id: execRow.id,
        sequenceNumber: execRow.sequenceNumber ?? 0,
        scheduledAt: execRow.scheduledAt ?? '',
      };
    }
  }

  const response: TaskDetailResponse = {
    ...toTaskResponse(task, blocked),
    dependencies: dependencies.map(toDependencyResponse),
    blocked,
    trigger,
    triggerExecution,
  };

  return c.json(response);
});

crudRoutes.patch('/:taskId', jsonValidator(UpdateTaskSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  if (
    body.title === undefined &&
    body.description === undefined &&
    body.priority === undefined &&
    body.parentTaskId === undefined
  ) {
    throw errors.badRequest('At least one field is required');
  }

  const nextValues: Partial<schema.NewTask> = {
    updatedAt: new Date().toISOString(),
  };

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) {
      throw errors.badRequest('title cannot be empty');
    }
    nextValues.title = title;
  }

  if (body.description !== undefined) {
    nextValues.description = body.description?.trim() || null;
  }

  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority)) {
      throw errors.badRequest('priority must be an integer');
    }
    nextValues.priority = body.priority;
  }

  if (body.parentTaskId !== undefined) {
    if (body.parentTaskId === null) {
      nextValues.parentTaskId = null;
    } else {
      const parentTaskId = body.parentTaskId.trim();
      if (!parentTaskId) {
        throw errors.badRequest('parentTaskId cannot be empty');
      }
      if (parentTaskId === task.id) {
        throw errors.badRequest('Task cannot be its own parent');
      }
      const parent = await requireOwnedTaskById(db, parentTaskId, userId);
      if (parent.projectId !== projectId) {
        throw errors.badRequest('parentTaskId must reference a task in the same project');
      }
      nextValues.parentTaskId = parent.id;
    }
  }

  await db
    .update(schema.tasks)
    .set(nextValues)
    .where(eq(schema.tasks.id, task.id));

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id))
    .limit(1);

  const updatedTask = rows[0];
  if (!updatedTask) {
    throw errors.notFound('Task');
  }

  const blocked = await computeBlockedForTask(db, updatedTask.id);
  return c.json(toTaskResponse(updatedTask, blocked));
});

crudRoutes.delete('/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  const [dependentCountRow] = await db
    .select({ count: count() })
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.dependsOnTaskId, task.id));

  if ((dependentCountRow?.count ?? 0) > 0) {
    throw errors.conflict('Cannot delete task while other tasks depend on it');
  }

  await db.delete(schema.tasks).where(eq(schema.tasks.id, task.id));

  return c.json({ success: true });
});

crudRoutes.post('/:taskId/status', jsonValidator(UpdateTaskStatusSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  if (!isTaskStatus(body.toStatus)) {
    throw errors.badRequest('Invalid toStatus value');
  }

  const blocked = await computeBlockedForTask(db, task.id);
  if (blocked && isExecutableTaskStatus(body.toStatus)) {
    throw errors.conflict('Task is blocked by unresolved dependencies');
  }

  if (!isTaskStatus(task.status)) {
    throw errors.badRequest(`Invalid task status in database: ${task.status}`);
  }

  if (!canTransitionTaskStatus(task.status, body.toStatus)) {
    throw errors.conflict(
      `Invalid transition ${task.status} -> ${body.toStatus}. Allowed: ${getAllowedTaskTransitions(task.status).join(', ') || 'none'}`
    );
  }

  const updatedTask = await setTaskStatus(db, task, body.toStatus, 'user', userId, {
    reason: body.reason,
    outputSummary: body.outputSummary,
    outputBranch: body.outputBranch,
    outputPrUrl: body.outputPrUrl,
    errorMessage: body.errorMessage,
  });

  // Record activity event for task status change
  c.executionCtx.waitUntil(
    projectDataService.recordActivityEvent(
      c.env, projectId, `task.${body.toStatus}`, 'user', userId,
      null, null, taskId, { title: task.title, fromStatus: task.status, toStatus: body.toStatus }
    ).catch((e) => { log.warn('task.activity_event_failed', { taskId, error: String(e) }); })
  );

  // On terminal states, stop the chat session (best-effort).
  if (body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled') {
    if (updatedTask.workspaceId && updatedTask.projectId) {
      c.executionCtx.waitUntil(
        (async () => {
          const [ws] = await db
            .select({ chatSessionId: schema.workspaces.chatSessionId })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, updatedTask.workspaceId!))
            .limit(1);
          if (ws?.chatSessionId) {
            await projectDataService.stopSession(c.env, updatedTask.projectId, ws.chatSessionId);
          }
        })().catch((e) => { log.error('task.session_stop_failed', { taskId, projectId: updatedTask.projectId, error: String(e) }); })
      );
    }
  }

  const nextBlocked = await computeBlockedForTask(db, updatedTask.id);
  return c.json(toTaskResponse(updatedTask, nextBlocked));
});

crudRoutes.post('/:taskId/status/callback', jsonValidator(UpdateTaskStatusSchema), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.projectId, projectId)))
    .limit(1);

  const task = rows[0];
  if (!task) {
    throw errors.notFound('Task');
  }

  if (!task.workspaceId || payload.workspace !== task.workspaceId) {
    throw errors.forbidden('Token workspace mismatch');
  }

  // --- Execution-step-only update (no status transition) ---
  // When executionStep is provided without toStatus, update the step and
  // optionally persist gitPushResult outputs without changing task status.
  // This is used by the VM agent to report progress (e.g. awaiting_followup
  // after the agent pushes code but the task stays running).
  if (body.executionStep && !body.toStatus) {
    if (!isTaskExecutionStep(body.executionStep)) {
      throw errors.badRequest('Invalid executionStep value');
    }

    const now = new Date().toISOString();
    const stepUpdate: Partial<schema.NewTask> = {
      executionStep: body.executionStep,
      updatedAt: now,
    };

    // Persist git push result fields into existing task columns
    if (body.gitPushResult) {
      // Finalization guard: only save git push results once
      if (!task.finalizedAt && body.gitPushResult.pushed) {
        stepUpdate.finalizedAt = now;
      }
      if (body.gitPushResult.branchName) {
        stepUpdate.outputBranch = body.gitPushResult.branchName;
      }
      if (body.gitPushResult.prUrl) {
        stepUpdate.outputPrUrl = body.gitPushResult.prUrl;
      }
    }

    if (body.outputBranch !== undefined) {
      stepUpdate.outputBranch = body.outputBranch?.trim() || null;
    }
    if (body.outputPrUrl !== undefined) {
      stepUpdate.outputPrUrl = body.outputPrUrl?.trim() || null;
    }

    await db
      .update(schema.tasks)
      .set(stepUpdate)
      .where(eq(schema.tasks.id, task.id));

    // Record activity event for execution step update
    c.executionCtx.waitUntil(
      projectDataService.recordActivityEvent(
        c.env, projectId, 'task.execution_step', 'workspace_callback', payload.workspace,
        task.workspaceId, null, taskId, {
          title: task.title,
          executionStep: body.executionStep,
          pushed: body.gitPushResult?.pushed ?? false,
        }
      ).catch((e) => { log.warn('task.execution_step_activity_failed', { taskId, error: String(e) }); })
    );

    // T034: When agent signals awaiting_followup, start idle cleanup timer.
    // Conversation-mode sessions are exempt — the 2-hour workspace idle timeout
    // is the only kill mechanism for conversation mode (no 15-min idle cleanup).
    if (body.executionStep === 'awaiting_followup' && task.workspaceId && task.taskMode !== 'conversation') {
      c.executionCtx.waitUntil(
        (async () => {
          // Look up the chat session linked to this workspace
          const [ws] = await db
            .select({ chatSessionId: schema.workspaces.chatSessionId })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, task.workspaceId!))
            .limit(1);

          if (ws?.chatSessionId) {
            // Set agent_completed_at on the session
            await projectDataService.markAgentCompleted(c.env, projectId, ws.chatSessionId);

            // Schedule idle cleanup timer
            await projectDataService.scheduleIdleCleanup(
              c.env,
              projectId,
              ws.chatSessionId,
              task.workspaceId!,
              taskId
            );
          }

          // Record agent completion activity event
          await projectDataService.recordActivityEvent(
            c.env, projectId, 'task.agent_completed', 'workspace_callback', payload.workspace,
            task.workspaceId, ws?.chatSessionId ?? null, taskId, {
              title: task.title,
              pushed: body.gitPushResult?.pushed ?? false,
              branchName: body.gitPushResult?.branchName ?? null,
              prUrl: body.gitPushResult?.prUrl ?? null,
            }
          );

          // Emit session-ended notification (best-effort)
          if (c.env.NOTIFICATION) {
            const projectName = await notificationService.getProjectName(c.env, projectId);
            await notificationService.notifySessionEnded(c.env, task.userId, {
              projectId,
              projectName,
              sessionId: ws?.chatSessionId ?? '',
              taskId,
              taskTitle: task.title,
            });

            // If a PR was created, emit a separate pr_created notification
            if (body.gitPushResult?.prUrl) {
              await notificationService.notifyPrCreated(c.env, task.userId, {
                projectId,
                projectName,
                taskId,
                taskTitle: task.title,
                prUrl: body.gitPushResult.prUrl,
                branchName: body.gitPushResult.branchName,
                sessionId: ws?.chatSessionId,
              });
            }
          }
        })().catch((err) => {
          log.error('task.idle_cleanup_schedule_failed', { taskId, error: err instanceof Error ? err.message : String(err) });
        })
      );
    }

    const [refreshed] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id))
      .limit(1);

    const blocked = await computeBlockedForTask(db, task.id);
    return c.json(toTaskResponse(refreshed ?? task, blocked));
  }

  // --- Standard status transition ---
  if (!isTaskStatus(body.toStatus)) {
    throw errors.badRequest('Invalid toStatus value');
  }

  if (!isTaskStatus(task.status)) {
    throw errors.badRequest(`Invalid task status in database: ${task.status}`);
  }

  if (!canTransitionTaskStatus(task.status, body.toStatus)) {
    throw errors.conflict(
      `Invalid transition ${task.status} -> ${body.toStatus}. Allowed: ${getAllowedTaskTransitions(task.status).join(', ') || 'none'}`
    );
  }

  const updatedTask = await setTaskStatus(db, task, body.toStatus, 'workspace_callback', payload.workspace, {
    reason: body.reason,
    outputSummary: body.outputSummary,
    outputBranch: body.outputBranch,
    outputPrUrl: body.outputPrUrl,
    errorMessage: body.errorMessage,
  });

  // Record activity event for task status change (from workspace callback)
  c.executionCtx.waitUntil(
    projectDataService.recordActivityEvent(
      c.env, projectId, `task.${body.toStatus}`, 'workspace_callback', payload.workspace,
      task.workspaceId, null, taskId, { title: task.title, fromStatus: task.status, toStatus: body.toStatus }
    ).catch((e) => { log.warn('task.callback_activity_event_failed', { taskId, error: String(e) }); })
  );

  // On terminal states, stop the chat session and handle workspace cleanup.
  if (body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled') {
    // Stop the chat session in ProjectData DO (best-effort).
    // chatSessionId lives on the workspace, not the task — look it up.
    if (updatedTask.workspaceId && updatedTask.projectId) {
      c.executionCtx.waitUntil(
        (async () => {
          const [ws] = await db
            .select({ chatSessionId: schema.workspaces.chatSessionId })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, updatedTask.workspaceId!))
            .limit(1);
          if (ws?.chatSessionId) {
            await projectDataService.stopSession(c.env, updatedTask.projectId, ws.chatSessionId);
          }
        })().catch((e) => { log.error('task.callback_session_stop_failed', { taskId, projectId: updatedTask.projectId, error: String(e) }); })
      );
    }

    // On clean completion, auto-trigger workspace cleanup (destroy workspace + optionally node).
    // On failure/cancellation, keep workspace alive for debugging.
    if (body.toStatus === 'completed') {
      c.executionCtx.waitUntil(
        cleanupTaskRun(taskId, c.env).catch((e) => { log.error('task.cleanup_failed', { taskId, error: String(e) }); })
      );
    }

    // Emit notifications for terminal task states (best-effort)
    if (c.env.NOTIFICATION) {
      c.executionCtx.waitUntil(
        (async () => {
          const [ws] = await db
            .select({ chatSessionId: schema.workspaces.chatSessionId })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, updatedTask.workspaceId!))
            .limit(1);
          const sessionId = ws?.chatSessionId ?? null;

          const projectName = await notificationService.getProjectName(c.env, projectId);
          if (body.toStatus === 'completed') {
            await notificationService.notifyTaskComplete(c.env, task.userId, {
              projectId,
              projectName,
              taskId,
              taskTitle: task.title,
              sessionId,
              outputPrUrl: updatedTask.outputPrUrl,
              outputBranch: updatedTask.outputBranch,
            });
          } else if (body.toStatus === 'failed') {
            await notificationService.notifyTaskFailed(c.env, task.userId, {
              projectId,
              projectName,
              taskId,
              taskTitle: task.title,
              errorMessage: body.errorMessage,
              sessionId,
            });
          }
        })().catch((e) => { log.warn('task.notification_failed', { taskId, error: String(e) }); })
      );
    }
  }

  const blocked = await computeBlockedForTask(db, updatedTask.id);
  return c.json(toTaskResponse(updatedTask, blocked));
});

crudRoutes.post('/:taskId/dependencies', jsonValidator(CreateTaskDependencySchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);
  const body = c.req.valid('json');

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);
  const dependsOnTaskId = body.dependsOnTaskId?.trim();

  if (!dependsOnTaskId) {
    throw errors.badRequest('dependsOnTaskId is required');
  }

  if (dependsOnTaskId === task.id) {
    throw errors.badRequest('Task cannot depend on itself');
  }

  const dependencyTask = await requireOwnedTaskById(db, dependsOnTaskId, userId);
  if (dependencyTask.projectId !== projectId) {
    throw errors.badRequest('Dependency task must belong to the same project');
  }

  const [dependencyCountRow] = await db
    .select({ count: count() })
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, task.id));

  if ((dependencyCountRow?.count ?? 0) >= limits.maxTaskDependenciesPerTask) {
    throw errors.badRequest(
      `Maximum ${limits.maxTaskDependenciesPerTask} dependencies allowed per task`
    );
  }

  const projectEdges = await db
    .select({
      taskId: schema.taskDependencies.taskId,
      dependsOnTaskId: schema.taskDependencies.dependsOnTaskId,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(eq(schema.tasks.projectId, projectId));

  const edges: TaskDependencyEdge[] = projectEdges.map((edge) => ({
    taskId: edge.taskId,
    dependsOnTaskId: edge.dependsOnTaskId,
  }));

  if (wouldCreateTaskDependencyCycle(task.id, dependencyTask.id, edges)) {
    throw errors.conflict('Dependency would create a cycle');
  }

  const now = new Date().toISOString();
  try {
    await db.insert(schema.taskDependencies).values({
      taskId: task.id,
      dependsOnTaskId: dependencyTask.id,
      createdBy: userId,
      createdAt: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('unique')) {
      throw errors.conflict('Dependency already exists');
    }
    throw error;
  }

  return c.json({
    taskId: task.id,
    dependsOnTaskId: dependencyTask.id,
    createdAt: now,
  }, 201);
});

crudRoutes.delete('/:taskId/dependencies', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const dependsOnTaskId = c.req.query('dependsOnTaskId')?.trim();
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);
  await requireOwnedTask(db, projectId, taskId, userId);

  if (!dependsOnTaskId) {
    throw errors.badRequest('dependsOnTaskId query parameter is required');
  }

  const result = await db
    .delete(schema.taskDependencies)
    .where(
      and(
        eq(schema.taskDependencies.taskId, taskId),
        eq(schema.taskDependencies.dependsOnTaskId, dependsOnTaskId)
      )
    )
    .returning();

  if (result.length === 0) {
    throw errors.notFound('Task dependency');
  }

  return c.json({ success: true });
});

crudRoutes.post('/:taskId/delegate', jsonValidator(DelegateTaskSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  if (task.status !== 'ready') {
    throw errors.conflict('Only ready tasks can be delegated');
  }

  const blocked = await computeBlockedForTask(db, task.id);
  if (blocked) {
    throw errors.conflict('Blocked tasks cannot be delegated');
  }

  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) {
    throw errors.badRequest('workspaceId is required');
  }

  const workspace = await requireOwnedWorkspace(db, workspaceId, userId);
  if (workspace.status !== 'running') {
    throw errors.badRequest('Workspace must be running to accept delegated tasks');
  }

  const now = new Date().toISOString();

  await db
    .update(schema.tasks)
    .set({
      workspaceId: workspace.id,
      status: 'delegated',
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, task.id));

  await appendStatusEvent(db, task.id, task.status as TaskStatus, 'delegated', 'user', userId, 'Delegated to workspace');

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id))
    .limit(1);

  const updatedTask = rows[0];
  if (!updatedTask) {
    throw errors.notFound('Task');
  }

  return c.json(toTaskResponse(updatedTask, false));
});

crudRoutes.get('/:taskId/events', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);

  await requireOwnedProject(db, projectId, userId);
  await requireOwnedTask(db, projectId, taskId, userId);

  const requestedLimit = parsePositiveInt(c.req.query('limit'), limits.taskListDefaultPageSize);
  const limit = Math.min(requestedLimit, limits.taskListMaxPageSize);

  const events = await db
    .select()
    .from(schema.taskStatusEvents)
    .where(eq(schema.taskStatusEvents.taskId, taskId))
    .orderBy(desc(schema.taskStatusEvents.createdAt))
    .limit(limit);

  const response: ListTaskEventsResponse = {
    events: events.map((event) => ({
      id: event.id,
      taskId: event.taskId,
      fromStatus: (event.fromStatus as TaskStatus | null) ?? null,
      toStatus: event.toStatus as TaskStatus,
      actorType: event.actorType as TaskActorType,
      actorId: event.actorId,
      reason: event.reason,
      createdAt: event.createdAt,
    })),
  };

  return c.json(response);
});

// ─── Close conversation endpoint ──────────────────────────────────────────────
// Human-initiated completion for conversation-mode tasks.
// POST /api/projects/:projectId/tasks/:taskId/close
crudRoutes.post('/:taskId/close', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTaskById(db, taskId, userId);

  // Only conversation-mode tasks can be closed via this endpoint
  if (task.taskMode !== 'conversation') {
    throw errors.badRequest('Only conversation-mode tasks can be closed via this endpoint. Use complete_task for task-mode tasks.');
  }

  // Only active tasks can be closed
  const closableStatuses: TaskStatus[] = ['in_progress', 'delegated'];
  if (!closableStatuses.includes(task.status as TaskStatus)) {
    throw errors.badRequest(`Task cannot be closed from status '${task.status}'. Must be in_progress or delegated.`);
  }

  const now = new Date().toISOString();

  await db.update(schema.tasks)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(eq(schema.tasks.id, taskId));

  await appendStatusEvent(db, taskId, task.status as TaskStatus, 'completed', 'user', userId, 'Conversation closed by user');

  // Record activity event (best-effort)
  c.executionCtx.waitUntil(
    projectDataService.recordActivityEvent(
      c.env,
      projectId,
      'task.completed',
      'user',
      userId,
      null,
      null,
      taskId,
      { reason: 'Conversation closed by user' }
    ).catch(() => { /* best-effort */ })
  );

  // Stop the DO session if the task has a workspace with a chat session (best-effort)
  if (task.workspaceId) {
    c.executionCtx.waitUntil(
      (async () => {
        const [ws] = await db.select({ chatSessionId: schema.workspaces.chatSessionId })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, task.workspaceId!))
          .limit(1);
        if (ws?.chatSessionId) {
          await projectDataService.stopSession(c.env, projectId, ws.chatSessionId);
        }
      })().catch((e) => { log.error('task.close_session_stop_failed', { taskId, projectId, error: String(e) }); })
    );
  }

  log.info('task.conversation_closed', { taskId, projectId, userId });

  return c.json({ status: 'completed', closedAt: now });
});

/**
 * GET /api/projects/:projectId/tasks/:taskId/sessions
 * List all chat sessions linked to a task (idea). Useful for the Ideas page timeline.
 */
crudRoutes.get('/:taskId/sessions', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const sessions = await projectDataService.getSessionsForIdea(c.env, projectId, taskId);

  return c.json({ sessions, count: sessions.length });
});

export { crudRoutes };
