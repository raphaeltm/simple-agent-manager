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
    <button
      type="button"
      onClick={() => onClick(task)}
      className="block w-full text-left py-2 px-3 bg-surface border border-border-default rounded-md cursor-pointer transition-[border-color,background-color] duration-150 hover:border-accent hover:bg-surface-hover"
    >
      {/* Title */}
      <div className="text-sm font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap mb-1">
        {task.title}
      </div>

      {/* Status row */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={task.status} />

        {isTransient && (
          <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
            <Spinner size="sm" />
            {task.executionStep
              ? EXECUTION_STEP_LABELS[task.executionStep]
              : task.status}
          </span>
        )}

        {isActive && hasWorkspace && (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Spinner size="sm" />
            {task.executionStep && task.executionStep !== 'running'
              ? EXECUTION_STEP_LABELS[task.executionStep]
              : 'Running'}
          </span>
        )}

        {task.priority > 0 && (
          <span className="text-xs text-fg-muted">
            P{task.priority}
          </span>
        )}
      </div>
    </button>
  );
};
