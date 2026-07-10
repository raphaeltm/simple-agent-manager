import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { cleanupTaskRun } from './task-runner';

export type TerminalTaskCleanupStatus = 'completed' | 'failed' | 'cancelled';

export interface TerminalTaskCleanupOptions {
  status: TerminalTaskCleanupStatus;
  errorMessage?: string | null;
  logContext?: Record<string, unknown>;
}

export async function cleanupTerminalTaskResources(
  env: Env,
  taskId: string,
  options: TerminalTaskCleanupOptions
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const [task] = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      workspaceId: schema.tasks.workspaceId,
      errorMessage: schema.tasks.errorMessage,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  if (!task?.workspaceId || !task.projectId) {
    return;
  }

  const [workspace] = await db
    .select({ chatSessionId: schema.workspaces.chatSessionId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, task.workspaceId))
    .limit(1);

  if (workspace?.chatSessionId) {
    try {
      if (options.status === 'failed') {
        await projectDataService.failSession(
          env,
          task.projectId,
          workspace.chatSessionId,
          options.errorMessage ?? task.errorMessage ?? null
        );
      } else {
        await projectDataService.stopSession(env, task.projectId, workspace.chatSessionId);
      }
    } catch (err) {
      log.warn('task.terminal_cleanup.session_update_failed', {
        taskId,
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        sessionId: workspace.chatSessionId,
        status: options.status,
        error: err instanceof Error ? err.message : String(err),
        ...options.logContext,
      });
    }
  }

  await cleanupTaskRun(taskId, env);
}
