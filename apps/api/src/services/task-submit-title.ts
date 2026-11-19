/** Deterministic initial titles and best-effort work after task submission. */
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import type { TaskTitleConfig } from './task-title';
import { generateTaskTitle, truncateTitle } from './task-title';

export function getInitialTaskTitle(message: string, config: TaskTitleConfig): string {
  const configuredMax = config.maxLength;
  const maxLength =
    typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 3
      ? configuredMax
      : DEFAULT_TASK_TITLE_MAX_LENGTH;
  return truncateTitle(message, maxLength);
}

async function updateGeneratedTaskTitle(input: {
  env: Env;
  projectId: string;
  taskId: string;
  sessionId: string;
  message: string;
  initialTitle: string;
  titleConfig: TaskTitleConfig;
}): Promise<void> {
  try {
    const generatedTitle = await generateTaskTitle(input.env, input.message, input.titleConfig);
    const taskTitle = generatedTitle.trim();
    if (!taskTitle || taskTitle === input.initialTitle) return;

    const db = drizzle(input.env.DATABASE, { schema });
    const updatedAt = new Date().toISOString();
    await db
      .update(schema.tasks)
      .set({ title: taskTitle, updatedAt })
      .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.projectId, input.projectId)));

    const sessionUpdated = await projectDataService.updateSessionTopic(
      input.env,
      input.projectId,
      input.sessionId,
      taskTitle
    );

    log.info('task_submit.title_generated_async', {
      taskId: input.taskId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionUpdated,
    });
  } catch (err) {
    log.warn('task_submit.title_generation_async_failed', {
      taskId: input.taskId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function schedulePostSubmitWork(
  input: Parameters<typeof updateGeneratedTaskTitle>[0] & {
    waitUntil: (promise: Promise<unknown>) => void;
    userId: string;
    branchName: string;
    via?: string;
    clientName?: string;
  }
): void {
  input.waitUntil(updateGeneratedTaskTitle(input));
  input.waitUntil(
    projectDataService
      .recordActivityEvent(
        input.env,
        input.projectId,
        'task.submitted',
        'user',
        input.userId,
        null,
        input.sessionId,
        input.taskId,
        {
          title: input.initialTitle,
          branchName: input.branchName,
          via: input.via,
          clientName: input.clientName,
        }
      )
      .catch(() => {
        /* best-effort */
      })
  );
}
