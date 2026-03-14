import type { FC } from 'react';
import type { NodeResponse, NodeSystemInfo } from '@simple-agent-manager/shared';
import { VM_SIZE_CONFIG, VM_LOCATIONS, PROVIDER_LABELS } from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';
import { Server } from 'lucide-react';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';

interface NodeOverviewSectionProps {
  node: NodeResponse;
  systemInfo?: NodeSystemInfo | null;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'N/A';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const NodeOverviewSection: FC<NodeOverviewSectionProps> = ({ node, systemInfo }) => {
  const sizeConfig = VM_SIZE_CONFIG[node.vmSize];
  const locationConfig = VM_LOCATIONS[node.vmLocation];
  const sizeLabel = sizeConfig
    ? `${node.vmSize} (${sizeConfig.cpus} CPU, ${sizeConfig.ram})`
    : node.vmSize;
  const locationLabel = locationConfig
    ? `${locationConfig.name}, ${locationConfig.country}`
    : node.vmLocation;

  return (
    <Section>
      <SectionHeader
        icon={<Server size={20} color="var(--sam-color-info-fg)" />}
        iconBg="var(--sam-color-info-tint)"
        title={node.name}
        description="Node overview and configuration"
      />

      <div className="flex gap-2 items-center mb-4">
        <StatusBadge status={node.status} />
        <StatusBadge status={node.healthStatus || 'stale'} />
      </div>

      <div className="grid gap-4 border-t border-border-default pt-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        <div>
          <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>Provider</div>
          <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>{node.cloudProvider ? (PROVIDER_LABELS[node.cloudProvider] ?? node.cloudProvider) : 'Unknown'}</div>
        </div>
        <div>
          <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>Size</div>
          <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>{sizeLabel}</div>
        </div>
        <div>
          <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>Location</div>
          <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>{locationLabel}</div>
        </div>
        {node.ipAddress && (
          <div>
            <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>IP Address</div>
            <div className="text-fg-primary font-medium font-mono" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>{node.ipAddress}</div>
          </div>
        )}
        <div>
          <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>Last Heartbeat</div>
          <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
            {node.lastHeartbeatAt ? (
              <>
                {formatRelativeTime(node.lastHeartbeatAt)}
                <span className="text-fg-muted ml-1" style={{ fontSize: '0.6875rem' }}>
                  ({formatTimestamp(node.lastHeartbeatAt)})
                </span>
              </>
            ) : (
              'No heartbeat yet'
            )}
          </div>
        </div>
        {systemInfo?.uptime && (
          <div>
            <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>Uptime</div>
            <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>{systemInfo.uptime.humanFormat}</div>
          </div>
        )}
        <div>
          <div className="text-fg-muted mb-1" style={{ fontSize: 'var(--sam-type-caption-size)' }}>Created</div>
          <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>{formatTimestamp(node.createdAt)}</div>
        </div>
      </div>

      {node.errorMessage && (
        <div
          className="mt-4 p-3 bg-danger-tint rounded-sm"
          style={{
            border: '1px solid rgba(248, 113, 113, 0.3)',
            fontSize: 'var(--sam-type-secondary-size)',
            color: 'var(--sam-color-danger)',
          }}
        >
          {node.errorMessage}
        </div>
      )}
    </Section>
  );
};
