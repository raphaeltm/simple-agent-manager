import { type FC } from 'react';
import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { EXECUTION_STEP_LABELS } from '@simple-agent-manager/shared';
import { Spinner, StatusBadge } from '@simple-agent-manager/ui';

export interface TaskKanbanCardProps {
  task: Task;
  onClick: (task: Task) => void;
}

/** Transient statuses shown as overlay badges on cards */
const TRANSIENT_STATUSES: TaskStatus[] = ['queued', 'delegated'];

export const TaskKanbanCard: FC<TaskKanbanCardProps> = ({ task, onClick }) => {
  const isTransient = TRANSIENT_STATUSES.includes(task.status);
  const isActive = task.status === 'in_progress';
  const hasWorkspace = !!task.workspaceId;

  return (
    <>
      <style>{`
        .kanban-card:hover {
          border-color: var(--sam-color-accent-primary);
          background-color: var(--sam-color-bg-surface-hover);
        }
      `}</style>
      <button
        type="button"
        className="kanban-card"
        onClick={() => onClick(task)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: 'var(--sam-space-2) var(--sam-space-3)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
          cursor: 'pointer',
          transition: 'border-color 0.15s, background-color 0.15s',
        }}
      >
        {/* Title */}
        <div style={{
          fontSize: 'var(--sam-type-secondary-size)',
          fontWeight: 500,
          color: 'var(--sam-color-fg-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: '4px',
        }}>
          {task.title}
        </div>

        {/* Status row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-2)',
          flexWrap: 'wrap',
        }}>
          <StatusBadge status={task.status} />

          {isTransient && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: 'var(--sam-type-caption-size)',
              color: 'var(--sam-color-fg-muted)',
            }}>
              <Spinner size="sm" />
              {task.executionStep
                ? EXECUTION_STEP_LABELS[task.executionStep]
                : task.status}
            </span>
          )}

          {isActive && hasWorkspace && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: 'var(--sam-type-caption-size)',
              color: 'var(--sam-color-success)',
            }}>
              <Spinner size="sm" />
              {task.executionStep && task.executionStep !== 'running'
                ? EXECUTION_STEP_LABELS[task.executionStep]
                : 'Running'}
            </span>
          )}

          {task.priority > 0 && (
            <span style={{
              fontSize: 'var(--sam-type-caption-size)',
              color: 'var(--sam-color-fg-muted)',
            }}>
              P{task.priority}
            </span>
          )}
        </div>
      </button>
    </>
  );
};
