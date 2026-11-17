import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

export interface TaskCancellationTarget {
  id: string;
  projectId: string;
  userId: string;
  chatSessionId?: string | null;
  workspaceId?: string | null;
}

/** Retire only the requested task's conversation; a successor is a different owner. */
export async function retireTaskCancellationPrompts(
  env: Env,
  target: TaskCancellationTarget,
  beforeSideEffect?: () => Promise<unknown>
): Promise<projectDataService.CancelUnissuedSessionPromptsResult & { sessionId: string | null }> {
  const db = drizzle(env.DATABASE, { schema });
  const task = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, target.id),
        eq(schema.tasks.projectId, target.projectId),
        eq(schema.tasks.userId, target.userId)
      )
    )
    .get();
  if (!task) return { matched: false, reason: 'missing', cancelled: 0, sessionId: null };
  const workspace =
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
  const sessionId = task.chatSessionId ?? workspace?.chatSessionId ?? null;
  if (!sessionId) return { matched: false, reason: 'missing', cancelled: 0, sessionId };
  await beforeSideEffect?.();
  let result = await projectDataService.cancelUnissuedSessionPrompts(
    env,
    task.projectId,
    sessionId,
    task.id
  );
  if (!result.matched && result.reason === 'task_unbound' && task.chatSessionId === sessionId) {
    // Repair only a positively identified canonical NULL binding. Workspace pointers
    // alone are insufficient, and a newer member of a legacy recovery family wins.
    const owner = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, task.id),
          eq(schema.tasks.projectId, task.projectId),
          eq(schema.tasks.userId, task.userId),
          eq(schema.tasks.chatSessionId, sessionId),
          isNull(schema.tasks.supersededByTaskId),
          sql`NOT EXISTS (SELECT 1 FROM tasks successor
        WHERE successor.project_id = ${task.projectId} AND successor.id <> ${task.id}
          AND successor.created_at >= ${task.createdAt}
          AND (successor.recovery_source_task_id = ${task.id}
            OR successor.recovery_source_task_id = ${task.recoverySourceTaskId ?? task.id}))`
        )
      )
      .get();
    if (owner) {
      await beforeSideEffect?.();
      const linked = await projectDataService.linkSessionToTask(
        env,
        task.projectId,
        sessionId,
        task.id
      );
      if (linked) {
        await beforeSideEffect?.();
        result = await projectDataService.cancelUnissuedSessionPrompts(
          env,
          task.projectId,
          sessionId,
          task.id
        );
      }
    }
  }
  if (!result.matched)
    log.info('task.cancellation_session_binding_skipped', {
      taskId: task.id,
      projectId: task.projectId,
      sessionId,
      reason: result.reason,
    });
  return { ...result, sessionId };
}
