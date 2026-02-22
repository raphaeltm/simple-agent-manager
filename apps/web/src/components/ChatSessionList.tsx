import { StatusBadge } from '@simple-agent-manager/ui';
import type { ChatSessionResponse } from '../lib/api';

interface ChatSessionListProps {
  sessions: ChatSessionResponse[];
  onSelect: (sessionId: string) => void;
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

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const diff = end - startedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function ChatSessionList({ sessions, onSelect }: ChatSessionListProps) {
  if (sessions.length === 0) {
    return (
      <div style={{
        color: 'var(--sam-color-fg-muted)',
        fontSize: '0.875rem',
        padding: 'var(--sam-space-4)',
        textAlign: 'center',
      }}>
        No chat sessions yet.
      </div>
    );
  }

  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '1px' }}>
      {sessions.map((session) => (
        <li
          key={session.id}
          onClick={() => onSelect(session.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sam-space-3)',
            padding: 'var(--sam-space-3) var(--sam-space-4)',
            cursor: 'pointer',
            borderBottom: '1px solid var(--sam-color-border-default)',
            transition: 'background-color 0.1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--sam-color-bg-inset)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sam-space-2)',
              marginBottom: '2px',
            }}>
              <span style={{
                fontSize: '0.875rem',
                fontWeight: 500,
                color: 'var(--sam-color-fg-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {session.topic || `Session ${session.id.slice(0, 8)}`}
              </span>
              <StatusBadge
                status={session.status === 'active' ? 'running' : session.status === 'error' ? 'error' : 'stopped'}
                label={session.status}
              />
            </div>
            <div style={{
              display: 'flex',
              gap: 'var(--sam-space-3)',
              fontSize: '0.75rem',
              color: 'var(--sam-color-fg-muted)',
            }}>
              <span>{session.messageCount} message{session.messageCount !== 1 ? 's' : ''}</span>
              <span>{formatDuration(session.startedAt, session.endedAt)}</span>
            </div>
          </div>
          <span style={{
            fontSize: '0.75rem',
            color: 'var(--sam-color-fg-muted)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}>
            {formatRelativeTime(session.startedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
