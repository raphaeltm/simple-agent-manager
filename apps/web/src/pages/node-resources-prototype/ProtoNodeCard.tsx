// PROTOTYPE — design exploration only. Never ships to production.
// Mirrors apps/web/src/components/node/NodeCard.tsx so each concept previews inside the real
// card structure (same sub-components, tokens, and density). Only the resource block changes.
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS, VM_LOCATIONS } from '@simple-agent-manager/shared';
import { Button, Card, DropdownMenu, type DropdownMenuItem, StatusBadge } from '@simple-agent-manager/ui';
import { Plus, Rocket, Server } from 'lucide-react';
import { type FC, useMemo, useState } from 'react';

import { HardwareDetails } from '../../components/hardware/HardwareDetails';
import { MiniMetricBadge } from '../../components/node/MiniMetricBadge';
import {
  computeAllocation,
  formatAmount,
  type NodeAllocation,
  RESOURCE_KEYS,
  RESOURCE_LABELS,
  segmentColor,
  summarizeReservation,
  unitOf,
} from './allocation';
import { Ledger } from './ledger';
import { AllocationStrip, HeaderGlyph, RailMeter, StatTile } from './visualizations';

export type Concept = 'strip' | 'rails' | 'tiles' | 'ledger' | 'glyph';

const MAX_VISIBLE_WORKSPACES = 3;
const CARD_PADDING = 'clamp(var(--sam-space-3), 3vw, var(--sam-space-4))';

interface ProtoNodeCardProps {
  concept: Concept;
  node: NodeResponse;
  workspaces: WorkspaceResponse[];
  /** Concept E only: start with the glyph expanded. */
  initiallyExpanded?: boolean;
}

function nodeActions(node: NodeResponse): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  const isTransitional = node.status === 'creating' || node.status === 'stopping';
  if (node.status === 'running') items.push({ id: 'stop', label: 'Stop', onClick: () => {} });
  items.push({
    id: 'delete',
    label: 'Delete',
    variant: 'danger',
    onClick: () => {},
    disabled: isTransitional,
    disabledReason: 'Cannot delete while node is transitioning',
  });
  return items;
}

const ProtoWorkspaceRow: FC<{ workspace: WorkspaceResponse; dotColor?: string; caption?: string }> = ({
  workspace,
  dotColor,
  caption,
}) => {
  const isActive = workspace.status === 'running' || workspace.status === 'recovery';
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-inset rounded-sm">
      {dotColor && (
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: dotColor, flexShrink: 0 }} />
      )}
      <StatusBadge status={workspace.status} />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="sam-type-caption text-fg-primary font-medium overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            {workspace.displayName || workspace.name}
          </span>
          {workspace.branch && (
            <span className="sam-type-caption text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
              {workspace.branch}
            </span>
          )}
        </div>
        {caption && (
          <span className="text-fg-muted tabular-nums whitespace-nowrap overflow-hidden text-ellipsis" style={{ fontSize: '0.625rem', lineHeight: 1.3 }}>
            {caption}
          </span>
        )}
      </div>
      {isActive && (
        <div className="shrink-0">
          <Button variant="secondary" size="sm" onClick={(e) => e.stopPropagation()}>
            Open
          </Button>
        </div>
      )}
    </div>
  );
};

const LiveBadges: FC<{ node: NodeResponse }> = ({ node }) => {
  const metrics = node.lastMetrics;
  const hasMetrics =
    metrics && (metrics.cpuLoadAvg1 != null || metrics.memoryPercent != null || metrics.diskPercent != null);
  if (!hasMetrics) return <span className="sam-type-caption text-fg-muted italic">No metrics yet</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {metrics.cpuLoadAvg1 != null && <MiniMetricBadge label="CPU" value={metrics.cpuLoadAvg1} />}
      {metrics.memoryPercent != null && <MiniMetricBadge label="MEM" value={metrics.memoryPercent} />}
      {metrics.diskPercent != null && <MiniMetricBadge label="DISK" value={metrics.diskPercent} />}
    </div>
  );
};

function reservedCaption(allocation: NodeAllocation): string {
  const capacity = allocation.capacity;
  if (!capacity) return 'Capacity unknown — no hardware report';
  return RESOURCE_KEYS.map(
    (key) =>
      `${RESOURCE_LABELS[key]} ${formatAmount(key, allocation.reserved[key])}/${formatAmount(key, capacity[key])} ${unitOf(key)}`
  ).join(' · ');
}

const ResourceBlock: FC<{ concept: Concept; node: NodeResponse; allocation: NodeAllocation }> = ({
  concept,
  node,
  allocation,
}) => {
  switch (concept) {
    case 'strip':
      return <AllocationStrip allocation={allocation} />;
    case 'tiles':
      return allocation.capacity ? (
        <div className="grid grid-cols-3 gap-2">
          {RESOURCE_KEYS.map((key) => (
            <StatTile key={key} allocation={allocation} resource={key} />
          ))}
        </div>
      ) : (
        <AllocationStrip allocation={allocation} />
      );
    case 'ledger':
      return (
        <div className="flex flex-col gap-2">
          <Ledger allocation={allocation} />
          <LiveBadges node={node} />
        </div>
      );
    case 'rails':
      return (
        <div className="flex flex-col gap-2">
          <LiveBadges node={node} />
          <span className="text-fg-muted tabular-nums [overflow-wrap:anywhere]" style={{ fontSize: '0.625rem', lineHeight: 1.3 }}>
            {allocation.capacity ? `Reserved ${reservedCaption(allocation)}` : reservedCaption(allocation)}
          </span>
        </div>
      );
    case 'glyph':
      return <LiveBadges node={node} />;
  }
};

export const ProtoNodeCard: FC<ProtoNodeCardProps> = ({ concept, node, workspaces, initiallyExpanded = false }) => {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const allocation = useMemo(() => computeAllocation(node, workspaces), [node, workspaces]);
  const locationConfig = VM_LOCATIONS[node.vmLocation];
  const isDeploymentNode = node.nodeRole === 'deployment';
  const visibleWorkspaces = workspaces.slice(0, MAX_VISIBLE_WORKSPACES);
  const hiddenCount = workspaces.length - visibleWorkspaces.length;
  const deploymentEnvironments = node.deploymentEnvironments ?? [];
  const showIdentityDots = !isDeploymentNode && (concept === 'strip' || concept === 'ledger' || (concept === 'glyph' && expanded));
  const showRowCaptions = !isDeploymentNode && (concept === 'strip' || concept === 'tiles' || (concept === 'glyph' && expanded));
  const rails = concept === 'rails' && !isDeploymentNode;
  const segmentFor = (workspaceId: string) => allocation.segments.find((s) => s.workspaceId === workspaceId);
  const otherSegment = allocation.segments.find((s) => s.count > 1);

  return (
    <div role="button" tabIndex={0} aria-label={`View node ${node.name}`} className="cursor-pointer">
      <Card
        variant="glass"
        className="flex flex-col gap-3 relative"
        style={{
          padding: CARD_PADDING,
          ...(rails
            ? {
                paddingLeft: `calc(${CARD_PADDING} + 10px)`,
                paddingRight: `calc(${CARD_PADDING} + 10px)`,
                paddingBottom: `calc(${CARD_PADDING} + 8px)`,
              }
            : {}),
        }}
      >
        {rails && allocation.capacity && (
          <>
            <span aria-hidden="true" className="text-fg-muted" style={{ position: 'absolute', top: 4, left: 3, fontSize: 8, lineHeight: 1, letterSpacing: '0.02em' }}>CPU</span>
            <RailMeter allocation={allocation} resource="cpu" orientation="vertical" style={{ left: 7, top: 16, bottom: 22 }} />
            <span aria-hidden="true" className="text-fg-muted" style={{ position: 'absolute', top: 4, right: 3, fontSize: 8, lineHeight: 1, letterSpacing: '0.02em' }}>RAM</span>
            <RailMeter allocation={allocation} resource="memory" orientation="vertical" style={{ right: 7, top: 16, bottom: 22 }} />
            <span aria-hidden="true" className="text-fg-muted" style={{ position: 'absolute', bottom: 5, left: 7, fontSize: 8, lineHeight: 1, letterSpacing: '0.02em' }}>DISK</span>
            <RailMeter allocation={allocation} resource="disk" orientation="horizontal" style={{ left: 30, right: 30, bottom: 7 }} />
          </>
        )}

        {/* Header: icon + name + (glyph) + dropdown */}
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-sm flex items-center justify-center shrink-0 ${isDeploymentNode ? 'bg-accent-tint' : 'bg-info-tint'}`}>
            {isDeploymentNode ? <Rocket size={20} className="text-accent" /> : <Server size={20} color="var(--sam-color-info-fg)" />}
          </div>
          <div className="flex-1 min-w-0">
            <span className="sam-type-card-title text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap block">{node.name}</span>
          </div>
          {concept === 'glyph' && !isDeploymentNode && (
            <HeaderGlyph allocation={allocation} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
          )}
          <div role="presentation" onClick={(e) => e.stopPropagation()} className="shrink-0">
            <DropdownMenu items={nodeActions(node)} aria-label={`Actions for ${node.name}`} />
          </div>
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={node.status} />
          <StatusBadge status={node.healthStatus || 'stale'} />
          {isDeploymentNode && (
            <span className="inline-flex items-center rounded-full bg-accent-tint px-2.5 py-0.5 text-xs font-semibold text-accent">Deployment</span>
          )}
        </div>

        {concept === 'glyph' && expanded && !isDeploymentNode && (
          <div className="bg-inset rounded-sm" style={{ padding: '8px 10px' }}>
            <AllocationStrip allocation={allocation} compact />
          </div>
        )}

        {/* VM info */}
        <div className="sam-type-caption text-fg-muted flex flex-wrap gap-x-1">
          <span>{node.cloudProvider ? (PROVIDER_LABELS[node.cloudProvider] ?? node.cloudProvider) : 'Unknown'}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{locationConfig ? `${locationConfig.name}, ${locationConfig.country}` : node.vmLocation}</span>
        </div>

        <HardwareDetails hardware={node} />
        {node.providerInstancePriceDisplay && (
          <span className="text-xs text-fg-muted">Offering price: {node.providerInstancePriceDisplay}</span>
        )}

        {/* Resource block — the only part each concept changes */}
        {isDeploymentNode ? <LiveBadges node={node} /> : <ResourceBlock concept={concept} node={node} allocation={allocation} />}

        {/* Workspaces section */}
        <div className="border-t border-border-default pt-3 flex flex-col gap-2">
          <span className="sam-type-caption text-fg-muted font-medium">
            {isDeploymentNode ? `Deployment environments (${deploymentEnvironments.length})` : `Workspaces (${workspaces.length})`}
          </span>
          {isDeploymentNode && deploymentEnvironments.length > 0 ? (
            deploymentEnvironments.slice(0, MAX_VISIBLE_WORKSPACES).map((env) => (
              <span key={env.id} className="sam-type-caption text-fg-primary pl-3 overflow-hidden text-ellipsis whitespace-nowrap">{env.name}</span>
            ))
          ) : visibleWorkspaces.length > 0 ? (
            <>
              {visibleWorkspaces.map((ws) => {
                const segment = segmentFor(ws.id);
                return (
                  <div key={ws.id} role="presentation" onClick={(e) => e.stopPropagation()}>
                    <ProtoWorkspaceRow
                      workspace={ws}
                      dotColor={showIdentityDots ? segmentColor(segment?.colorIndex ?? 3) : undefined}
                      caption={
                        showRowCaptions
                          ? segment
                            ? summarizeReservation(segment.amounts)
                            : 'Reservation unknown'
                          : undefined
                      }
                    />
                  </div>
                );
              })}
              {hiddenCount > 0 && (
                <span className="sam-type-caption text-fg-muted pl-3 flex items-center gap-2">
                  {showIdentityDots && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: segmentColor(3), opacity: 0.45 }} />}
                  +{hiddenCount} more
                  {showRowCaptions && otherSegment && (
                    <span className="text-fg-muted" style={{ fontSize: '0.625rem' }}>
                      · {summarizeReservation(otherSegment.amounts)}
                    </span>
                  )}
                </span>
              )}
            </>
          ) : (
            <span className="sam-type-caption text-fg-muted italic">{isDeploymentNode ? 'No deployment environments' : 'No workspaces'}</span>
          )}
          {isDeploymentNode ? (
            <span className="sam-type-caption text-fg-muted">Managed from the project deployment environment.</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()} className="self-start">
              <Plus size={14} />
              Create Workspace
            </Button>
          )}
        </div>

        {node.errorMessage && (
          <div className="p-2 bg-danger-tint rounded-sm">
            <span className="sam-type-caption text-danger [overflow-wrap:anywhere]">{node.errorMessage}</span>
          </div>
        )}
      </Card>
    </div>
  );
};

