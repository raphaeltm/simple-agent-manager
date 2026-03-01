import type { FC } from 'react';
import type { NodeSystemInfo } from '@simple-agent-manager/shared';
import { Package } from 'lucide-react';
import { Skeleton } from '@simple-agent-manager/ui';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';

interface SoftwareSectionProps {
  software?: NodeSystemInfo['software'] | null;
  agent?: NodeSystemInfo['agent'] | null;
  loading?: boolean;
}

interface VersionRow {
  label: string;
  value: string | undefined;
  detail?: string;
}

export const SoftwareSection: FC<SoftwareSectionProps> = ({ software, agent, loading }) => {
  const rows: VersionRow[] = [];

  if (agent) {
    rows.push({
      label: 'VM Agent',
      value: agent.version,
      detail: agent.buildDate !== 'unknown' ? `Built ${agent.buildDate}` : undefined,
    });
  }

  if (software) {
    if (software.goVersion) rows.push({ label: 'Go Runtime', value: software.goVersion });
    if (software.nodeVersion) rows.push({ label: 'Node.js', value: software.nodeVersion });
    if (software.dockerVersion) rows.push({ label: 'Docker', value: software.dockerVersion });
    if (software.devcontainerCliVersion) {
      rows.push({ label: 'DevContainer CLI', value: software.devcontainerCliVersion });
    }
  }

  if (agent && agent.goroutines > 0) {
    rows.push({
      label: 'Agent Goroutines',
      value: String(agent.goroutines),
    });
    rows.push({
      label: 'Agent Heap',
      value: formatBytes(agent.heapBytes),
    });
  }

  return (
    <Section>
      <SectionHeader
        icon={<Package size={20} color="#fb923c" />}
        iconBg="var(--sam-color-warning-tint)"
        title="Software"
        description="Installed versions and agent runtime"
      />

      {loading && rows.length === 0 ? (
        <div>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex justify-between items-center px-3 py-2 border-b border-border-default">
              <Skeleton width={120} height={14} />
              <Skeleton width={80} height={14} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          Software version info unavailable.
        </div>
      ) : (
        <div className="border border-border-default rounded-md overflow-hidden">
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={`flex justify-between items-center px-3 py-2 ${
                i === rows.length - 1 ? '' : 'border-b border-border-default'
              }`}
            >
              <span className="text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                {row.label}
              </span>
              <span className="text-fg-primary font-medium font-mono" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                {row.value || 'N/A'}
                {row.detail && (
                  <span className="text-fg-muted ml-2" style={{ fontSize: '0.6875rem', fontFamily: 'inherit' }}>
                    {row.detail}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, Math.min(i, units.length - 1));
  return `${val.toFixed(1)} ${units[Math.min(i, units.length - 1)]}`;
}
