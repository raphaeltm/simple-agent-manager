import type { TaskExecutionStep } from '@simple-agent-manager/shared';
import { EXECUTION_STEP_LABELS, EXECUTION_STEP_ORDER } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import type { ProvisioningState } from './types';
import { isTerminal } from './types';

interface ProvisioningStage {
  label: string;
  steps: TaskExecutionStep[];
}

interface ProvisioningIndicatorProps {
  state: ProvisioningState;
  bootLogCount: number;
  onViewLogs: () => void;
}

const PROVISIONING_STAGES: ProvisioningStage[] = [
  { label: 'Provisioning VM', steps: ['node_selection', 'node_provisioning', 'node_agent_ready'] },
  { label: 'Cloning repository', steps: ['workspace_creation'] },
  { label: 'Installing dependencies', steps: ['workspace_ready', 'attachment_transfer'] },
  { label: 'Starting agent', steps: ['agent_session'] },
];

function getStageIndex(step: TaskExecutionStep | null): number {
  if (!step) return 0;
  if (step === 'running' || step === 'awaiting_followup') return PROVISIONING_STAGES.length - 1;
  const index = PROVISIONING_STAGES.findIndex((stage) => stage.steps.includes(step));
  return Math.max(index, 0);
}

function getElapsedDisplay(elapsed: number): string {
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function getStatusLabel(state: ProvisioningState): string {
  if (state.status === 'failed') return 'Setup failed';
  if (state.status === 'cancelled') return 'Cancelled';
  if (!state.executionStep) return 'Starting...';

  const stageIndex = getStageIndex(state.executionStep);
  const stageLabel =
    PROVISIONING_STAGES[stageIndex]?.label ?? EXECUTION_STEP_LABELS[state.executionStep];
  return `${stageLabel} (${stageIndex + 1}/${PROVISIONING_STAGES.length})`;
}

function getStageColor(isComplete: boolean, isCurrent: boolean, hasStarted: boolean): string {
  if (isComplete) return 'var(--sam-color-success)';
  if (isCurrent || hasStarted) return 'var(--sam-color-accent-primary)';
  return 'var(--sam-color-border-default)';
}

export function ProvisioningIndicator({
  state,
  bootLogCount,
  onViewLogs,
}: Readonly<ProvisioningIndicatorProps>) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const currentStepOrder = state.executionStep ? EXECUTION_STEP_ORDER[state.executionStep] : -1;
  const currentStageIndex = getStageIndex(state.executionStep);
  const isFailed = state.status === 'failed';

  return (
    <div
      className={`shrink-0 px-4 py-3 border-b ${isFailed ? 'bg-danger-tint border-[rgba(239,68,68,0.12)]' : 'bg-[rgba(22,163,74,0.06)] border-[rgba(34,197,94,0.1)]'}`}
    >
      <div className="flex items-center gap-2 mb-2">
        {!isTerminal(state.status) && <Spinner size="sm" />}
        <span
          className={`sam-type-secondary font-medium ${isFailed ? 'text-danger' : 'text-fg-primary'}`}
        >
          {getStatusLabel(state)}
        </span>
        {state.branchName && !isTerminal(state.status) && (
          <span className="sam-type-caption text-fg-muted">{state.branchName}</span>
        )}
        <span className="sam-type-caption text-fg-muted ml-auto">{getElapsedDisplay(elapsed)}</span>
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
        <div className="sam-type-caption text-fg-muted mb-2">
          Usually takes 2-4 minutes. Current detail:{' '}
          {state.executionStep
            ? EXECUTION_STEP_LABELS[state.executionStep]
            : 'Waiting for task runner...'}
        </div>
      )}

      {!isTerminal(state.status) && (
        <div className="grid grid-cols-4 gap-1">
          {PROVISIONING_STAGES.map((stage, index) => {
            const isComplete = index < currentStageIndex;
            const isCurrent = index === currentStageIndex;
            const hasStarted = stage.steps.some(
              (step) => EXECUTION_STEP_ORDER[step] <= currentStepOrder
            );
            return (
              <div key={stage.label} className="min-w-0">
                <div
                  title={stage.label}
                  className="h-[3px] rounded-sm transition-colors duration-300"
                  style={{
                    backgroundColor: getStageColor(isComplete, isCurrent, hasStarted),
                  }}
                />
                <div
                  className={`mt-1 text-[10px] leading-tight truncate ${isCurrent ? 'text-fg-primary' : 'text-fg-muted'}`}
                >
                  {index + 1}. {stage.label}
                </div>
              </div>
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
