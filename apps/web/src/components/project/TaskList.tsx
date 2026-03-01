import { Link } from 'react-router-dom';
import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { Button, EmptyState, Spinner, StatusBadge } from '@simple-agent-manager/ui';

interface TaskListProps {
  tasks: Task[];
  projectId: string;
  loading?: boolean;
  onDeleteTask: (task: Task) => void;
  onTransitionTask: (task: Task, toStatus: TaskStatus) => void;
  onDelegateTask: (task: Task) => void;
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['queued', 'delegated', 'cancelled'],
  queued: ['delegated', 'failed', 'cancelled'],
  delegated: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['ready', 'cancelled'],
  cancelled: ['ready'],
};

function toLabel(status: TaskStatus): string {
  return status.replace('_', ' ');
}

export function TaskList({
  tasks,
  projectId,
  loading = false,
  onDeleteTask,
  onTransitionTask,
  onDelegateTask,
}: TaskListProps) {
  if (loading && tasks.length === 0) {
    return (
      <div className="p-4 border border-border-default rounded-md bg-surface flex items-center gap-2">
        <Spinner size="sm" />
        <span className="text-fg-muted">Loading tasks...</span>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        heading="No tasks yet"
        description="Create a task to start planning and delegating work."
      />
    );
  }

  return (
    <div className="grid gap-2">
      {tasks.map((task) => {
        const options = TRANSITIONS[task.status] ?? [];

        return (
          <article
            key={task.id}
            className="border border-border-default rounded-md bg-surface p-3 grid gap-2"
          >
            {/* Row 1: status + title + priority + blocked */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={task.status} />
              <Link
                to={`/projects/${projectId}/tasks/${task.id}`}
                className="flex-1 min-w-0 text-fg-primary font-semibold no-underline text-base overflow-hidden text-ellipsis whitespace-nowrap"
              >
                {task.title}
              </Link>
              <span className="text-xs text-fg-muted shrink-0">
                P{task.priority}
              </span>
              {task.blocked && (
                <span className="text-xs py-0.5 px-2 rounded-full bg-danger-tint text-danger-fg font-semibold shrink-0">
                  Blocked
                </span>
              )}
            </div>

            {/* Row 2: quick actions */}
            <div className="flex items-center gap-2 flex-wrap">
              {options.length > 0 && (
                <select
                  aria-label={`Transition ${task.title}`}
                  defaultValue=""
                  onChange={(event) => {
                    const value = event.currentTarget.value as TaskStatus;
                    if (value) {
                      onTransitionTask(task, value);
                      event.currentTarget.value = '';
                    }
                  }}
                  className="rounded-md border border-border-default bg-surface text-fg-primary text-xs min-h-8 py-1 px-2"
                >
                  <option value="">Move to...</option>
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {toLabel(option)}
                    </option>
                  ))}
                </select>
              )}
              <Button size="sm" variant="secondary" onClick={() => onDelegateTask(task)}>
                Delegate
              </Button>
              <Button size="sm" variant="danger" onClick={() => onDeleteTask(task)}>
                Delete
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
