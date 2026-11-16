import { log } from '../../lib/logger';
import { storeLifecyclePhaseTimings } from '../../services/lifecycle-timings';
import type { TaskRunnerState } from './types';

/**
 * Log and store the time spent in the current runner step: one row, one D1 round trip, never
 * throws. Wall-clock phase time includes queued alarms/polls; no per-poll telemetry writes.
 */
export async function recordRunnerPhase(
  db: D1Database,
  state: TaskRunnerState,
  outcome: 'success' | 'error'
): Promise<void> {
  const operation = state.config.resumeSnapshotChatSessionId ? 'wake' : 'start';
  const durationMs = Math.max(0, Date.now() - state.lastStepAt);
  log.info('session_lifecycle.runner_phase', {
    taskId: state.taskId,
    workspaceId: state.stepResults.workspaceId,
    attemptId: state.config.recoveryAttemptId ?? null,
    operation,
    phase: state.currentStep,
    durationMs,
    outcome,
  });
  await storeLifecyclePhaseTimings(db, {
    operation: operation === 'wake' ? 'runner_wake' : 'runner_start',
    outcome,
    phases: [{ phase: state.currentStep, durationMs }],
    identity: {
      projectId: state.projectId,
      workspaceId: state.stepResults.workspaceId,
      nodeId: state.stepResults.nodeId,
      chatSessionId: state.stepResults.chatSessionId,
      taskId: state.taskId,
    },
  });
}
