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
  if (loading) {
    return (
      <div style={{
        padding: 'var(--sam-space-4)',
        border: '1px solid var(--sam-color-border-default)',
        borderRadius: 'var(--sam-radius-md)',
        background: 'var(--sam-color-bg-surface)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sam-space-2)',
      }}>
        <Spinner size="sm" />
        <span style={{ color: 'var(--sam-color-fg-muted)' }}>Loading tasks…</span>
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
    <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
      {tasks.map((task) => {
        const options = TRANSITIONS[task.status] ?? [];

        return (
          <article
            key={task.id}
            style={{
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
              background: 'var(--sam-color-bg-surface)',
              padding: 'var(--sam-space-3)',
              display: 'grid',
              gap: 'var(--sam-space-2)',
            }}
          >
            {/* Row 1: status + title + priority + blocked */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
              <StatusBadge status={task.status} />
              <Link
                to={`/projects/${projectId}/tasks/${task.id}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: 'var(--sam-color-fg-primary)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  fontSize: 'var(--sam-type-body-size)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {task.title}
              </Link>
              <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}>
                P{task.priority}
              </span>
              {task.blocked && (
                <span style={{
                  fontSize: 'var(--sam-type-caption-size)',
                  padding: '2px 7px',
                  borderRadius: '9999px',
                  background: 'rgba(239,68,68,0.15)',
                  color: '#f87171',
                  fontWeight: 600,
                  flexShrink: 0,
                }}>
                  Blocked
                </span>
              )}
            </div>

            {/* Row 2: quick actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
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
                  style={{
                    borderRadius: 'var(--sam-radius-md)',
                    border: '1px solid var(--sam-color-border-default)',
                    background: 'var(--sam-color-bg-surface)',
                    color: 'var(--sam-color-fg-primary)',
                    fontSize: 'var(--sam-type-caption-size)',
                    minHeight: '2rem',
                    padding: '0.25rem 0.5rem',
                  }}
                >
                  <option value="">Move to…</option>
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
