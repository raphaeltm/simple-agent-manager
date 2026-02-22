import { useNavigate } from 'react-router-dom';
import { Card, StatusBadge, DropdownMenu, type DropdownMenuItem } from '@simple-agent-manager/ui';
import type { ProjectSummary } from '@simple-agent-manager/shared';

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
      style={{ cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/projects/${project.id}`); } }}
    >
    <Card style={{ padding: 'var(--sam-space-3) var(--sam-space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
        {/* Status + main info */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
          <StatusBadge status={project.status === 'detached' ? 'error' : 'running'} label={project.status} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sam-space-2)' }}>
              <span className="sam-type-card-title" style={{
                color: 'var(--sam-color-fg-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {project.name}
              </span>
              <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}>
                {project.activeWorkspaceCount} ws &middot; {project.activeSessionCount} sessions
              </span>
            </div>
            <div className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.repository}
              <> &middot; {formatRelativeTime(project.lastActivityAt)}</>
            </div>
          </div>
        </div>

        {/* Overflow menu */}
        {overflowItems.length > 0 && (
          <div onClick={(e) => e.stopPropagation()}>
            <DropdownMenu items={overflowItems} aria-label={`Actions for ${project.name}`} />
          </div>
        )}
      </div>
    </Card>
    </div>
  );
}
