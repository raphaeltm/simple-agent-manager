import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { VM_SIZE_CONFIG, VM_LOCATIONS } from '@simple-agent-manager/shared';
import { Card, Button, StatusBadge, DropdownMenu, type DropdownMenuItem } from '@simple-agent-manager/ui';
import { Server, Plus } from 'lucide-react';
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
  const sizeConfig = VM_SIZE_CONFIG[node.vmSize];
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
      style={{ cursor: 'pointer' }}
    >
      <Card style={{ padding: 'clamp(var(--sam-space-3), 3vw, var(--sam-space-4))', display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)' }}>
        {/* Header: icon + name + dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 'var(--sam-radius-sm)',
              backgroundColor: 'var(--sam-color-info-tint)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Server size={20} color="var(--sam-color-info-fg)" />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <span
              className="sam-type-card-title"
              style={{
                color: 'var(--sam-color-fg-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'block',
              }}
            >
              {node.name}
            </span>
          </div>

          {overflowItems.length > 0 && (
            <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
              <DropdownMenu items={overflowItems} aria-label={`Actions for ${node.name}`} />
            </div>
          )}
        </div>

        {/* Status badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          <StatusBadge status={node.status} />
          <StatusBadge status={node.healthStatus || 'stale'} />
        </div>

        {/* VM info */}
        <div
          className="sam-type-caption"
          style={{ color: 'var(--sam-color-fg-muted)' }}
        >
          {node.vmSize} ({sizeConfig.cpus} CPU, {sizeConfig.ram}) &middot; {locationConfig.name}, {locationConfig.country}
        </div>

        {/* Resource metrics */}
        {hasMetrics ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sam-space-2)' }}>
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
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', fontStyle: 'italic' }}>
            No metrics yet
          </span>
        )}

        {/* Workspaces section */}
        <div
          style={{
            borderTop: '1px solid var(--sam-color-border-default)',
            paddingTop: 'var(--sam-space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sam-space-2)',
          }}
        >
          <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', fontWeight: 500 }}>
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
                <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', paddingLeft: 'var(--sam-space-3)' }}>
                  +{hiddenCount} more
                </span>
              )}
            </>
          ) : (
            <span className="sam-type-caption" style={{ color: 'var(--sam-color-fg-muted)', fontStyle: 'italic' }}>
              No workspaces
            </span>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleCreateWorkspace}
            style={{ alignSelf: 'flex-start' }}
          >
            <Plus size={14} />
            Create Workspace
          </Button>
        </div>

        {/* Error message */}
        {node.errorMessage && (
          <div
            style={{
              padding: 'var(--sam-space-2)',
              backgroundColor: 'var(--sam-color-danger-tint)',
              borderRadius: 'var(--sam-radius-sm)',
            }}
          >
            <span className="sam-type-caption" style={{ color: 'var(--sam-color-danger)' }}>
              {node.errorMessage}
            </span>
          </div>
        )}
      </Card>
    </div>
  );
};
