import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { queueWorkspaceSessionSleep } from './session-sleep';
import { deleteSessionSnapshotState } from './session-snapshots';
import { cleanupTaskRun } from './task-runner';

export type TerminalTaskCleanupStatus = 'completed' | 'failed' | 'cancelled';

export interface TerminalTaskCleanupOptions {
  status: TerminalTaskCleanupStatus;
  errorMessage?: string | null;
  requiredUserId?: string;
  logContext?: Record<string, unknown>;
  /** Archive/delete intent: discard the seven-day restore state. */
  destructiveSessionEnd?: boolean;
}

export interface TerminalTaskCleanupOrThrowOptions extends TerminalTaskCleanupOptions {
  projectId: string;
  failureLogEvent: string;
}

export async function cleanupTerminalTaskResourcesOrThrow(
  env: Env,
  taskId: string,
  options: TerminalTaskCleanupOrThrowOptions
): Promise<void> {
  try {
    await cleanupTerminalTaskResources(env, taskId, options);
  } catch (err) {
    log.error(options.failureLogEvent, {
      taskId,
      projectId: options.projectId,
      status: options.status,
      error: String(err),
    });
    throw err;
  }
}

// Session-state mutation (stop/fail) is intentionally project-scoped — any
// authorized project member may mark a shared session terminal. Compute
// cleanup (cleanupTaskRun) is caller-scoped via options.requiredUserId so
// only the workspace owner's resources are torn down.
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
    .select({ chatSessionId: schema.workspaces.chatSessionId, userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, task.workspaceId))
    .limit(1);

  if (
    options.status === 'completed' &&
    workspace?.chatSessionId &&
    !options.destructiveSessionEnd
  ) {
    await queueWorkspaceSessionSleep(env, {
      workspaceId: task.workspaceId,
      userId: workspace.userId,
      reason: 'Task completed',
      sleepAfterMs: 0,
    });
    return;
  }

  if (workspace?.chatSessionId && options.destructiveSessionEnd) {
    await deleteSessionSnapshotState(db, env, workspace.chatSessionId);
  }

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

  await cleanupTaskRun(taskId, env, undefined, options.requiredUserId);
}
