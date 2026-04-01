import type { TaskExecutionStep } from '@simple-agent-manager/shared';
import {
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  TASK_EXECUTION_STEPS,
} from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import type { ProvisioningState } from './types';
import { isTerminal } from './types';

const PROVISIONING_STEPS: TaskExecutionStep[] = TASK_EXECUTION_STEPS.filter(
  (s) => s !== 'running' && s !== 'awaiting_followup'
);

export function ProvisioningIndicator({ state, bootLogCount, onViewLogs }: { state: ProvisioningState; bootLogCount: number; onViewLogs: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const seconds = Math.floor(elapsed / 1000);
  const elapsedDisplay = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  const statusLabel = state.status === 'failed' ? 'Setup failed'
    : state.status === 'cancelled' ? 'Cancelled'
    : state.executionStep ? EXECUTION_STEP_LABELS[state.executionStep]
    : 'Starting...';

  const currentStepOrder = state.executionStep ? EXECUTION_STEP_ORDER[state.executionStep] : -1;
  const isFailed = state.status === 'failed';

  return (
    <div className={`shrink-0 px-4 py-3 border-b border-border-default ${isFailed ? 'bg-danger-tint' : 'bg-info-tint'}`}>
      <div className="flex items-center gap-2 mb-2">
        {!isTerminal(state.status) && <Spinner size="sm" />}
        <span className={`sam-type-secondary font-medium ${isFailed ? 'text-danger' : 'text-fg-primary'}`}>
          {statusLabel}
        </span>
        {state.branchName && !isTerminal(state.status) && (
          <span className="sam-type-caption text-fg-muted">{state.branchName}</span>
        )}
        <span className="sam-type-caption text-fg-muted ml-auto">{elapsedDisplay}</span>
        {bootLogCount > 0 && (
          <button
            type="button"
            onClick={onViewLogs}
            className="sam-type-caption text-accent-primary hover:underline bg-transparent border-none cursor-pointer px-2 min-h-[44px] flex items-center shrink-0"
          >
            View Logs
          </button>
        )}
      </div>

      {!isTerminal(state.status) && (
        <div className="flex gap-[2px] h-[3px] rounded-sm overflow-hidden">
          {PROVISIONING_STEPS.map((step) => {
            const stepOrder = EXECUTION_STEP_ORDER[step];
            const isComplete = stepOrder < currentStepOrder;
            const isCurrent = stepOrder === currentStepOrder;
            return (
              <div
                key={step}
                title={EXECUTION_STEP_LABELS[step]}
                className="flex-1 transition-colors duration-300"
                style={{
                  backgroundColor: isComplete
                    ? 'var(--sam-color-success)'
                    : isCurrent
                    ? 'var(--sam-color-accent-primary)'
                    : 'var(--sam-color-border-default)',
                }}
              />
            );
          })}
        </div>
      )}

      {state.errorMessage && (
        <div className="sam-type-caption text-danger mt-2 p-2 px-3 bg-surface rounded-sm border border-danger-tint break-words">
          {state.errorMessage}
        </div>
      )}
    </div>
  );
}
