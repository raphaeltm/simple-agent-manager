import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { setTaskStatus } from '../routes/tasks/_helpers';
import * as projectDataService from './project-data';
import { recordTaskLifecycleEventBestEffort } from './project-lifecycle-events';
import { taskRecoveryCancellationQuery } from './task-recovery-cancellation';
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
    requireStopAcknowledgement?: boolean;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {}
): Promise<schema.Task> {
  if (!isTaskStatus(task.status)) throw errors.conflict('Task has an invalid status');
  const terminal =
    task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  if (!terminal && !canTransitionTaskStatus(task.status, 'cancelled'))
    throw errors.conflict('Task cannot be cancelled in its current state');
  // Revoke accepted, unissued deliveries before publishing the terminal D1
  // state: an old delivery must not mistake that state for fresh human intent.
  const workspaceSession =
    !task.chatSessionId && task.workspaceId
      ? await db
          .select({ chatSessionId: schema.workspaces.chatSessionId })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.id, task.workspaceId),
              eq(schema.workspaces.projectId, task.projectId),
              eq(schema.workspaces.userId, task.userId)
            )
          )
          .get()
      : null;
  const chatSessionId = task.chatSessionId ?? workspaceSession?.chatSessionId;
  if (chatSessionId) {
    await projectDataService.cancelUnissuedSessionPrompts(
      env,
      task.projectId,
      chatSessionId,
      task.id
    );
  }
  let updated: schema.Task;
  if (terminal) {
    // A repeated stop is NEW cancellation intent, even when the verdict is
    // already terminal. Move its terminal fence without changing that verdict
    // or repeating completion events/trigger side effects. A same-ms retry must
    // also invalidate a wake that observed the previous terminal outcome.
    const prior = Date.parse(task.completedAt ?? '');
    const now = new Date(
      Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)
    ).toISOString();
    const [rows] = await db.batch([
      db
        .update(schema.tasks)
        .set({ completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.tasks.id, task.id),
            eq(schema.tasks.projectId, task.projectId),
            eq(schema.tasks.status, task.status),
            sql`${schema.tasks.completedAt} IS ${task.completedAt}`
          )
        )
        .returning(),
      taskRecoveryCancellationQuery(db, task, now),
    ]);
    if (!rows[0]) throw errors.conflict('Task changed before cancellation; retry the stop');
    updated = rows[0];
  } else {
    updated = await setTaskStatus(db, task, 'cancelled', 'user', userId, options);
  }
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
    requireStopAcknowledgement: options.requireStopAcknowledgement,
    projectId: task.projectId,
    failureLogEvent: 'task.terminal_cleanup_failed',
    logContext: { projectId: task.projectId, source: options.source ?? 'tasks.status' },
  });
  return updated;
}
