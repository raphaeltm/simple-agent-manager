import type { FC } from 'react';
import type { Event } from '@simple-agent-manager/shared';
import { Activity } from 'lucide-react';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';

interface NodeEventsSectionProps {
  events: Event[];
  error?: string | null;
  onRetry?: () => void;
  nodeStatus?: string;
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

const levelColors: Record<string, string> = {
  info: 'var(--sam-color-fg-muted)',
  warn: '#fbbf24',
  error: '#f87171',
};

export const NodeEventsSection: FC<NodeEventsSectionProps> = ({
  events,
  error,
  onRetry,
  nodeStatus,
}) => {
  return (
    <Section>
      <SectionHeader
        icon={<Activity size={20} color="#9fb7ae" />}
        iconBg="rgba(159, 183, 174, 0.15)"
        title="Events"
        description={`${events.length} recent event${events.length !== 1 ? 's' : ''}`}
      />

      {nodeStatus && nodeStatus !== 'running' ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
          Events are only available when the node is running.
        </div>
      ) : error ? (
        <div
          style={{
            padding: 'var(--sam-space-3)',
            backgroundColor: 'rgba(248, 113, 113, 0.1)',
            borderRadius: 'var(--sam-radius-sm)',
            border: '1px solid rgba(248, 113, 113, 0.3)',
            fontSize: '0.875rem',
            color: 'var(--sam-color-danger)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>Failed to load events: {error}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{
                padding: 'var(--sam-space-1) var(--sam-space-3)',
                fontSize: '0.75rem',
                border: '1px solid rgba(248, 113, 113, 0.3)',
                borderRadius: 'var(--sam-radius-sm)',
                backgroundColor: 'transparent',
                color: 'var(--sam-color-danger)',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          )}
        </div>
      ) : events.length === 0 ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
          No events recorded yet.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {events.map((event, i) => (
            <div
              key={event.id}
              style={{
                padding: 'var(--sam-space-2) var(--sam-space-3)',
                borderBottom:
                  i === events.length - 1
                    ? 'none'
                    : '1px solid var(--sam-color-border-default)',
                fontSize: '0.8125rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 'var(--sam-space-2)',
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color: levelColors[event.level] || 'var(--sam-color-fg-primary)',
                  }}
                >
                  {event.type}
                </span>
                <span
                  style={{
                    fontSize: '0.6875rem',
                    color: 'var(--sam-color-fg-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatEventTime(event.createdAt)}
                </span>
              </div>
              {event.message && (
                <div style={{ color: 'var(--sam-color-fg-muted)', marginTop: 2 }}>
                  {event.message}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
};
