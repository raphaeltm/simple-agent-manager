import type { TaskLifecyclePort } from '@simple-agent-manager/project-data';

import { submitReservedTask } from '../services/reserved-task-submission';
import { WAKEABLE_TASK_STATUSES } from '../services/task-status';
import { transitionTaskToTerminal } from '../services/task-terminal-transition';
import { syncTriggerExecutionStatus } from '../services/trigger-execution-sync';
import { workerEnv } from './worker-env';

/** Task lifecycle: terminal transitions, failed-work preservation, runtime release. */
export const tasksPort: TaskLifecyclePort = {
  transitionToTerminal: (env, request) => transitionTaskToTerminal(workerEnv(env), request),
  async preserveFailedWorkOrSurfaceLoss(env, input) {
    // Lazy, as ProjectData always loaded it: only the rare attention-expiry path needs it.
    const { preserveFailedTaskWorkOrSurfaceLoss } =
      await import('../services/failed-task-work-outcome');
    return preserveFailedTaskWorkOrSurfaceLoss(workerEnv(env), input);
  },
  async releaseTaskRun(env, taskId) {
    // Lazy, as ProjectData always loaded it: the task runner is a large module graph.
    const { cleanupTaskRun } = await import('../services/task-runner');
    await cleanupTaskRun(taskId, workerEnv(env));
  },
  syncTriggerExecutionStatus: (env, taskId, status, errorMessage) =>
    syncTriggerExecutionStatus(env.DATABASE, taskId, status, errorMessage),
  submitReservedTask: (env, input) => submitReservedTask(workerEnv(env), input),
  wakeableStatuses: WAKEABLE_TASK_STATUSES,
};
