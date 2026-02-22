import { useNavigate } from 'react-router-dom';
import { StatusBadge } from './StatusBadge';
import { Card, Button, DropdownMenu, type DropdownMenuItem } from '@simple-agent-manager/ui';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { useIsStandalone } from '../hooks/useIsStandalone';

interface WorkspaceCardProps {
  workspace: WorkspaceResponse;
  onStop?: (id: string) => void;
  onRestart?: (id: string) => void;
  onDelete?: (id: string) => void;
}

function getWorkspaceActions(
  workspace: WorkspaceResponse,
  handlers: { onStop?: (id: string) => void; onRestart?: (id: string) => void; onDelete?: (id: string) => void },
): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  const isTransitional = workspace.status === 'creating' || workspace.status === 'stopping';

  if (workspace.status === 'running' || workspace.status === 'recovery') {
    if (handlers.onStop) {
      items.push({
        id: 'stop',
        label: 'Stop',
        onClick: () => handlers.onStop!(workspace.id),
      });
    }
  }

  if (workspace.status === 'stopped') {
    if (handlers.onRestart) {
      items.push({
        id: 'restart',
        label: 'Restart',
        onClick: () => handlers.onRestart!(workspace.id),
      });
    }
  }

  if (handlers.onDelete) {
    items.push({
      id: 'delete',
      label: 'Delete',
      variant: 'danger',
      onClick: () => handlers.onDelete!(workspace.id),
      disabled: isTransitional,
      disabledReason: 'Cannot delete while workspace is transitioning',
    });
  }

  return items;
}

export function WorkspaceCard({ workspace, onStop, onRestart, onDelete }: WorkspaceCardProps) {
  const navigate = useNavigate();
  const isStandalone = useIsStandalone();
  const isActive = workspace.status === 'running' || workspace.status === 'recovery';

  const handleOpen = () => {
    const path = `/workspaces/${workspace.id}`;
    if (isStandalone) {
      navigate(path);
      return;
    }
    const opened = window.open(path, '_blank');
    if (opened) {
      try { opened.opener = null; } catch { /* ignore */ }
      return;
    }
    navigate(path);
  };

  const overflowItems = getWorkspaceActions(workspace, { onStop, onRestart, onDelete });

  return (
    <Card style={{ padding: 'var(--sam-space-3) var(--sam-space-4)', transition: 'border-color 150ms' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
          <StatusBadge status={workspace.status} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sam-space-2)' }}>
              <span className="sam-type-card-title" style={{
                color: 'var(--sam-color-fg-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {workspace.displayName || workspace.name}
              </span>
              <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}>
                {workspace.branch}
              </span>
            </div>
            <div className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {workspace.repository}
              {workspace.lastActivityAt && (
                <> &middot; {new Date(workspace.lastActivityAt).toLocaleDateString()}</>
              )}
            </div>
          </div>
        </div>

        {/* Primary action */}
        {isActive && (
          <Button variant="primary" size="sm" onClick={handleOpen}>
            Open
          </Button>
        )}
        {workspace.status === 'stopped' && onRestart && (
          <Button variant="secondary" size="sm" onClick={() => onRestart(workspace.id)}>
            Start
          </Button>
        )}
        {(workspace.status === 'creating' || workspace.status === 'stopping') && (
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}>
            Please wait...
          </span>
        )}

        {/* Overflow menu */}
        {overflowItems.length > 0 && (
          <DropdownMenu items={overflowItems} aria-label={`Actions for ${workspace.displayName || workspace.name}`} />
        )}
      </div>

      {workspace.errorMessage && (
        <div style={{
          marginTop: 'var(--sam-space-2)',
          padding: 'var(--sam-space-2)',
          backgroundColor: 'var(--sam-color-danger-tint)',
          borderRadius: 'var(--sam-radius-sm)',
        }}>
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-danger)' }}>
            {workspace.errorMessage}
          </span>
        </div>
      )}
    </Card>
  );
}
