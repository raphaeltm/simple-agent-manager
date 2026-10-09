import type { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { setTaskStatus } from '../routes/tasks/_helpers';
import * as projectDataService from './project-data';
import { recordTaskLifecycleEventBestEffort } from './project-lifecycle-events';
import { canTransitionTaskStatus, isTaskStatus } from './task-status';
import { cleanupTerminalTaskResourcesOrThrow } from './task-terminal-cleanup';

/** Call after project/target authorization. Terminal retries still finish cleanup. */
export async function cancelTask(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  task: schema.Task,
  userId: string,
  options: Omit<NonNullable<Parameters<typeof setTaskStatus>[5]>, 'callbackFence'> & {
    source?: string;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {}
): Promise<schema.Task> {
  if (!isTaskStatus(task.status)) throw errors.conflict('Task has an invalid status');
  const terminal =
    task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  if (!terminal && !canTransitionTaskStatus(task.status, 'cancelled'))
    throw errors.conflict('Task cannot be cancelled in its current state');
  const updated = terminal
    ? task
    : await setTaskStatus(db, task, 'cancelled', 'user', userId, options);
  if (!terminal) {
    const events = Promise.all([
      recordTaskLifecycleEventBestEffort(env, {
        projectId: task.projectId,
        taskId: task.id,
        status: 'cancelled',
        fromStatus: task.status,
        workspaceId: task.workspaceId,
        actorType: 'user',
        actorId: userId,
        reason: options.reason ?? options.errorMessage ?? null,
        source: options.source ?? 'tasks.user_status',
        occurredAt: updated.updatedAt,
        title: task.title,
      }),
      projectDataService
        .recordActivityEvent(
          env,
          task.projectId,
          'task.cancelled',
          'user',
          userId,
          null,
          null,
          task.id,
          { title: task.title, fromStatus: task.status, toStatus: 'cancelled' }
        )
        .catch((error) =>
          log.warn('task.activity_event_failed', { taskId: task.id, error: String(error) })
        ),
    ]);
    if (options.waitUntil) options.waitUntil(events);
    else await events;
  }
  await cleanupTerminalTaskResourcesOrThrow(env, task.id, {
    status: terminal ? (task.status as 'completed' | 'failed' | 'cancelled') : 'cancelled',
    errorMessage: updated.errorMessage,
    requiredUserId: userId,
    projectId: task.projectId,
    failureLogEvent: 'task.terminal_cleanup_failed',
    logContext: { projectId: task.projectId, source: options.source ?? 'tasks.status' },
  });
  return updated;
}
