import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { Button, StatusBadge } from '@simple-agent-manager/ui';

interface TaskListProps {
  tasks: Task[];
  loading?: boolean;
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onTransitionTask: (task: Task, toStatus: TaskStatus) => void;
  onManageDependencies: (task: Task) => void;
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
  loading = false,
  selectedTaskId,
  onSelectTask,
  onEditTask,
  onDeleteTask,
  onTransitionTask,
  onManageDependencies,
  onDelegateTask,
}: TaskListProps) {
  if (loading) {
    return (
      <div
        style={{
          padding: 'var(--sam-space-4)',
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
          background: 'var(--sam-color-bg-surface)',
        }}
      >
        Loading tasks...
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div
        style={{
          padding: 'var(--sam-space-4)',
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
          background: 'var(--sam-color-bg-surface)',
          color: 'var(--sam-color-fg-muted)',
        }}
      >
        No tasks in this project yet.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
      {tasks.map((task) => {
        const options = TRANSITIONS[task.status] ?? [];
        const selected = selectedTaskId === task.id;

        return (
          <article
            key={task.id}
            style={{
              border: selected
                ? '1px solid var(--sam-color-accent-primary)'
                : '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
              background: 'var(--sam-color-bg-surface)',
              padding: 'var(--sam-space-3)',
              display: 'grid',
              gap: 'var(--sam-space-3)',
            }}
          >
            <button
              onClick={() => onSelectTask(task.id)}
              style={{
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'grid',
                gap: 'var(--sam-space-2)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <strong style={{ color: 'var(--sam-color-fg-primary)' }}>{task.title}</strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                  <StatusBadge status={task.status} />
                  {task.blocked && (
                    <span style={{ color: 'var(--sam-color-danger)', fontSize: '0.75rem' }}>
                      Blocked
                    </span>
                  )}
                </div>
              </div>
              {task.description && (
                <p style={{ margin: 0, color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
                  {task.description}
                </p>
              )}
              <div style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>
                Priority {task.priority}
              </div>
            </button>

            <div style={{ display: 'grid', gap: 'var(--sam-space-2)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
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
                style={{
                  borderRadius: 'var(--sam-radius-md)',
                  border: '1px solid var(--sam-color-border-default)',
                  background: 'var(--sam-color-bg-surface)',
                  color: 'var(--sam-color-fg-primary)',
                  minHeight: '2.5rem',
                  padding: '0.5rem 0.625rem',
                }}
              >
                <option value="">Change status...</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {toLabel(option)}
                  </option>
                ))}
              </select>

              <Button variant="secondary" onClick={() => onEditTask(task)}>
                Edit
              </Button>
              <Button variant="secondary" onClick={() => onManageDependencies(task)}>
                Dependencies
              </Button>
              <Button variant="secondary" onClick={() => onDelegateTask(task)}>
                Delegate
              </Button>
              <Button variant="danger" onClick={() => onDeleteTask(task)}>
                Delete
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
