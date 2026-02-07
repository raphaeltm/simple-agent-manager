import { useNavigate } from 'react-router-dom';
import { StatusBadge } from './StatusBadge';
import { Card } from '@simple-agent-manager/ui';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

interface WorkspaceCardProps {
  workspace: WorkspaceResponse;
  onStop?: (id: string) => void;
  onRestart?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const actionButtonStyle: React.CSSProperties = {
  padding: '4px 12px',
  fontSize: '0.75rem',
  fontWeight: 500,
  background: 'none',
  border: 'none',
  borderRadius: 'var(--sam-radius-sm)',
  cursor: 'pointer',
  transition: 'background-color 0.1s',
};

/**
 * Card component for displaying a workspace.
 */
export function WorkspaceCard({ workspace, onStop, onRestart, onDelete }: WorkspaceCardProps) {
  const navigate = useNavigate();

  const handleOpen = () => {
    if (workspace.url) {
      window.open(workspace.url, '_blank');
    } else {
      navigate(`/workspaces/${workspace.id}`);
    }
  };

  return (
    <Card style={{ padding: 'var(--sam-space-4)', transition: 'border-color 0.15s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
            <h3 style={{
              fontSize: '0.875rem',
              fontWeight: 500,
              color: 'var(--sam-color-fg-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {workspace.name}
            </h3>
            <StatusBadge status={workspace.status} />
          </div>
          <p style={{
            marginTop: 'var(--sam-space-1)',
            fontSize: '0.875rem',
            color: 'var(--sam-color-fg-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {workspace.repository}
          </p>
          <p style={{
            marginTop: 'var(--sam-space-1)',
            fontSize: '0.75rem',
            color: 'var(--sam-color-fg-muted)',
            opacity: 0.7,
          }}>
            {workspace.branch} &middot; {workspace.vmSize} &middot; {workspace.vmLocation}
          </p>
        </div>
      </div>

      {workspace.errorMessage && (
        <div style={{
          marginTop: 'var(--sam-space-3)',
          padding: 'var(--sam-space-2)',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          borderRadius: 'var(--sam-radius-sm)',
          fontSize: '0.75rem',
          color: '#f87171',
        }}>
          {workspace.errorMessage}
        </div>
      )}

      {workspace.shutdownDeadline && (
        <div style={{
          marginTop: 'var(--sam-space-3)',
          padding: 'var(--sam-space-2)',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          borderRadius: 'var(--sam-radius-sm)',
          fontSize: '0.75rem',
          color: '#fbbf24',
          display: 'flex',
          alignItems: 'center',
        }}>
          <svg style={{ height: 14, width: 14, marginRight: 6, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>
            Auto-shutdown at {new Date(workspace.shutdownDeadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      )}

      <div style={{
        marginTop: 'var(--sam-space-4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', opacity: 0.7 }}>
          {workspace.lastActivityAt
            ? `Last active: ${new Date(workspace.lastActivityAt).toLocaleString()}`
            : `Created: ${new Date(workspace.createdAt).toLocaleString()}`}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          {workspace.status === 'running' && (
            <>
              <button
                onClick={handleOpen}
                style={{ ...actionButtonStyle, color: 'var(--sam-color-accent-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(22, 163, 74, 0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                Open
              </button>
              {onStop && (
                <button
                  onClick={() => onStop(workspace.id)}
                  style={{ ...actionButtonStyle, color: 'var(--sam-color-warning)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(245, 158, 11, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  Stop
                </button>
              )}
            </>
          )}
          {workspace.status === 'stopped' && (
            <>
              {onRestart && (
                <button
                  onClick={() => onRestart(workspace.id)}
                  style={{ ...actionButtonStyle, color: 'var(--sam-color-success)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(34, 197, 94, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  Restart
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => onDelete(workspace.id)}
                  style={{ ...actionButtonStyle, color: 'var(--sam-color-danger)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  Delete
                </button>
              )}
            </>
          )}
          {workspace.status === 'error' && onDelete && (
            <button
              onClick={() => onDelete(workspace.id)}
              style={{ ...actionButtonStyle, color: 'var(--sam-color-danger)' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              Delete
            </button>
          )}
          {(workspace.status === 'creating' || workspace.status === 'stopping') && (
            <span style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>Please wait...</span>
          )}
        </div>
      </div>
    </Card>
  );
}
