import type { NodeSystemInfo } from '@simple-agent-manager/shared';
import { Skeleton } from '@simple-agent-manager/ui';
import { Container } from 'lucide-react';
import type { FC } from 'react';

import { Section } from './Section';
import { SectionHeader } from './SectionHeader';

interface DockerSectionProps {
  docker?: NodeSystemInfo['docker'] | null;
  loading?: boolean;
}

function stateStyle(state: string): React.CSSProperties {
  switch (state) {
    case 'running':
      return { color: 'var(--sam-node-live-fg)', backgroundColor: 'var(--sam-node-success-tint)' };
    case 'exited':
      return { color: 'var(--sam-color-fg-muted)', backgroundColor: 'var(--sam-node-neutral-tint)' };
    case 'paused':
      return { color: 'var(--sam-node-warning-fg)', backgroundColor: 'var(--sam-node-warning-tint)' };
    case 'restarting':
      return { color: 'var(--sam-node-info-fg)', backgroundColor: 'var(--sam-node-info-tint)' };
    case 'dead':
      return { color: 'var(--sam-node-danger-fg)', backgroundColor: 'var(--sam-node-danger-tint)' };
    default:
      return { color: 'var(--sam-color-fg-muted)', backgroundColor: 'var(--sam-node-neutral-tint-subtle)' };
  }
}

export const DockerSection: FC<DockerSectionProps> = ({ docker, loading }) => {
  return (
    <Section>
      <SectionHeader
        icon={<Container size={20} color="var(--sam-node-purple-fg)" />}
        iconBg="var(--sam-node-purple-tint)"
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
      ) : docker?.error ? (
        <div
          className="p-3 rounded-md"
          style={{
            fontSize: 'var(--sam-type-secondary-size)',
            color: 'var(--sam-node-danger-fg)',
            backgroundColor: 'var(--sam-node-danger-tint-subtle)',
            border: '1px solid var(--sam-node-danger-border)',
          }}
        >
          Failed to query Docker: {docker.error}
        </div>
      ) : !docker || !docker.containerList || docker.containerList.length === 0 ? (
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          {docker ? 'No containers.' : 'Docker info unavailable.'}
        </div>
      ) : (
        <div className="overflow-x-auto border border-border-default rounded-md">
          <table className="w-full border-collapse" style={{ minWidth: 500 }}>
            <thead>
              <tr className="border-b border-border-default">
                <th className="px-3 py-2 text-left text-fg-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.6875rem', letterSpacing: '0.05em' }}>Container</th>
                <th className="px-3 py-2 text-left text-fg-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.6875rem', letterSpacing: '0.05em' }}>Image</th>
                <th className="px-3 py-2 text-left text-fg-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.6875rem', letterSpacing: '0.05em' }}>State</th>
                <th className="px-3 py-2 text-left text-fg-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.6875rem', letterSpacing: '0.05em' }}>Status</th>
                <th className="px-3 py-2 text-right text-fg-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.6875rem', letterSpacing: '0.05em' }}>CPU</th>
                <th className="px-3 py-2 text-right text-fg-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.6875rem', letterSpacing: '0.05em' }}>Memory</th>
              </tr>
            </thead>
            <tbody>
              {docker.containerList.map((container) => (
                <tr
                  key={container.id}
                  className="border-b border-border-default"
                >
                  <td className="px-3 py-2 text-fg-primary font-mono whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px]" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                    {container.name}
                  </td>
                  <td
                    className="px-3 py-2 text-fg-primary whitespace-nowrap overflow-hidden text-ellipsis max-w-60"
                    title={container.image}
                    style={{ fontSize: 'var(--sam-type-caption-size)' }}
                  >
                    {container.image}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                    <span
                      className="inline-block rounded-sm uppercase font-semibold"
                      style={{
                        padding: '1px 6px',
                        fontSize: '0.625rem',
                        letterSpacing: '0.04em',
                        ...stateStyle(container.state),
                      }}
                    >
                      {container.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg-primary whitespace-nowrap overflow-hidden text-ellipsis" style={{ fontSize: 'var(--sam-type-caption-size)' }}>{container.status}</td>
                  <td className="px-3 py-2 text-right text-fg-primary font-mono whitespace-nowrap" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                    {container.state === 'running' ? `${container.cpuPercent.toFixed(1)}%` : '\u2014'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                    {container.state === 'running' ? (
                      <>
                        <span className="font-mono text-fg-primary">
                          {container.memPercent.toFixed(1)}%
                        </span>
                        {container.memUsage && (
                          <span className="text-fg-muted ml-1" style={{ fontSize: '0.6875rem' }}>
                            ({container.memUsage})
                          </span>
                        )}
                      </>
                    ) : (
                      '\u2014'
                    )}
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
