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
  warn: 'var(--sam-color-warning-fg)',
  error: 'var(--sam-color-danger-fg)',
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
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          Events are only available when the node is running.
        </div>
      ) : error ? (
        <div
          className="p-3 bg-danger-tint rounded-sm flex justify-between items-center"
          style={{
            border: '1px solid rgba(248, 113, 113, 0.3)',
            fontSize: 'var(--sam-type-secondary-size)',
            color: 'var(--sam-color-danger)',
          }}
        >
          <span>Failed to load events: {error}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-3 py-1 rounded-sm bg-transparent cursor-pointer"
              style={{
                fontSize: 'var(--sam-type-caption-size)',
                border: '1px solid rgba(248, 113, 113, 0.3)',
                color: 'var(--sam-color-danger)',
              }}
            >
              Retry
            </button>
          )}
        </div>
      ) : events.length === 0 ? (
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          No events recorded yet.
        </div>
      ) : (
        <div className="border border-border-default rounded-md max-h-80 overflow-auto">
          {events.map((event, i) => (
            <div
              key={event.id}
              className={`px-3 py-2 ${i === events.length - 1 ? '' : 'border-b border-border-default'}`}
              style={{ fontSize: 'var(--sam-type-caption-size)' }}
            >
              <div className="flex justify-between items-center gap-2">
                <span
                  className="font-semibold"
                  style={{ color: levelColors[event.level] || 'var(--sam-color-fg-primary)' }}
                >
                  {event.type}
                </span>
                <span className="text-fg-muted whitespace-nowrap" style={{ fontSize: '0.6875rem' }}>
                  {formatEventTime(event.createdAt)}
                </span>
              </div>
              {event.message && (
                <div className="text-fg-muted mt-0.5">
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
