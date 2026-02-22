import type { FC } from 'react';
import type { NodeSystemInfo } from '@simple-agent-manager/shared';
import { Container } from 'lucide-react';
import { Skeleton } from '@simple-agent-manager/ui';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';

interface DockerSectionProps {
  docker?: NodeSystemInfo['docker'] | null;
  loading?: boolean;
}

const cellStyle: React.CSSProperties = {
  padding: 'var(--sam-space-2) var(--sam-space-3)',
  fontSize: 'var(--sam-type-caption-size)',
  color: 'var(--sam-color-fg-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const headerCellStyle: React.CSSProperties = {
  ...cellStyle,
  fontSize: '0.6875rem',
  fontWeight: 600,
  color: 'var(--sam-color-fg-muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
};

export const DockerSection: FC<DockerSectionProps> = ({ docker, loading }) => {
  return (
    <Section>
      <SectionHeader
        icon={<Container size={20} color="#a78bfa" />}
        iconBg="rgba(167, 139, 250, 0.15)"
        title="Docker"
        description={
          docker?.version
            ? `Engine v${docker.version} \u00b7 ${docker.containers} container${docker.containers !== 1 ? 's' : ''}`
            : 'Container runtime information'
        }
      />

      {loading && !docker ? (
        <div>
          <Skeleton width="100%" height={32} style={{ marginBottom: 4 }} />
          <Skeleton width="100%" height={32} style={{ marginBottom: 4 }} />
          <Skeleton width="100%" height={32} />
        </div>
      ) : !docker || !docker.containerList || docker.containerList.length === 0 ? (
        <div style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
          {docker ? 'No running containers.' : 'Docker info unavailable.'}
        </div>
      ) : (
        <div
          style={{
            overflowX: 'auto',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              minWidth: 500,
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--sam-color-border-default)' }}>
                <th style={{ ...headerCellStyle, textAlign: 'left' }}>Container</th>
                <th style={{ ...headerCellStyle, textAlign: 'left' }}>Image</th>
                <th style={{ ...headerCellStyle, textAlign: 'left' }}>Status</th>
                <th style={{ ...headerCellStyle, textAlign: 'right' }}>CPU</th>
                <th style={{ ...headerCellStyle, textAlign: 'right' }}>Memory</th>
              </tr>
            </thead>
            <tbody>
              {docker.containerList.map((container) => (
                <tr
                  key={container.id}
                  style={{ borderBottom: '1px solid var(--sam-color-border-default)' }}
                >
                  <td style={{ ...cellStyle, fontFamily: 'monospace', maxWidth: 180 }}>
                    {container.name}
                  </td>
                  <td
                    style={{ ...cellStyle, maxWidth: 240 }}
                    title={container.image}
                  >
                    {container.image}
                  </td>
                  <td style={cellStyle}>{container.status}</td>
                  <td style={{ ...cellStyle, textAlign: 'right', fontFamily: 'monospace' }}>
                    {container.cpuPercent.toFixed(1)}%
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>
                    <span style={{ fontFamily: 'monospace' }}>
                      {container.memPercent.toFixed(1)}%
                    </span>
                    <span
                      style={{
                        fontSize: '0.6875rem',
                        color: 'var(--sam-color-fg-muted)',
                        marginLeft: 'var(--sam-space-1)',
                      }}
                    >
                      ({container.memUsage})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
};
