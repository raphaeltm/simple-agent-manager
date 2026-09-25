import type { Env } from '../env';
import { cleanupTaskRun } from './task-runner';
import { cleanupTerminalTaskResourcesOrThrow } from './task-terminal-cleanup';

/**
 * Explicit, caller-requested cleanup of a terminal task run
 * (`POST /projects/:projectId/tasks/:taskId/run/cleanup`).
 *
 * A failed run goes through the same preservation-first terminal cleanup as the
 * automatic failure paths (`failed-task-preservation.ts`): an API caller cleaning
 * up a failed run must not destroy work SAM would otherwise snapshot. Its runtime
 * is still torn down — by the sleep, right after the snapshot — or immediately,
 * with a notice in the chat, when the work cannot be preserved. Completed and
 * cancelled runs keep the direct teardown.
 */
export async function cleanupRequestedTaskRun(
  env: Env,
  task: { id: string; status: string },
  projectId: string,
  requiredUserId: string
): Promise<void> {
  if (task.status === 'failed') {
    await cleanupTerminalTaskResourcesOrThrow(env, task.id, {
      status: 'failed',
      requiredUserId,
      projectId,
      failureLogEvent: 'task.run_cleanup.failed',
      logContext: { projectId, source: 'tasks.run_cleanup' },
    });
    return;
  }
  await cleanupTaskRun(task.id, env, undefined, requiredUserId);
}
