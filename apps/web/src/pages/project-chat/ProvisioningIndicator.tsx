import type { TaskExecutionStep } from '@simple-agent-manager/shared';
import { EXECUTION_STEP_LABELS } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { Ban, Check, Server, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  NOTICE_ACTION_CLASS,
  NoticeMeta,
  NoticeSlab,
} from '../../components/chat-notices/NoticeSlab';
import { StageTrack } from '../../components/chat-notices/StageTrack';
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
  className?: string;
}

const PROVISIONING_STAGES: ProvisioningStage[] = [
  {
    label: 'Provisioning VM',
    steps: ['node_selection', 'waiting_for_node_capacity', 'node_provisioning', 'node_agent_ready'],
  },
  { label: 'Cloning repository', steps: ['workspace_creation'] },
  { label: 'Installing dependencies', steps: ['workspace_ready', 'attachment_transfer'] },
  { label: 'Starting agent', steps: ['agent_session'] },
];

const PROVISIONING_STAGE_LABELS = PROVISIONING_STAGES.map((stage) => stage.label);

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
  return `${stageLabel} · ${stageIndex + 1} of ${PROVISIONING_STAGES.length}`;
}

/** "Setting up a new server..." → "Setting up a new server." */
function asSentence(label: string): string {
  return `${label.replace(/\.+$/, '')}.`;
}

function getDetail(state: ProvisioningState): string | null {
  if (state.errorMessage) return state.errorMessage;
  if (isTerminal(state.status)) return null;
  const detail = state.executionStep
    ? asSentence(EXECUTION_STEP_LABELS[state.executionStep])
    : 'Waiting for the task runner.';
  return `${detail} This usually takes 2–4 minutes.`;
}

function getIcon(status: ProvisioningState['status']) {
  if (status === 'failed') return <XCircle size={16} />;
  if (status === 'cancelled') return <Ban size={15} />;
  if (status === 'completed') return <Check size={15} />;
  return <Server size={15} />;
}

/** First-boot progress for a new chat, as a SAM Glass notice slab with a stage track. */
export function ProvisioningIndicator({
  state,
  bootLogCount,
  onViewLogs,
  className,
}: Readonly<ProvisioningIndicatorProps>) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isTerminal(state.status)) return;
    const interval = setInterval(() => setElapsed(Date.now() - state.startedAt), 1000);
    return () => clearInterval(interval);
  }, [state.startedAt, state.status]);

  const currentStageIndex = getStageIndex(state.executionStep);
  const isFailed = state.status === 'failed';
  const isActive = !isTerminal(state.status);
  const tone = isFailed ? 'danger' : state.status === 'cancelled' ? 'warning' : 'progress';

  return (
    <NoticeSlab
      tone={tone}
      role={isFailed ? 'alert' : undefined}
      data-testid="provisioning-indicator"
      className={className}
      icon={getIcon(state.status)}
      title={getStatusLabel(state)}
      meta={
        <>
          {state.branchName && isActive && (
            <span className="hidden min-w-0 max-w-[22rem] sm:inline-flex">
              <NoticeMeta>{state.branchName}</NoticeMeta>
            </span>
          )}
          <NoticeMeta>{getElapsedDisplay(elapsed)}</NoticeMeta>
        </>
      }
      detail={getDetail(state)}
      inlineActions
      actions={
        bootLogCount > 0 ? (
          <Button variant="raised" size="sm" className={NOTICE_ACTION_CLASS} onClick={onViewLogs}>
            View logs
          </Button>
        ) : undefined
      }
    >
      {(isActive || isFailed) && (
        <StageTrack
          stages={PROVISIONING_STAGE_LABELS}
          current={currentStageIndex}
          failed={isFailed}
        />
      )}
    </NoticeSlab>
  );
}
