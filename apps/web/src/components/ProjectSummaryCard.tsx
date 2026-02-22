import { useNavigate } from 'react-router-dom';
import { Card, StatusBadge } from '@simple-agent-manager/ui';
import type { ProjectSummary } from '@simple-agent-manager/shared';

interface ProjectSummaryCardProps {
  project: ProjectSummary;
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

export function ProjectSummaryCard({ project }: ProjectSummaryCardProps) {
  const navigate = useNavigate();

  return (
    <div onClick={() => navigate(`/projects/${project.id}`)} style={{ cursor: 'pointer' }}>
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{
            margin: 0,
            fontSize: '1rem',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {project.name}
          </h3>
          <p style={{
            margin: '2px 0 0',
            fontSize: '0.8rem',
            color: 'var(--sam-color-text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {project.repository}
          </p>
        </div>
        <StatusBadge status={project.status === 'detached' ? 'error' : 'running'} label={project.status} />
      </div>

      <div style={{
        display: 'flex',
        gap: '16px',
        fontSize: '0.8rem',
        color: 'var(--sam-color-text-secondary)',
        marginTop: '12px',
      }}>
        <span title="Active workspaces">
          {project.activeWorkspaceCount} workspace{project.activeWorkspaceCount !== 1 ? 's' : ''}
        </span>
        <span title="Active sessions">
          {project.activeSessionCount} session{project.activeSessionCount !== 1 ? 's' : ''}
        </span>
        <span title="Last activity" style={{ marginLeft: 'auto' }}>
          {formatRelativeTime(project.lastActivityAt)}
        </span>
      </div>
    </Card>
    </div>
  );
}
