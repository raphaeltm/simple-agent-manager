import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopComputeTracking } from './compute-usage';
import { cleanupTaskRun } from './task-runner';

export async function finishSleepingWorkspaceComputeCleanup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    workspaceId: string;
    taskId: string | null;
    warmNodeTimeoutMs: number | null;
  }
): Promise<void> {
  await stopComputeTracking(db, input.workspaceId).catch((error) => {
    log.warn('session_sleep.compute_tracking_stop_failed', {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (input.taskId) {
    await cleanupTaskRun(input.taskId, env, input.warmNodeTimeoutMs).catch((error) => {
      log.warn('session_sleep.task_cleanup_failed', {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
