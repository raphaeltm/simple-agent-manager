import { useNavigate } from 'react-router-dom';
import { Card, StatusBadge } from '@simple-agent-manager/ui';
import type { DashboardRecentTask } from '@simple-agent-manager/shared';

interface RecentTaskCardProps {
  task: DashboardRecentTask;
}

function formatRelativeTime(timestamp: string | null): string {
  if (timestamp == null) return 'N/A';
  const ms = new Date(timestamp).getTime();
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

export function RecentTaskCard({ task }: RecentTaskCardProps) {
  const navigate = useNavigate();

  const chatPath = task.sessionId
    ? `/projects/${task.projectId}/chat/${task.sessionId}`
    : `/projects/${task.projectId}/chat`;

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
        {/* Top row: status badge */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <StatusBadge status={task.status} />
          {task.completedAt && (
            <span className="sam-type-caption text-fg-muted">
              {formatRelativeTime(task.completedAt)}
            </span>
          )}
        </div>

        {/* Task title */}
        <div className="sam-type-card-title text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap mb-1">
          {task.title}
        </div>

        {/* Project name */}
        <div className="sam-type-caption text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap mb-2">
          {task.projectName}
        </div>

        {/* Output info */}
        {(task.outputBranch || task.outputSummary) && (
          <div className="sam-type-caption text-fg-muted">
            {task.outputBranch && (
              <span className="font-mono overflow-hidden text-ellipsis whitespace-nowrap block">
                {task.outputBranch}
              </span>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
