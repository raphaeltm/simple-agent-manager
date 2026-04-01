import type { DashboardTask } from '@simple-agent-manager/shared';
import { EXECUTION_STEP_LABELS } from '@simple-agent-manager/shared';
import { Card, StatusBadge } from '@simple-agent-manager/ui';
import { useNavigate } from 'react-router-dom';

interface ActiveTaskCardProps {
  task: DashboardTask;
}

function formatRelativeTime(timestamp: string | number | null): string {
  if (timestamp == null) return 'N/A';
  const ms = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getStepLabel(task: DashboardTask): string | null {
  if (task.executionStep && task.executionStep !== 'running') {
    return EXECUTION_STEP_LABELS[task.executionStep];
  }
  return null;
}

export function ActiveTaskCard({ task }: ActiveTaskCardProps) {
  const navigate = useNavigate();

  const chatPath = task.sessionId
    ? `/projects/${task.projectId}/chat/${task.sessionId}`
    : `/projects/${task.projectId}/chat`;

  const stepLabel = getStepLabel(task);

  return (
    <div
      onClick={() => navigate(chatPath)}
      className="cursor-pointer rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]"
      role="button"
      aria-label={`Open task: ${task.title}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(chatPath);
        }
      }}
    >
      <Card className="py-3 px-[clamp(var(--sam-space-3),3vw,var(--sam-space-4))] hover:border-border-default transition-colors">
        {/* Top row: status + activity indicator */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <StatusBadge status={task.status} />
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${task.isActive ? 'bg-success-fg' : 'bg-fg-muted'}`}
            />
            <span className="sam-type-caption text-fg-muted">
              {task.isActive ? 'Active' : 'Idle'}
            </span>
          </div>
        </div>

        {/* Task title */}
        <div className="sam-type-card-title text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap mb-1">
          {task.title}
        </div>

        {/* Project name */}
        <div className="sam-type-caption text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap mb-2">
          {task.projectName}
        </div>

        {/* Execution step (if provisioning) */}
        {stepLabel && (
          <div className="sam-type-caption text-info-fg mb-2 overflow-hidden text-ellipsis whitespace-nowrap">
            {stepLabel}
          </div>
        )}

        {/* Time info */}
        <div className="flex items-center justify-between sam-type-caption text-fg-muted gap-2">
          <span className="min-w-0 truncate">Submitted {formatRelativeTime(task.createdAt)}</span>
          <span className="flex-shrink-0">
            {task.lastMessageAt
              ? `Last msg ${formatRelativeTime(task.lastMessageAt)}`
              : 'No messages'}
          </span>
        </div>
      </Card>
    </div>
  );
}
