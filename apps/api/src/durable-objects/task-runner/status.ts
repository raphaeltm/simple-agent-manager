import type { TaskRunnerState } from './types';

export function redactTaskRunnerStatus(state: TaskRunnerState | null): TaskRunnerState | null {
  if (state?.stepResults.mcpToken) {
    return { ...state, stepResults: { ...state.stepResults, mcpToken: '[redacted]' } };
  }

  return state;
}
