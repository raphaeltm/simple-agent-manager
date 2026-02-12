import { useNavigate } from 'react-router-dom';
import { StatusBadge } from './StatusBadge';
import { Card } from '@simple-agent-manager/ui';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { useIsMobile } from '../hooks/useIsMobile';

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
  const isMobile = useIsMobile();

  const handleOpen = () => {
    // Open the control plane workspace page (not the ws-* subdomain directly).
    // Direct ws-* access requires a terminal token / cookie, so opening it from the
    // dashboard often looks like a 403/unauthorized to users.
    const path = `/workspaces/${workspace.id}`;
    const opened = window.open(path, '_blank');
    if (opened) {
      // Best-effort noopener. Some browsers return null when `noopener` is set via
      // window features, so we set it explicitly instead of relying on return value.
      try {
        opened.opener = null;
      } catch {
        // Ignore
      }
      return;
    }
    // Pop-up blocker fallback
    navigate(path);
  };

  const buttonStyle = {
    ...actionButtonStyle,
    minHeight: isMobile ? '56px' : 'auto',
    minWidth: isMobile ? '120px' : 'auto',
    fontSize: isMobile ? '0.875rem' : actionButtonStyle.fontSize,
    padding: isMobile ? '0 16px' : actionButtonStyle.padding,
    flex: isMobile ? '1 1 0%' : '0 0 auto',
  } satisfies React.CSSProperties;

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
              {workspace.displayName || workspace.name}
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
            {workspace.branch}
            {' \u00b7 '}
            {workspace.vmSize}
            {' \u00b7 '}
            {workspace.vmLocation}
            {workspace.nodeId ? ` \u00b7 Node ${workspace.nodeId}` : ''}
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

      <div style={{
        marginTop: 'var(--sam-space-4)',
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center',
        justifyContent: 'space-between',
        gap: isMobile ? 'var(--sam-space-3)' : 'var(--sam-space-2)',
      }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', opacity: 0.7 }}>
          {workspace.lastActivityAt
            ? `Last active: ${new Date(workspace.lastActivityAt).toLocaleString()}`
            : `Created: ${new Date(workspace.createdAt).toLocaleString()}`}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', width: isMobile ? '100%' : 'auto' }}>
          {workspace.status === 'running' && (
            <>
              <button
                onClick={handleOpen}
                style={{ ...buttonStyle, color: 'var(--sam-color-accent-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(22, 163, 74, 0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                Open
              </button>
              {onStop && (
                <button
                  onClick={() => onStop(workspace.id)}
                  style={{ ...buttonStyle, color: 'var(--sam-color-warning)' }}
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
                  style={{ ...buttonStyle, color: 'var(--sam-color-success)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(34, 197, 94, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  Restart
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => onDelete(workspace.id)}
                  style={{ ...buttonStyle, color: 'var(--sam-color-danger)' }}
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
              style={{ ...buttonStyle, color: 'var(--sam-color-danger)' }}
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
