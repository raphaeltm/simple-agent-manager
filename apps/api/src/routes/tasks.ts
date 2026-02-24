import { Hono } from 'hono';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type {
  CreateTaskDependencyRequest,
  CreateTaskRequest,
  DelegateTaskRequest,
  ListTaskEventsResponse,
  ListTasksResponse,
  Task,
  TaskActorType,
  TaskDependency,
  TaskDetailResponse,
  TaskSortOrder,
  TaskStatus,
  UpdateTaskRequest,
  UpdateTaskStatusRequest,
} from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { getUserId, requireAuth, requireApproved } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject, requireOwnedTask, requireOwnedWorkspace } from '../middleware/project-auth';
import {
  canTransitionTaskStatus,
  getAllowedTaskTransitions,
  isExecutableTaskStatus,
  isTaskStatus,
} from '../services/task-status';
import {
  getBlockedTaskIds,
  isTaskBlocked,
  wouldCreateTaskDependencyCycle,
  type TaskDependencyEdge,
} from '../services/task-graph';
import { getRuntimeLimits } from '../services/limits';
import { verifyCallbackToken } from '../services/jwt';
import { cleanupTaskRun } from '../services/task-runner';
import * as projectDataService from '../services/project-data';

const tasksRoutes = new Hono<{ Bindings: Env }>();

tasksRoutes.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/status/callback')) {
    return next();
  }
  return requireAuth()(c, async () => {
    await requireApproved()(c, next);
  });
});

function requireRouteParam(
  c: { req: { param: (name: string) => string | undefined } },
  name: string
): string {
  const value = c.req.param(name);
  if (!value) {
    throw errors.badRequest(`${name} is required`);
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseTaskSortOrder(value: string | undefined): TaskSortOrder {
  if (value === 'updatedAtDesc' || value === 'priorityDesc') {
    return value;
  }
  return 'createdAtDesc';
}

function toTaskResponse(task: schema.Task, blocked = false): Task {
  return {
    id: task.id,
    projectId: task.projectId,
    userId: task.userId,
    parentTaskId: task.parentTaskId,
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    status: task.status as TaskStatus,
    executionStep: (task.executionStep as Task['executionStep']) ?? null,
    priority: task.priority,
    agentProfileHint: task.agentProfileHint,
    blocked,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    errorMessage: task.errorMessage,
    outputSummary: task.outputSummary,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toDependencyResponse(dependency: schema.TaskDependency): TaskDependency {
  return {
    taskId: dependency.taskId,
    dependsOnTaskId: dependency.dependsOnTaskId,
    createdAt: dependency.createdAt,
  };
}

async function requireOwnedTaskById(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string,
  userId: string
): Promise<schema.Task> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)))
    .limit(1);

  const task = rows[0];
  if (!task) {
    throw errors.notFound('Task');
  }

  return task;
}

async function appendStatusEvent(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string,
  fromStatus: TaskStatus | null,
  toStatus: TaskStatus,
  actorType: TaskActorType,
  actorId: string | null,
  reason?: string
): Promise<void> {
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus,
    toStatus,
    actorType,
    actorId,
    reason: reason ?? null,
    createdAt: new Date().toISOString(),
  });
}

async function getTaskDependencies(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string
): Promise<schema.TaskDependency[]> {
  return db
    .select()
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, taskId));
}

async function computeBlockedForTask(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string
): Promise<boolean> {
  const dependencies = await getTaskDependencies(db, taskId);
  if (dependencies.length === 0) {
    return false;
  }

  const dependencyIds = dependencies.map((dependency) => dependency.dependsOnTaskId);
  const dependencyTasks = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, dependencyIds));

  const statusMap: Record<string, TaskStatus> = {};
  for (const dependencyTask of dependencyTasks) {
    statusMap[dependencyTask.id] = dependencyTask.status as TaskStatus;
  }

  return isTaskBlocked(taskId, dependencies, statusMap);
}

async function computeBlockedSet(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskIds: string[]
): Promise<Set<string>> {
  if (taskIds.length === 0) {
    return new Set<string>();
  }

  const dependencies = await db
    .select({
      taskId: schema.taskDependencies.taskId,
      dependsOnTaskId: schema.taskDependencies.dependsOnTaskId,
    })
    .from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, taskIds));

  if (dependencies.length === 0) {
    return new Set<string>();
  }

  const dependencyTaskIds = [...new Set(dependencies.map((dependency) => dependency.dependsOnTaskId))];
  const dependencyTasks = dependencyTaskIds.length === 0
    ? []
    : await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, dependencyTaskIds));

  const statusMap: Record<string, TaskStatus> = {};
  for (const dependencyTask of dependencyTasks) {
    statusMap[dependencyTask.id] = dependencyTask.status as TaskStatus;
  }

  return getBlockedTaskIds(taskIds, dependencies, statusMap);
}

async function setTaskStatus(
  db: ReturnType<typeof drizzle<typeof schema>>,
  task: schema.Task,
  toStatus: TaskStatus,
  actorType: TaskActorType,
  actorId: string | null,
  options: {
    reason?: string;
    outputSummary?: string;
    outputBranch?: string;
    outputPrUrl?: string;
    errorMessage?: string;
  } = {}
): Promise<schema.Task> {
  const now = new Date().toISOString();

  const nextValues: Partial<schema.NewTask> = {
    status: toStatus,
    updatedAt: now,
  };

  if (toStatus === 'in_progress' && !task.startedAt) {
    nextValues.startedAt = now;
  }

  if (toStatus === 'completed' || toStatus === 'failed' || toStatus === 'cancelled') {
    nextValues.completedAt = now;
    nextValues.executionStep = null;
  }

  if (toStatus === 'ready') {
    nextValues.workspaceId = null;
    nextValues.startedAt = null;
    nextValues.completedAt = null;
    nextValues.errorMessage = null;
    nextValues.executionStep = null;
  }

  if (options.outputSummary !== undefined) {
    nextValues.outputSummary = options.outputSummary?.trim() || null;
  }

  if (options.outputBranch !== undefined) {
    nextValues.outputBranch = options.outputBranch?.trim() || null;
  }

  if (options.outputPrUrl !== undefined) {
    nextValues.outputPrUrl = options.outputPrUrl?.trim() || null;
  }

  if (toStatus === 'failed') {
    nextValues.errorMessage = options.errorMessage?.trim() || task.errorMessage || 'Task failed';
  } else if (options.errorMessage !== undefined) {
    nextValues.errorMessage = options.errorMessage?.trim() || null;
  }

  await db
    .update(schema.tasks)
    .set(nextValues)
    .where(eq(schema.tasks.id, task.id));

  await appendStatusEvent(
    db,
    task.id,
    task.status as TaskStatus,
    toStatus,
    actorType,
    actorId,
    options.reason
  );

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id))
    .limit(1);
  const updatedTask = rows[0];
  if (!updatedTask) {
    throw errors.notFound('Task');
  }

  return updatedTask;
}

tasksRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);
  const body = await c.req.json<CreateTaskRequest>();

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

tasksRoutes.get('/', async (c) => {
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

tasksRoutes.get('/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);
  const dependencies = await getTaskDependencies(db, task.id);
  const blocked = await computeBlockedForTask(db, task.id);

  const response: TaskDetailResponse = {
    ...toTaskResponse(task, blocked),
    dependencies: dependencies.map(toDependencyResponse),
    blocked,
  };

  return c.json(response);
});

tasksRoutes.patch('/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpdateTaskRequest>();

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

tasksRoutes.delete('/:taskId', async (c) => {
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

tasksRoutes.post('/:taskId/status', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpdateTaskStatusRequest>();

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  if (!isTaskStatus(body.toStatus)) {
    throw errors.badRequest('Invalid toStatus value');
  }

  const blocked = await computeBlockedForTask(db, task.id);
  if (blocked && isExecutableTaskStatus(body.toStatus)) {
    throw errors.conflict('Task is blocked by unresolved dependencies');
  }

  if (!canTransitionTaskStatus(task.status as TaskStatus, body.toStatus)) {
    throw errors.conflict(
      `Invalid transition ${task.status} -> ${body.toStatus}. Allowed: ${getAllowedTaskTransitions(task.status as TaskStatus).join(', ') || 'none'}`
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
    ).catch(() => { /* best-effort */ })
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
        })().catch(() => { /* best-effort */ })
      );
    }
  }

  const nextBlocked = await computeBlockedForTask(db, updatedTask.id);
  return c.json(toTaskResponse(updatedTask, nextBlocked));
});

tasksRoutes.post('/:taskId/status/callback', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpdateTaskStatusRequest>();

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
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

  if (!isTaskStatus(body.toStatus)) {
    throw errors.badRequest('Invalid toStatus value');
  }

  if (!canTransitionTaskStatus(task.status as TaskStatus, body.toStatus)) {
    throw errors.conflict(
      `Invalid transition ${task.status} -> ${body.toStatus}. Allowed: ${getAllowedTaskTransitions(task.status as TaskStatus).join(', ') || 'none'}`
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
    ).catch(() => { /* best-effort */ })
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
        })().catch(() => { /* best-effort */ })
      );
    }

    // On clean completion, auto-trigger workspace cleanup (destroy workspace + optionally node).
    // On failure/cancellation, keep workspace alive for debugging.
    if (body.toStatus === 'completed') {
      c.executionCtx.waitUntil(
        cleanupTaskRun(taskId, c.env).catch(() => { /* best-effort */ })
      );
    }
  }

  const blocked = await computeBlockedForTask(db, updatedTask.id);
  return c.json(toTaskResponse(updatedTask, blocked));
});

tasksRoutes.post('/:taskId/dependencies', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);
  const body = await c.req.json<CreateTaskDependencyRequest>();

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

tasksRoutes.delete('/:taskId/dependencies', async (c) => {
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

tasksRoutes.post('/:taskId/delegate', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<DelegateTaskRequest>();

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

tasksRoutes.get('/:taskId/events', async (c) => {
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

export { tasksRoutes };
