import type { NodeMetrics, NodeSystemInfo } from '@simple-agent-manager/shared';
import { Skeleton } from '@simple-agent-manager/ui';
import { Cpu } from 'lucide-react';
import type { FC } from 'react';

import { formatFileSize } from '../../lib/file-utils';
import { ResourceBar } from './ResourceBar';
import { Section } from './Section';
import { SectionHeader } from './SectionHeader';

interface SystemResourcesSectionProps {
  systemInfo?: NodeSystemInfo | null;
  fallbackMetrics?: NodeMetrics | null;
  loading?: boolean;
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
    ? `${formatFileSize(systemInfo.memory.usedBytes)} / ${formatFileSize(systemInfo.memory.totalBytes)}`
    : undefined;

  const diskPercent = systemInfo?.disk.usedPercent ?? fallbackMetrics?.diskPercent ?? null;
  const diskDetail = systemInfo
    ? `${formatFileSize(systemInfo.disk.usedBytes)} / ${formatFileSize(systemInfo.disk.totalBytes)}`
    : undefined;

  const hasData = cpuPercent != null || memPercent != null || diskPercent != null;

  return (
    <Section>
      <SectionHeader
        icon={<Cpu size={20} color="var(--sam-color-success-fg)" />}
        iconBg="var(--sam-color-success-tint)"
        title="System Resources"
        description="CPU, memory, and disk usage"
      />

      {loading && !hasData ? (
        <div className="flex gap-6 flex-wrap">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex-1 min-w-40">
              <Skeleton width="60%" height={12} style={{ marginBottom: 6 }} />
              <Skeleton width="100%" height={8} />
            </div>
          ))}
        </div>
      ) : !hasData ? (
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          No resource data available yet. Waiting for heartbeat data...
        </div>
      ) : (
        <div className="flex gap-6 flex-wrap">
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
        <div className="flex gap-6 mt-4 pt-3 border-t border-border-default text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
          <span>
            {systemInfo.network.interface || 'Network'} RX: {formatFileSize(systemInfo.network.rxBytes)}
          </span>
          <span>TX: {formatFileSize(systemInfo.network.txBytes)}</span>
        </div>
      )}
    </Section>
  );
};
