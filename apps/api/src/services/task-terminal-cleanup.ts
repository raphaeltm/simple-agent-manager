import { and, eq } from 'drizzle-orm';
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
  requiredUserId?: string;
  projectId?: string;
  logContext?: Record<string, unknown>;
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
  const taskConditions = [eq(schema.tasks.id, taskId)];
  if (options.projectId) {
    taskConditions.push(eq(schema.tasks.projectId, options.projectId));
  }

  const [task] = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      chatSessionId: schema.tasks.chatSessionId,
      workspaceId: schema.tasks.workspaceId,
      errorMessage: schema.tasks.errorMessage,
    })
    .from(schema.tasks)
    .where(and(...taskConditions))
    .limit(1);

  if (
    !task ||
    (options.projectId && task.projectId !== options.projectId) ||
    !task.workspaceId ||
    !task.projectId
  ) {
    return;
  }

  const workspaceConditions = [
    eq(schema.workspaces.id, task.workspaceId),
    eq(schema.workspaces.projectId, task.projectId),
  ];
  if (options.requiredUserId) {
    workspaceConditions.push(eq(schema.workspaces.userId, options.requiredUserId));
  }

  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      projectId: schema.workspaces.projectId,
      userId: schema.workspaces.userId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .where(and(...workspaceConditions))
    .limit(1);

  if (
    !workspace ||
    workspace.id !== task.workspaceId ||
    workspace.projectId !== task.projectId ||
    (options.requiredUserId && workspace.userId !== options.requiredUserId) ||
    (workspace.chatSessionId !== null && workspace.chatSessionId !== task.chatSessionId)
  ) {
    log.info('task.terminal_cleanup.workspace_scope_rejected', {
      taskId,
      taskProjectId: task.projectId,
      workspaceId: task.workspaceId,
      taskSessionId: task.chatSessionId,
      workspaceSessionId: workspace?.chatSessionId ?? null,
      requiredProjectId: options.projectId ?? null,
      requiredUserId: options.requiredUserId ?? null,
      action: 'skipped',
      ...options.logContext,
    });
    return;
  }

  if (workspace.chatSessionId) {
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

  await cleanupTaskRun(
    taskId,
    env,
    undefined,
    options.requiredUserId,
    options.projectId ?? task.projectId
  );
}
