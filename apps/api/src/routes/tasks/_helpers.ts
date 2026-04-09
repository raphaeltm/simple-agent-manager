/**
 * Shared task route helpers — used across crud.ts, run.ts, and submit.ts.
 *
 * Extracted from the original tasks.ts to avoid duplication across sub-routers.
 */
import type { TaskActorType, TaskSortOrder, TaskStatus } from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import {
  getBlockedTaskIds,
  isTaskBlocked,
} from '../../services/task-graph';

export function parseTaskSortOrder(value: string | undefined): TaskSortOrder {
  if (value === 'updatedAtDesc' || value === 'priorityDesc') {
    return value;
  }
  return 'createdAtDesc';
}

export async function requireOwnedTaskById(
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

export async function appendStatusEvent(
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

export async function getTaskDependencies(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string
): Promise<schema.TaskDependency[]> {
  return db
    .select()
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, taskId));
}

export async function computeBlockedForTask(
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

/**
 * D1 limits bound parameters to ~100 per statement. When passing large ID
 * arrays to inArray(), we must batch into chunks to stay under the limit.
 */
const D1_INARRAY_BATCH_SIZE = 80;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function computeBlockedSet(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskIds: string[]
): Promise<Set<string>> {
  if (taskIds.length === 0) {
    return new Set<string>();
  }

  // Batch the dependency lookup to avoid D1 parameter limit
  const dependencies: { taskId: string; dependsOnTaskId: string }[] = [];
  for (const batch of chunk(taskIds, D1_INARRAY_BATCH_SIZE)) {
    const rows = await db
      .select({
        taskId: schema.taskDependencies.taskId,
        dependsOnTaskId: schema.taskDependencies.dependsOnTaskId,
      })
      .from(schema.taskDependencies)
      .where(inArray(schema.taskDependencies.taskId, batch));
    dependencies.push(...rows);
  }

  if (dependencies.length === 0) {
    return new Set<string>();
  }

  // Batch the status lookup for dependency targets
  const dependencyTaskIds = [...new Set(dependencies.map((d) => d.dependsOnTaskId))];
  const dependencyTasks: { id: string; status: string }[] = [];
  for (const batch of chunk(dependencyTaskIds, D1_INARRAY_BATCH_SIZE)) {
    const rows = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, batch));
    dependencyTasks.push(...rows);
  }

  const statusMap: Record<string, TaskStatus> = {};
  for (const dependencyTask of dependencyTasks) {
    statusMap[dependencyTask.id] = dependencyTask.status as TaskStatus;
  }

  return getBlockedTaskIds(taskIds, dependencies, statusMap);
}

export async function setTaskStatus(
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

  // Sync trigger execution status when task reaches a terminal state
  if (
    (toStatus === 'completed' || toStatus === 'failed' || toStatus === 'cancelled') &&
    updatedTask.triggerExecutionId
  ) {
    const execStatus = toStatus === 'completed' ? 'completed' : 'failed';
    await db
      .update(schema.triggerExecutions)
      .set({
        status: execStatus,
        completedAt: now,
        errorMessage: toStatus === 'failed' ? (options.errorMessage?.trim() || 'Task failed') : null,
      })
      .where(eq(schema.triggerExecutions.id, updatedTask.triggerExecutionId))
      .catch((err) => {
        // Best-effort — don't fail the task status update if execution sync fails
        // eslint-disable-next-line no-console
        console.error('trigger_execution_sync_failed', {
          taskId: task.id,
          triggerExecutionId: updatedTask.triggerExecutionId,
          error: String(err),
        });
      });
  }

  return updatedTask;
}
