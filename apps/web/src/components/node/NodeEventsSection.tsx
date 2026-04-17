import type { Event } from '@simple-agent-manager/shared';
import { Activity, Download } from 'lucide-react';
import { type FC, useCallback, useState } from 'react';

import { downloadNodeDebugPackage, downloadNodeEvents, downloadNodeMetrics } from '../../lib/api/nodes';
import { Section } from './Section';
import { SectionHeader } from './SectionHeader';

interface NodeEventsSectionProps {
  events: Event[];
  error?: string | null;
  onRetry?: () => void;
  nodeStatus?: string;
  nodeId?: string;
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
  nodeId,
}) => {
  const [downloading, setDownloading] = useState<'events' | 'metrics' | 'debug' | null>(null);

  const handleDownloadEvents = useCallback(async () => {
    if (!nodeId || downloading) return;
    setDownloading('events');
    try {
      await downloadNodeEvents(nodeId);
    } catch {
      // Best-effort download — error is visible from browser download UI
    } finally {
      setDownloading(null);
    }
  }, [nodeId, downloading]);

  const handleDownloadMetrics = useCallback(async () => {
    if (!nodeId || downloading) return;
    setDownloading('metrics');
    try {
      await downloadNodeMetrics(nodeId);
    } catch {
      // Best-effort download
    } finally {
      setDownloading(null);
    }
  }, [nodeId, downloading]);

  const handleDownloadDebugPackage = useCallback(async () => {
    if (!nodeId || downloading) return;
    setDownloading('debug');
    try {
      await downloadNodeDebugPackage(nodeId);
    } catch {
      // Best-effort download
    } finally {
      setDownloading(null);
    }
  }, [nodeId, downloading]);

  const isRunning = nodeStatus === 'running';

  return (
    <Section>
      <SectionHeader
        icon={<Activity size={20} color="#9fb7ae" />}
        iconBg="rgba(159, 183, 174, 0.15)"
        title="Events"
        description={`${events.length} recent event${events.length !== 1 ? 's' : ''}`}
        actions={
          isRunning && nodeId ? (
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={handleDownloadDebugPackage}
                disabled={downloading !== null}
                className="flex items-center gap-1 px-2 py-1 rounded-sm cursor-pointer disabled:opacity-50"
                style={{
                  fontSize: 'var(--sam-type-caption-size)',
                  border: '1px solid var(--sam-color-accent-emphasis)',
                  color: 'var(--sam-color-accent-fg)',
                  background: 'var(--sam-color-accent-subtle)',
                }}
                title="Download all logs, metrics, events, and system info as a tar.gz archive"
              >
                <Download size={12} />
                {downloading === 'debug' ? 'Packaging...' : 'Debug Package'}
              </button>
              <button
                onClick={handleDownloadEvents}
                disabled={downloading !== null}
                className="flex items-center gap-1 px-2 py-1 rounded-sm bg-transparent cursor-pointer disabled:opacity-50"
                style={{
                  fontSize: 'var(--sam-type-caption-size)',
                  border: '1px solid var(--sam-color-border-default)',
                  color: 'var(--sam-color-fg-muted)',
                }}
                title="Download events database"
              >
                <Download size={12} />
                {downloading === 'events' ? 'Downloading...' : 'Events DB'}
              </button>
              <button
                onClick={handleDownloadMetrics}
                disabled={downloading !== null}
                className="flex items-center gap-1 px-2 py-1 rounded-sm bg-transparent cursor-pointer disabled:opacity-50"
                style={{
                  fontSize: 'var(--sam-type-caption-size)',
                  border: '1px solid var(--sam-color-border-default)',
                  color: 'var(--sam-color-fg-muted)',
                }}
                title="Download metrics database"
              >
                <Download size={12} />
                {downloading === 'metrics' ? 'Downloading...' : 'Metrics DB'}
              </button>
            </div>
          ) : undefined
        }
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
