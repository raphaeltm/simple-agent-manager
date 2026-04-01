import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS,VM_LOCATIONS, VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import { Button, Card, DropdownMenu, type DropdownMenuItem,StatusBadge } from '@simple-agent-manager/ui';
import { Plus,Server } from 'lucide-react';
import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';

import { MiniMetricBadge } from './MiniMetricBadge';
import { NodeWorkspaceMiniCard } from './NodeWorkspaceMiniCard';

const MAX_VISIBLE_WORKSPACES = 3;

interface NodeCardProps {
  node: NodeResponse;
  workspaces: WorkspaceResponse[];
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onCreateWorkspace: (nodeId: string) => void;
}

function getNodeActions(
  node: NodeResponse,
  handlers: { onStop: (id: string) => void; onDelete: (id: string) => void },
): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  const isTransitional = node.status === 'creating' || node.status === 'stopping';

  if (node.status === 'running') {
    items.push({
      id: 'stop',
      label: 'Stop',
      onClick: () => handlers.onStop(node.id),
    });
  }

  items.push({
    id: 'delete',
    label: 'Delete',
    variant: 'danger',
    onClick: () => handlers.onDelete(node.id),
    disabled: isTransitional,
    disabledReason: 'Cannot delete while node is transitioning',
  });

  return items;
}

export const NodeCard: FC<NodeCardProps> = ({
  node,
  workspaces,
  onStop,
  onDelete,
  onCreateWorkspace,
}) => {
  const navigate = useNavigate();
  const overflowItems = getNodeActions(node, { onStop, onDelete });
  const sizeLabels = VM_SIZE_LABELS[node.vmSize];
  const locationConfig = VM_LOCATIONS[node.vmLocation];
  const metrics = node.lastMetrics;
  const hasMetrics = metrics && (metrics.cpuLoadAvg1 != null || metrics.memoryPercent != null || metrics.diskPercent != null);
  const visibleWorkspaces = workspaces.slice(0, MAX_VISIBLE_WORKSPACES);
  const hiddenCount = workspaces.length - visibleWorkspaces.length;

  const handleCardClick = () => {
    navigate(`/nodes/${node.id}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`/nodes/${node.id}`);
    }
  };

  const handleCreateWorkspace = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCreateWorkspace(node.id);
  };

  return (
    <div
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`View node ${node.name}`}
      className="cursor-pointer"
    >
      <Card className="flex flex-col gap-3" style={{ padding: 'clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }}>
        {/* Header: icon + name + dropdown */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-info-tint flex items-center justify-center shrink-0">
            <Server size={20} color="var(--sam-color-info-fg)" />
          </div>

          <div className="flex-1 min-w-0">
            <span className="sam-type-card-title text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap block">
              {node.name}
            </span>
          </div>

          {overflowItems.length > 0 && (
            <div onClick={(e) => e.stopPropagation()} className="shrink-0">
              <DropdownMenu items={overflowItems} aria-label={`Actions for ${node.name}`} />
            </div>
          )}
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-2">
          <StatusBadge status={node.status} />
          <StatusBadge status={node.healthStatus || 'stale'} />
        </div>

        {/* VM info */}
        <div className="sam-type-caption text-fg-muted flex flex-wrap gap-x-1">
          <span aria-label={`Provider: ${node.cloudProvider ? (PROVIDER_LABELS[node.cloudProvider] ?? node.cloudProvider) : 'Unknown'}`}>
            {node.cloudProvider ? (PROVIDER_LABELS[node.cloudProvider] ?? node.cloudProvider) : 'Unknown'}
          </span>
          <span aria-hidden="true">&middot;</span>
          <span aria-label={`Size: ${sizeLabels ? sizeLabels.label : node.vmSize}`}>
            {sizeLabels ? `${sizeLabels.label} \u2014 ${sizeLabels.shortDescription}` : node.vmSize}
          </span>
          <span aria-hidden="true">&middot;</span>
          <span aria-label={`Location: ${locationConfig ? `${locationConfig.name}, ${locationConfig.country}` : node.vmLocation}`}>
            {locationConfig ? `${locationConfig.name}, ${locationConfig.country}` : node.vmLocation}
          </span>
        </div>

        {/* Resource metrics */}
        {hasMetrics ? (
          <div className="flex flex-wrap gap-2">
            {metrics.cpuLoadAvg1 != null && (
              <MiniMetricBadge label="CPU" value={metrics.cpuLoadAvg1} />
            )}
            {metrics.memoryPercent != null && (
              <MiniMetricBadge label="MEM" value={metrics.memoryPercent} />
            )}
            {metrics.diskPercent != null && (
              <MiniMetricBadge label="DISK" value={metrics.diskPercent} />
            )}
          </div>
        ) : (
          <span className="sam-type-caption text-fg-muted italic">
            No metrics yet
          </span>
        )}

        {/* Workspaces section */}
        <div className="border-t border-border-default pt-3 flex flex-col gap-2">
          <span className="sam-type-caption text-fg-muted font-medium">
            Workspaces ({workspaces.length})
          </span>

          {visibleWorkspaces.length > 0 ? (
            <>
              {visibleWorkspaces.map((ws) => (
                <div key={ws.id} onClick={(e) => e.stopPropagation()}>
                  <NodeWorkspaceMiniCard workspace={ws} />
                </div>
              ))}
              {hiddenCount > 0 && (
                <span className="sam-type-caption text-fg-muted pl-3">
                  +{hiddenCount} more
                </span>
              )}
            </>
          ) : (
            <span className="sam-type-caption text-fg-muted italic">
              No workspaces
            </span>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleCreateWorkspace}
            className="self-start"
          >
            <Plus size={14} />
            Create Workspace
          </Button>
        </div>

        {/* Error message */}
        {node.errorMessage && (
          <div className="p-2 bg-danger-tint rounded-sm">
            <span className="sam-type-caption text-danger">
              {node.errorMessage}
            </span>
          </div>
        )}
      </Card>
    </div>
  );
};
