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
      <div style={{
        color: 'var(--sam-color-fg-muted)',
        fontSize: '0.875rem',
        padding: 'var(--sam-space-4)',
        textAlign: 'center',
      }}>
        No activity yet.
      </div>
    );
  }

  return (
    <div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {events.map((event) => {
          const color = getEventColor(event.eventType);
          return (
            <li
              key={event.id}
              style={{
                display: 'flex',
                gap: 'var(--sam-space-3)',
                padding: 'var(--sam-space-3) var(--sam-space-4)',
                borderBottom: '1px solid var(--sam-color-border-default)',
              }}
            >
              {/* Icon */}
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                backgroundColor: color,
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.7rem',
                fontWeight: 700,
                flexShrink: 0,
                marginTop: '2px',
              }}>
                {getEventIcon(event.eventType)}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '0.875rem',
                  color: 'var(--sam-color-fg-primary)',
                  lineHeight: 1.4,
                }}>
                  {formatEventDescription(event)}
                </div>
                <div style={{
                  display: 'flex',
                  gap: 'var(--sam-space-2)',
                  fontSize: '0.75rem',
                  color: 'var(--sam-color-fg-muted)',
                  marginTop: '2px',
                }}>
                  <span>{formatActorLabel(event)}</span>
                  <span style={{ opacity: 0.5 }}>-</span>
                  <span>{formatRelativeTime(event.createdAt)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div style={{ padding: 'var(--sam-space-3) var(--sam-space-4)', textAlign: 'center' }}>
          <button
            onClick={onLoadMore}
            disabled={loading}
            style={{
              padding: 'var(--sam-space-2) var(--sam-space-4)',
              fontSize: '0.8rem',
              color: 'var(--sam-color-fg-primary)',
              backgroundColor: 'var(--sam-color-bg-inset)',
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radii-md, 6px)',
              cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
