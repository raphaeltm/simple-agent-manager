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
    <Card className="transition-[border-color] duration-150" style={{ padding: 'var(--sam-space-3) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }}>
      <div className="flex items-center gap-3">
        {/* Main content */}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <StatusBadge status={workspace.status} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="sam-type-card-title text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                {workspace.displayName || workspace.name}
              </span>
              <span className="sam-type-caption text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap">
                {workspace.branch}
              </span>
            </div>
            <div className="sam-type-caption text-fg-muted mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
              {workspace.repository}
              {workspace.lastActivityAt && (
                <> &middot; {new Date(workspace.lastActivityAt).toLocaleDateString()}</>
              )}
            </div>
          </div>
        </div>

        {/* Primary action */}
        {isActive && (
          <div className="shrink-0">
            <Button variant="primary" size="sm" onClick={handleOpen}>
              Open
            </Button>
          </div>
        )}
        {workspace.status === 'stopped' && onRestart && (
          <div className="shrink-0">
            <Button variant="secondary" size="sm" onClick={() => onRestart(workspace.id)}>
              Start
            </Button>
          </div>
        )}
        {(workspace.status === 'creating' || workspace.status === 'stopping') && (
          <span className="sam-type-caption text-fg-muted shrink-0">
            Please wait...
          </span>
        )}

        {/* Overflow menu */}
        {overflowItems.length > 0 && (
          <div className="shrink-0">
            <DropdownMenu items={overflowItems} aria-label={`Actions for ${workspace.displayName || workspace.name}`} />
          </div>
        )}
      </div>

      {workspace.errorMessage && (
        <div className="mt-2 p-2 bg-danger-tint rounded-sm">
          <span className="sam-type-caption text-danger">
            {workspace.errorMessage}
          </span>
        </div>
      )}
    </Card>
  );
}
