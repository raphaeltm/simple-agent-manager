import type { Env } from '../env';
import { log } from '../lib/logger';
import { persistError } from '../services/observability';
import type { TaskRuntimeLiveness } from '../services/task-runtime-liveness';
import type { StuckTaskCandidate, TaskRunnerProbeResult } from './stuck-tasks';

const TASK_RUNNER_NORMAL_HANDOFF_STEP = 'running';
const TASK_RUNNER_MISMATCH_RECOVERY_TYPE = 'do_task_status_mismatch';

function isNormalCompletedTaskRunnerHandoff(
  task: StuckTaskCandidate,
  doStatus: NonNullable<TaskRunnerProbeResult['status']>
): boolean {
  return task.status === 'in_progress' && doStatus.currentStep === TASK_RUNNER_NORMAL_HANDOFF_STEP;
}

function taskRunnerMismatchKind(
  task: StuckTaskCandidate,
  doStatus: NonNullable<TaskRunnerProbeResult['status']>
): 'completed_handoff_missing_in_d1' | 'completed_before_running_handoff' {
  return doStatus.currentStep === TASK_RUNNER_NORMAL_HANDOFF_STEP && task.status !== 'in_progress'
    ? 'completed_handoff_missing_in_d1'
    : 'completed_before_running_handoff';
}

/** The scan candidate predates the DO probe: diagnose only the current D1 row. */
export async function recordTaskRunnerMismatch(
  env: Env,
  taskId: string,
  doStatus: NonNullable<TaskRunnerProbeResult['status']>,
  probeOutcome: TaskRunnerProbeResult['outcome'],
  timeForCheck: number,
  liveness: TaskRuntimeLiveness | null
): Promise<void> {
  const task = await env.DATABASE.prepare('SELECT * FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<StuckTaskCandidate>();
  if (!task || !['queued', 'delegated', 'in_progress'].includes(task.status)) return;
  if (isNormalCompletedTaskRunnerHandoff(task, doStatus)) {
    // `transitionToInProgress` deliberately stores TaskRunner
    // `completed=true` at the successful handoff boundary while the D1 task
    // remains active until an explicit agent/user terminal path. This is
    // normal lifecycle bookkeeping, not D1 drift; production evidence on
    // 2026-08-24 showed these rows were live, restorable, or live-superseded.
    log.info('stuck_task.do_completed_handoff_active', {
      taskId: task.id,
      taskStatus: task.status,
      executionStep: task.execution_step,
      doCurrentStep: doStatus.currentStep,
      doRetryCount: doStatus.retryCount,
      livenessReason: liveness?.reason ?? null,
      action: 'observed_normal_handoff',
    });
  } else {
    const mismatchKind = taskRunnerMismatchKind(task, doStatus);
    log.warn('stuck_task.do_completed_active_state_mismatch', {
      taskId: task.id,
      taskStatus: task.status,
      executionStep: task.execution_step,
      doCurrentStep: doStatus.currentStep,
      doRetryCount: doStatus.retryCount,
      mismatchKind,
    });

    // One durable diagnostic per task is enough. Repeating the same
    // preserved candidate every 30 minutes caused the production noise that
    // hid the real state: normal handoff and resumable/superseded sessions.
    const existingMismatch = await env.OBSERVABILITY_DATABASE.prepare(
      `SELECT id FROM platform_errors
         WHERE task_id = ? AND context LIKE ?
         LIMIT 1`
    )
      .bind(task.id, `%${TASK_RUNNER_MISMATCH_RECOVERY_TYPE}%`)
      .first();

    if (!existingMismatch) {
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
          source: 'api',
          level: 'warn',
          message:
            `TaskRunner DO reports completed at '${doStatus.currentStep}' while ` +
            `task remains '${task.status}' — active state mismatch before normal handoff convergence`,
          context: {
            recoveryType: TASK_RUNNER_MISMATCH_RECOVERY_TYPE,
            mismatchKind,
            taskId: task.id,
            taskStatus: task.status,
            executionStep: task.execution_step,
            doCurrentStep: doStatus.currentStep,
            doRetryCount: doStatus.retryCount,
            timeForCheck,
            taskRunnerProbeOutcome: probeOutcome,
            livenessReason: liveness?.reason ?? null,
          },
          userId: task.user_id,
          taskId: task.id,
          sessionId: task.chat_session_id,
        },
        env
      );
    }
  }
}
