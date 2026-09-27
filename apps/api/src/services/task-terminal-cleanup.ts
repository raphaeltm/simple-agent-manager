import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  preserveFailedTaskWork,
  surfaceFailedTaskWorkLoss,
  withholdsFailedTaskTeardown,
} from './failed-task-preservation';
import * as projectDataService from './project-data';
import { queueWorkspaceSessionSleep } from './session-sleep';
import { deleteSessionSnapshotState } from './session-snapshots';
import { cleanupTaskRun } from './task-runner';
import { cancelVmTaskAdmission } from './vm-admission-control';

export type TerminalTaskCleanupStatus = 'completed' | 'failed' | 'cancelled';

export interface TerminalTaskCleanupOptions {
  status: TerminalTaskCleanupStatus;
  errorMessage?: string | null;
  requiredUserId?: string;
  logContext?: Record<string, unknown>;
  /** Archive/delete intent: discard the seven-day restore state. */
  destructiveSessionEnd?: boolean;
  /** Callback paths revalidate the exact workspace immediately before each side effect. */
  beforeSideEffect?: () => Promise<unknown>;
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
//
// A `failed` task without destructive intent is preserved rather than torn down
// whenever its work can be (`failed-task-preservation.ts`): the session is NOT
// failed, because snapshot recovery can only wake a `sleeping` session.
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
      chatSessionId: schema.tasks.chatSessionId,
      errorMessage: schema.tasks.errorMessage,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  await options.beforeSideEffect?.();
  await cancelVmTaskAdmission(
    env,
    taskId,
    options.status === 'cancelled'
      ? 'cancelled'
      : options.status === 'failed'
        ? 'task_failed'
        : 'task_completed_cleanup'
  ).catch((err) => {
    log.warn('task.terminal_cleanup.admission_cancel_failed', {
      taskId,
      status: options.status,
      error: err instanceof Error ? err.message : String(err),
      ...options.logContext,
    });
  });

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
    await options.beforeSideEffect?.();
    await queueWorkspaceSessionSleep(env, {
      workspaceId: task.workspaceId,
      userId: workspace.userId,
      reason: 'Task completed',
      sleepAfterMs: 0,
    });
    return;
  }

  if (options.status === 'failed' && !options.destructiveSessionEnd) {
    await options.beforeSideEffect?.();
    const source =
      typeof options.logContext?.source === 'string' ? options.logContext.source : null;
    const preservation = await preserveFailedTaskWork(env, {
      taskId,
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      chatSessionId: task.chatSessionId ?? workspace?.chatSessionId ?? null,
      source: source ?? 'task.terminal_cleanup',
    });
    if (withholdsFailedTaskTeardown(preservation)) return;
    await options.beforeSideEffect?.();
    await surfaceFailedTaskWorkLoss(env, {
      taskId,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId ?? workspace?.chatSessionId ?? null,
      reason: preservation.gap,
      source: source ?? 'task.terminal_cleanup',
    });
  }

  if (workspace?.chatSessionId && options.destructiveSessionEnd) {
    await options.beforeSideEffect?.();
    await deleteSessionSnapshotState(db, env, workspace.chatSessionId);
  }

  if (workspace?.chatSessionId) {
    try {
      await options.beforeSideEffect?.();
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

  await options.beforeSideEffect?.();
  await cleanupTaskRun(taskId, env, undefined, options.requiredUserId);
}
