import type { TaskStatusEvent } from '@simple-agent-manager/shared';

import { timeAgo } from '../../lib/time-utils';

interface TaskLifecycleTimelineProps {
  events: TaskStatusEvent[];
  loading: boolean;
  error: string | null;
}

const ACTOR_LABELS: Record<string, string> = {
  system: 'system',
  user: 'user',
  agent: 'agent',
  parent_task: 'parent',
  trigger: 'trigger',
  cron: 'cron',
};

const STATUS_COLORS: Record<string, string> = {
  failed: 'var(--sam-color-danger)',
  cancelled: 'var(--sam-color-fg-muted)',
  completed: 'var(--sam-color-success)',
  in_progress: 'var(--sam-color-accent-primary)',
  queued: 'var(--sam-color-warning)',
  delegated: 'var(--sam-color-accent-primary)',
  ready: 'var(--sam-color-fg-muted)',
  draft: 'var(--sam-color-fg-muted)',
};

/**
 * Presentational lifecycle timeline. The parent (FailureCard) owns the
 * events fetch so the same data feeds both this view and the copyable
 * debug report.
 */
export function TaskLifecycleTimeline({ events, loading, error }: TaskLifecycleTimelineProps) {
  if (loading) {
    return (
      <div className="py-2 text-[11px] text-fg-muted animate-pulse">Loading timeline...</div>
    );
  }

  if (error) {
    return (
      <div className="py-2 text-[11px] text-danger">{error}</div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="py-2 text-[11px] text-fg-muted">No lifecycle events recorded.</div>
    );
  }

  return (
    <div className="flex flex-col gap-0" role="list" aria-label="Task lifecycle timeline">
      {events.map((ev, i) => {
        const isLast = i === events.length - 1;
        const isFailed = ev.toStatus === 'failed';
        const dotColor = STATUS_COLORS[ev.toStatus] ?? 'var(--sam-color-fg-muted)';

        return (
          <div key={ev.id} className="flex gap-2 min-h-[28px]" role="listitem">
            {/* Timeline track */}
            <div className="flex flex-col items-center w-3 shrink-0">
              <div
                className="w-2 h-2 rounded-full shrink-0 mt-[6px]"
                style={{ backgroundColor: dotColor }}
              />
              {!isLast && (
                <div className="w-px flex-1 min-h-[12px] bg-border-default opacity-40" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pb-1">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span
                  className="text-[11px] font-medium"
                  style={{ color: isFailed ? 'var(--sam-color-danger-fg)' : 'var(--sam-color-fg-primary)' }}
                >
                  {ev.toStatus.replace('_', ' ')}
                </span>
                {ev.actorType && ev.actorType !== 'system' && (
                  <span className="text-[10px] text-fg-muted">
                    by {ACTOR_LABELS[ev.actorType] ?? ev.actorType}
                  </span>
                )}
                <span className="text-[10px] text-fg-muted ml-auto shrink-0">
                  {timeAgo(ev.createdAt)}
                </span>
              </div>
              {ev.reason && (
                <p
                  className="text-[11px] text-fg-muted mt-0.5 break-words m-0 leading-snug"
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {ev.reason.length > 200 ? `${ev.reason.slice(0, 200)}...` : ev.reason}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { type TaskStatusEvent };
