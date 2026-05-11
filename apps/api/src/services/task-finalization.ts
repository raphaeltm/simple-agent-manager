import type { TaskStatus } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { cleanupTaskRun } from './task-runner';

export interface FinalizeTaskRunInput {
  taskId: string;
  projectId: string;
  status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>;
  taskMode?: string | null;
  cleanupWorkspace?: boolean;
  warmTimeoutOverrideMs?: number | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function finalizeTaskRun(env: Env, input: FinalizeTaskRunInput): Promise<void> {
  await stopTaskSessions(env, input.projectId, input.taskId);

  if (input.cleanupWorkspace && input.status === 'completed') {
    const cleanup = cleanupTaskWorkspace(env, input.taskId, input.warmTimeoutOverrideMs);
    if (input.waitUntil) {
      input.waitUntil(cleanup);
    } else {
      await cleanup;
    }
  }
}

async function cleanupTaskWorkspace(
  env: Env,
  taskId: string,
  warmTimeoutOverrideMs?: number | null,
): Promise<void> {
  try {
    await cleanupTaskRun(taskId, env, warmTimeoutOverrideMs);
  } catch (err) {
    log.error('task_finalization.workspace_cleanup_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function stopTaskSessions(env: Env, projectId: string, taskId: string): Promise<void> {
  try {
    const result = await projectDataService.stopActiveSessionsForTask(env, projectId, taskId);
    if (result.stopped > 0) {
      log.info('task_finalization.sessions_stopped', {
        projectId,
        taskId,
        stopped: result.stopped,
        sessionIds: result.sessionIds,
      });
    }
  } catch (err) {
    log.error('task_finalization.sessions_stop_failed', {
      projectId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
