import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { Button, StatusBadge } from '@simple-agent-manager/ui';
import type { FC } from 'react';
import { useNavigate } from 'react-router';

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
    <div className="flex items-center gap-2 px-3 py-2 bg-inset rounded-sm">
      <StatusBadge status={workspace.status} />

      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="sam-type-caption text-fg-primary font-medium overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
          {workspace.displayName || workspace.name}
        </span>
        {workspace.branch && (
          <span className="sam-type-caption text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            {workspace.branch}
          </span>
        )}
      </div>

      {isActive && (
        <div className="shrink-0">
          <Button variant="secondary" size="sm" onClick={handleOpen}>
            Open
          </Button>
        </div>
      )}
    </div>
  );
};
