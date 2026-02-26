import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { Button, StatusBadge } from '@simple-agent-manager/ui';
import { useIsStandalone } from '../../hooks/useIsStandalone';

interface NodeWorkspaceMiniCardProps {
  workspace: WorkspaceResponse;
}

export const NodeWorkspaceMiniCard: FC<NodeWorkspaceMiniCardProps> = ({ workspace }) => {
  const navigate = useNavigate();
  const isStandalone = useIsStandalone();
  const isActive = workspace.status === 'running' || workspace.status === 'recovery';

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const path = `/workspaces/${workspace.id}`;
    if (isStandalone) {
      navigate(path);
      return;
    }
    const opened = window.open(path, '_blank', 'noopener,noreferrer');
    if (opened) return;
    navigate(path);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sam-space-2)',
        padding: 'var(--sam-space-2) var(--sam-space-3)',
        backgroundColor: 'var(--sam-color-bg-inset)',
        borderRadius: 'var(--sam-radius-sm)',
      }}
    >
      <StatusBadge status={workspace.status} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 'var(--sam-space-2)' }}>
        <span
          className="sam-type-caption"
          style={{
            color: 'var(--sam-color-fg-primary)',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {workspace.displayName || workspace.name}
        </span>
        {workspace.branch && (
          <span
            className="sam-type-caption"
            style={{
              color: 'var(--sam-color-fg-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {workspace.branch}
          </span>
        )}
      </div>

      {isActive && (
        <div style={{ flexShrink: 0 }}>
          <Button variant="secondary" size="sm" onClick={handleOpen}>
            Open
          </Button>
        </div>
      )}
    </div>
  );
};
