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

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: 'var(--sam-space-2) var(--sam-space-3)',
  borderBottom: '1px solid var(--sam-color-border-default)',
};

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
        iconBg="rgba(251, 146, 60, 0.15)"
        title="Software"
        description="Installed versions and agent runtime"
      />

      {loading && rows.length === 0 ? (
        <div>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} style={{ ...rowStyle }}>
              <Skeleton width={120} height={14} />
              <Skeleton width={80} height={14} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
          Software version info unavailable.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            overflow: 'hidden',
          }}
        >
          {rows.map((row, i) => (
            <div
              key={row.label}
              style={{
                ...rowStyle,
                borderBottom:
                  i === rows.length - 1
                    ? 'none'
                    : '1px solid var(--sam-color-border-default)',
              }}
            >
              <span style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>
                {row.label}
              </span>
              <span
                style={{
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  color: 'var(--sam-color-fg-primary)',
                  fontFamily: 'monospace',
                }}
              >
                {row.value || 'N/A'}
                {row.detail && (
                  <span
                    style={{
                      fontSize: '0.6875rem',
                      color: 'var(--sam-color-fg-muted)',
                      fontFamily: 'inherit',
                      marginLeft: 'var(--sam-space-2)',
                    }}
                  >
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
