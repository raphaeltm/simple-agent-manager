import type { FC } from 'react';
import type { NodeResponse, NodeSystemInfo } from '@simple-agent-manager/shared';
import { VM_SIZE_CONFIG, VM_LOCATIONS } from '@simple-agent-manager/shared';
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

const metaLabelStyle: React.CSSProperties = {
  fontSize: 'var(--sam-type-caption-size)',
  color: 'var(--sam-color-fg-muted)',
  marginBottom: 'var(--sam-space-1)',
};

const metaValueStyle: React.CSSProperties = {
  fontSize: 'var(--sam-type-secondary-size)',
  color: 'var(--sam-color-fg-primary)',
  fontWeight: 500,
};

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
        icon={<Server size={20} color="#60a5fa" />}
        iconBg="var(--sam-color-info-tint)"
        title={node.name}
        description="Node overview and configuration"
      />

      <div
        style={{
          display: 'flex',
          gap: 'var(--sam-space-2)',
          alignItems: 'center',
          marginBottom: 'var(--sam-space-4)',
        }}
      >
        <StatusBadge status={node.status} />
        <StatusBadge status={node.healthStatus || 'stale'} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 'var(--sam-space-4)',
          borderTop: '1px solid var(--sam-color-border-default)',
          paddingTop: 'var(--sam-space-4)',
        }}
      >
        <div>
          <div style={metaLabelStyle}>Size</div>
          <div style={metaValueStyle}>{sizeLabel}</div>
        </div>
        <div>
          <div style={metaLabelStyle}>Location</div>
          <div style={metaValueStyle}>{locationLabel}</div>
        </div>
        {node.ipAddress && (
          <div>
            <div style={metaLabelStyle}>IP Address</div>
            <div style={{ ...metaValueStyle, fontFamily: 'monospace' }}>{node.ipAddress}</div>
          </div>
        )}
        <div>
          <div style={metaLabelStyle}>Last Heartbeat</div>
          <div style={metaValueStyle}>
            {node.lastHeartbeatAt ? (
              <>
                {formatRelativeTime(node.lastHeartbeatAt)}
                <span
                  style={{
                    fontSize: '0.6875rem',
                    color: 'var(--sam-color-fg-muted)',
                    marginLeft: 'var(--sam-space-1)',
                  }}
                >
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
            <div style={metaLabelStyle}>Uptime</div>
            <div style={metaValueStyle}>{systemInfo.uptime.humanFormat}</div>
          </div>
        )}
        <div>
          <div style={metaLabelStyle}>Created</div>
          <div style={metaValueStyle}>{formatTimestamp(node.createdAt)}</div>
        </div>
      </div>

      {node.errorMessage && (
        <div
          style={{
            marginTop: 'var(--sam-space-4)',
            padding: 'var(--sam-space-3)',
            backgroundColor: 'var(--sam-color-danger-tint)',
            borderRadius: 'var(--sam-radius-sm)',
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
