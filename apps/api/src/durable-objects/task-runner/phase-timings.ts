import { log } from '../../lib/logger';
import type { TaskRunnerState } from './types';

/** Wall-clock phase time includes queued alarms/polls; no per-poll telemetry writes. */
export function recordRunnerPhase(state: TaskRunnerState, outcome: 'success' | 'error'): void {
  log.info('session_lifecycle.runner_phase', {
    taskId: state.taskId,
    workspaceId: state.stepResults.workspaceId,
    attemptId: state.config.recoveryAttemptId ?? null,
    operation: state.config.resumeSnapshotChatSessionId ? 'wake' : 'start',
    phase: state.currentStep,
    durationMs: Math.max(0, Date.now() - state.lastStepAt),
    outcome,
  });
}
