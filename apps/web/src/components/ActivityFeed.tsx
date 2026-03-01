import type { ActivityEventResponse } from '../lib/api';

interface ActivityFeedProps {
  events: ActivityEventResponse[];
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getEventIcon(eventType: string): string {
  if (eventType.startsWith('workspace.')) {
    switch (eventType) {
      case 'workspace.created': return '+';
      case 'workspace.stopped': return '||';
      case 'workspace.restarted': return '>';
      default: return 'W';
    }
  }
  if (eventType.startsWith('session.')) {
    return eventType === 'session.started' ? '>' : '||';
  }
  if (eventType.startsWith('task.')) {
    switch (eventType) {
      case 'task.completed': return 'v';
      case 'task.failed': return 'x';
      case 'task.in_progress': return '>';
      default: return 'T';
    }
  }
  return '*';
}

function getEventColor(eventType: string): string {
  if (eventType.includes('created') || eventType.includes('started') || eventType === 'task.completed') {
    return 'var(--sam-color-success, #2ea043)';
  }
  if (eventType.includes('stopped') || eventType === 'task.cancelled') {
    return 'var(--sam-color-fg-muted, #8b949e)';
  }
  if (eventType.includes('failed') || eventType.includes('error')) {
    return 'var(--sam-color-danger, #f85149)';
  }
  if (eventType.includes('restarted') || eventType === 'task.in_progress') {
    return 'var(--sam-color-warning, #d29922)';
  }
  return 'var(--sam-color-fg-muted, #8b949e)';
}

function formatEventDescription(event: ActivityEventResponse): string {
  const payload = event.payload as Record<string, unknown> | null;

  switch (event.eventType) {
    case 'workspace.created': {
      const name = payload?.name as string | undefined;
      return name ? `Workspace "${name}" created` : 'Workspace created';
    }
    case 'workspace.stopped':
      return 'Workspace stopped';
    case 'workspace.restarted':
      return 'Workspace restarted';
    case 'session.started': {
      const topic = payload?.topic as string | undefined;
      return topic ? `Chat session started: ${topic}` : 'Chat session started';
    }
    case 'session.stopped': {
      const msgCount = payload?.message_count as number | undefined;
      return msgCount ? `Chat session stopped (${msgCount} messages)` : 'Chat session stopped';
    }
    default:
      if (event.eventType.startsWith('task.')) {
        const title = payload?.title as string | undefined;
        const toStatus = payload?.toStatus as string | undefined;
        if (title && toStatus) {
          return `Task "${title}" ${toStatus.replace('_', ' ')}`;
        }
        return `Task ${event.eventType.replace('task.', '').replace('_', ' ')}`;
      }
      return event.eventType.replace(/\./g, ' ').replace(/_/g, ' ');
  }
}

function formatActorLabel(event: ActivityEventResponse): string {
  if (event.actorType === 'system') return 'System';
  if (event.actorType === 'workspace_callback') return 'Agent';
  if (event.actorType === 'user') return 'You';
  return event.actorType;
}

export function ActivityFeed({ events, hasMore, onLoadMore, loading }: ActivityFeedProps) {
  if (events.length === 0 && !loading) {
    return (
      <div className="text-fg-muted text-sm p-4 text-center">
        No activity yet.
      </div>
    );
  }

  return (
    <div>
      <ul className="m-0 p-0 list-none">
        {events.map((event) => {
          const color = getEventColor(event.eventType);
          return (
            <li
              key={event.id}
              className="flex gap-3 py-3 px-4 border-b border-border-default"
            >
              {/* Icon */}
              <div
                className="w-7 h-7 rounded-full text-fg-on-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"
                style={{ backgroundColor: color }}
              >
                {getEventIcon(event.eventType)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg-primary leading-snug">
                  {formatEventDescription(event)}
                </div>
                <div className="flex gap-2 text-xs text-fg-muted mt-0.5">
                  <span>{formatActorLabel(event)}</span>
                  <span className="opacity-50">-</span>
                  <span>{formatRelativeTime(event.createdAt)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div className="py-3 px-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="py-2 px-4 text-xs text-fg-primary bg-inset border border-border-default rounded-md cursor-pointer disabled:cursor-default disabled:opacity-60"
          >
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
