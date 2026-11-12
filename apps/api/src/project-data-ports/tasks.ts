import type { TaskLifecyclePort } from '../durable-objects/project-data/ports';
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
    const preservation = await import('../services/failed-task-preservation');
    const { agentUnresponsive, ...target } = input;
    const outcome = agentUnresponsive
      ? ({ outcome: 'not_preservable', gap: 'agent_unresponsive' } as const)
      : await preservation.preserveFailedTaskWork(workerEnv(env), target);
    if (preservation.withholdsFailedTaskTeardown(outcome)) {
      return { preserved: true, outcome: outcome.outcome };
    }
    await preservation.surfaceFailedTaskWorkLoss(workerEnv(env), {
      taskId: input.taskId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      reason: outcome.gap,
      source: input.source,
    });
    return { preserved: false };
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
