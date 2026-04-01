import type { ProjectSummary } from '@simple-agent-manager/shared';
import { Card, DropdownMenu, type DropdownMenuItem,StatusBadge } from '@simple-agent-manager/ui';
import { useNavigate } from 'react-router-dom';

interface ProjectSummaryCardProps {
  project: ProjectSummary;
  onDelete?: (id: string) => void;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'No activity';
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function ProjectSummaryCard({ project, onDelete }: ProjectSummaryCardProps) {
  const navigate = useNavigate();

  const overflowItems: DropdownMenuItem[] = [
    {
      id: 'edit',
      label: 'Edit',
      onClick: () => navigate(`/projects/${project.id}`),
    },
    ...(onDelete
      ? [
          {
            id: 'delete',
            label: 'Delete',
            variant: 'danger' as const,
            onClick: () => onDelete(project.id),
          },
        ]
      : []),
  ];

  return (
    <div
      onClick={() => navigate(`/projects/${project.id}`)}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/projects/${project.id}`); } }}
    >
    <Card className="py-3 px-[clamp(var(--sam-space-3),3vw,var(--sam-space-4))]">
      <div className="flex items-center gap-3">
        {/* Status + main info */}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <StatusBadge status={project.status === 'detached' ? 'error' : 'running'} label={project.status} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="sam-type-card-title text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                {project.name}
              </span>
              <span className="sam-type-caption text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap">
                {project.activeWorkspaceCount} ws &middot; {project.activeSessionCount} sessions
              </span>
            </div>
            <div className="sam-type-caption text-fg-muted mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
              {project.repository}
              <> &middot; {formatRelativeTime(project.lastActivityAt)}</>
            </div>
          </div>
        </div>

        {/* Overflow menu */}
        {overflowItems.length > 0 && (
          <div onClick={(e) => e.stopPropagation()} className="shrink-0">
            <DropdownMenu items={overflowItems} aria-label={`Actions for ${project.name}`} />
          </div>
        )}
      </div>
    </Card>
    </div>
  );
}
