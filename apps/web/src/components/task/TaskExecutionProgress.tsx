import { type FC, useEffect, useRef, useState } from 'react';
import { Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { getProjectTask } from '../../lib/api';
import type { TaskStatus } from '@simple-agent-manager/shared';

/** Poll interval for task status updates (ms). */
const TASK_STATUS_POLL_INTERVAL_MS = 2000;

export interface TaskExecutionProgressProps {
  projectId: string;
  taskId: string;
  /** Called when task reaches in_progress with a chat session available */
  onSessionReady?: (taskId: string, workspaceId: string) => void;
  /** Called when task reaches a terminal state */
  onTerminal?: (taskId: string, status: TaskStatus, errorMessage: string | null) => void;
  /** Called to dismiss the progress bar */
  onDismiss?: () => void;
}

interface StepInfo {
  label: string;
  description: string;
  badge: 'creating' | 'running' | 'stopped' | 'error';
}

const STATUS_STEPS: Record<string, StepInfo> = {
  draft: { label: 'Preparing', description: 'Preparing task...', badge: 'creating' },
  ready: { label: 'Ready', description: 'Task queued for execution...', badge: 'creating' },
  queued: { label: 'Provisioning', description: 'Provisioning infrastructure...', badge: 'creating' },
  delegated: { label: 'Setting Up', description: 'Creating workspace and starting agent...', badge: 'creating' },
  in_progress: { label: 'Running', description: 'Agent is working on the task', badge: 'running' },
  completed: { label: 'Completed', description: 'Task completed successfully', badge: 'stopped' },
  failed: { label: 'Failed', description: 'Task execution failed', badge: 'error' },
  cancelled: { label: 'Cancelled', description: 'Task was cancelled', badge: 'stopped' },
};

const STEP_ORDER: TaskStatus[] = ['queued', 'delegated', 'in_progress', 'completed'];

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export const TaskExecutionProgress: FC<TaskExecutionProgressProps> = ({
  projectId,
  taskId,
  onSessionReady,
  onTerminal,
  onDismiss,
}) => {
  const [status, setStatus] = useState<TaskStatus>('queued');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef(Date.now());
  const notifiedInProgressRef = useRef(false);
  const notifiedTerminalRef = useRef(false);

  // Poll task status
  useEffect(() => {
    if (isTerminal(status)) return;

    const poll = async () => {
      try {
        const task = await getProjectTask(projectId, taskId);
        setStatus(task.status);
        setErrorMessage(task.errorMessage ?? null);

        if (task.status === 'in_progress' && task.workspaceId && !notifiedInProgressRef.current) {
          notifiedInProgressRef.current = true;
          onSessionReady?.(taskId, task.workspaceId);
        }

        if (isTerminal(task.status) && !notifiedTerminalRef.current) {
          notifiedTerminalRef.current = true;
          onTerminal?.(taskId, task.status, task.errorMessage ?? null);
        }
      } catch {
        // Silently continue polling on transient errors
      }
    };

    void poll(); // Immediate first poll
    const interval = setInterval(() => void poll(), TASK_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [projectId, taskId, status, onSessionReady, onTerminal]);

  // Elapsed time counter
  useEffect(() => {
    if (isTerminal(status)) return;
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  const stepInfo = STATUS_STEPS[status] ?? STATUS_STEPS.queued!;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const elapsedDisplay = elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${elapsedSec}s`;

  // Compute step progress
  const currentStepIndex = STEP_ORDER.indexOf(status);
  const progressPercent = isTerminal(status)
    ? 100
    : currentStepIndex >= 0
      ? Math.min(((currentStepIndex + 1) / STEP_ORDER.length) * 100, 95)
      : 10;

  return (
    <div style={{
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      backgroundColor: status === 'failed'
        ? 'var(--sam-color-danger-tint)'
        : status === 'completed'
          ? 'var(--sam-color-success-tint)'
          : 'var(--sam-color-info-tint)',
      borderBottom: '1px solid var(--sam-color-border-default)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sam-space-3)',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          {!isTerminal(status) && <Spinner size="sm" />}
          <StatusBadge status={stepInfo.badge} label={stepInfo.label} />
          <span className="sam-type-secondary" style={{ color: 'var(--sam-color-fg-primary)' }}>
            {stepInfo.description}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)' }}>
            {elapsedDisplay}
          </span>
          {isTerminal(status) && onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--sam-color-fg-muted)',
                fontSize: 'var(--sam-type-caption-size)',
                padding: '2px 6px',
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        marginTop: 'var(--sam-space-2)',
        height: '3px',
        backgroundColor: 'var(--sam-color-border-default)',
        borderRadius: '2px',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${progressPercent}%`,
          backgroundColor: status === 'failed'
            ? 'var(--sam-color-danger)'
            : status === 'completed'
              ? 'var(--sam-color-success)'
              : 'var(--sam-color-info)',
          borderRadius: '2px',
          transition: 'width 0.5s ease-in-out',
        }} />
      </div>

      {/* Error message */}
      {errorMessage && (
        <div style={{
          marginTop: 'var(--sam-space-2)',
          fontSize: 'var(--sam-type-caption-size)',
          color: 'var(--sam-color-danger)',
        }}>
          {errorMessage}
        </div>
      )}
    </div>
  );
};
