import type { FC } from 'react';
import type { NodeMetrics, NodeSystemInfo } from '@simple-agent-manager/shared';
import { Cpu } from 'lucide-react';
import { Skeleton } from '@simple-agent-manager/ui';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';
import { ResourceBar } from './ResourceBar';

interface SystemResourcesSectionProps {
  systemInfo?: NodeSystemInfo | null;
  fallbackMetrics?: NodeMetrics | null;
  loading?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

export const SystemResourcesSection: FC<SystemResourcesSectionProps> = ({
  systemInfo,
  fallbackMetrics,
  loading,
}) => {
  // Derive values from full system info or fallback heartbeat metrics
  const cpuPercent = systemInfo
    ? (systemInfo.cpu.loadAvg1 / systemInfo.cpu.numCpu) * 100
    : fallbackMetrics?.cpuLoadAvg1 != null
      ? fallbackMetrics.cpuLoadAvg1 * 25 // rough estimate: assume 4 cores if no full info
      : null;

  const cpuDetail = systemInfo
    ? `Load: ${systemInfo.cpu.loadAvg1.toFixed(2)} / ${systemInfo.cpu.numCpu} cores (5m: ${systemInfo.cpu.loadAvg5.toFixed(2)}, 15m: ${systemInfo.cpu.loadAvg15.toFixed(2)})`
    : fallbackMetrics?.cpuLoadAvg1 != null
      ? `Load: ${fallbackMetrics.cpuLoadAvg1.toFixed(2)}`
      : undefined;

  const memPercent = systemInfo?.memory.usedPercent ?? fallbackMetrics?.memoryPercent ?? null;
  const memDetail = systemInfo
    ? `${formatBytes(systemInfo.memory.usedBytes)} / ${formatBytes(systemInfo.memory.totalBytes)}`
    : undefined;

  const diskPercent = systemInfo?.disk.usedPercent ?? fallbackMetrics?.diskPercent ?? null;
  const diskDetail = systemInfo
    ? `${formatBytes(systemInfo.disk.usedBytes)} / ${formatBytes(systemInfo.disk.totalBytes)}`
    : undefined;

  const hasData = cpuPercent != null || memPercent != null || diskPercent != null;

  return (
    <Section>
      <SectionHeader
        icon={<Cpu size={20} color="#4ade80" />}
        iconBg="rgba(34, 197, 94, 0.15)"
        title="System Resources"
        description="CPU, memory, and disk usage"
      />

      {loading && !hasData ? (
        <div style={{ display: 'flex', gap: 'var(--sam-space-6)', flexWrap: 'wrap' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ flex: 1, minWidth: 160 }}>
              <Skeleton width="60%" height={12} style={{ marginBottom: 6 }} />
              <Skeleton width="100%" height={8} />
            </div>
          ))}
        </div>
      ) : !hasData ? (
        <div style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
          No resource data available yet. Waiting for heartbeat data...
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--sam-space-6)', flexWrap: 'wrap' }}>
          {cpuPercent != null && (
            <ResourceBar
              label="CPU"
              percent={Math.min(100, cpuPercent)}
              detail={cpuDetail}
            />
          )}
          {memPercent != null && (
            <ResourceBar label="Memory" percent={memPercent} detail={memDetail} />
          )}
          {diskPercent != null && (
            <ResourceBar label="Disk" percent={diskPercent} detail={diskDetail} />
          )}
        </div>
      )}

      {systemInfo?.network && (systemInfo.network.rxBytes > 0 || systemInfo.network.txBytes > 0) && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--sam-space-6)',
            marginTop: 'var(--sam-space-4)',
            paddingTop: 'var(--sam-space-3)',
            borderTop: '1px solid var(--sam-color-border-default)',
            fontSize: 'var(--sam-type-caption-size)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          <span>
            {systemInfo.network.interface || 'Network'} RX: {formatBytes(systemInfo.network.rxBytes)}
          </span>
          <span>TX: {formatBytes(systemInfo.network.txBytes)}</span>
        </div>
      )}
    </Section>
  );
};
