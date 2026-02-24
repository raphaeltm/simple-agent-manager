import { type FC } from 'react';
import { EmptyState, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import type { ChatSessionResponse } from '../../lib/api';

interface SessionSidebarProps {
  sessions: ChatSessionResponse[];
  selectedSessionId: string | null;
  loading: boolean;
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

export const SessionSidebar: FC<SessionSidebarProps> = ({
  sessions,
  selectedSessionId,
  loading,
  onSelect,
}) => {
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-6)' }}>
        <Spinner size="md" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div style={{ padding: 'var(--sam-space-4)' }}>
        <EmptyState
          heading="No sessions yet"
          description="Sessions appear here when tasks run or workspaces connect."
        />
      </div>
    );
  }

  return (
    <>
      <style>{`
        .session-item:hover { background-color: var(--sam-color-bg-surface-hover); }
      `}</style>
      <nav style={{ overflowY: 'auto', flex: 1 }}>
        {sessions.map((session) => {
          const isSelected = session.id === selectedSessionId;
          const isActive = session.status === 'active';
          return (
            <button
              key={session.id}
              type="button"
              className={isSelected ? '' : 'session-item'}
              onClick={() => onSelect(session.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: 'var(--sam-space-3) var(--sam-space-3)',
                backgroundColor: isSelected ? 'var(--sam-color-bg-inset)' : 'transparent',
                border: 'none',
                borderLeft: isSelected
                  ? '3px solid var(--sam-color-accent-primary)'
                  : '3px solid transparent',
                borderBottom: '1px solid var(--sam-color-border-default)',
                cursor: 'pointer',
                transition: 'background-color 0.1s',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sam-space-2)',
                marginBottom: '2px',
              }}>
                {isActive && (
                  <span style={{
                    display: 'inline-block',
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--sam-color-success)',
                    flexShrink: 0,
                  }} />
                )}
                <span style={{
                  fontSize: 'var(--sam-type-secondary-size)',
                  fontWeight: isSelected ? 600 : 500,
                  color: 'var(--sam-color-fg-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}>
                  {session.topic || `Session ${session.id.slice(0, 8)}`}
                </span>
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sam-space-2)',
                fontSize: 'var(--sam-type-caption-size)',
                color: 'var(--sam-color-fg-muted)',
              }}>
                <StatusBadge
                  status={isActive ? 'running' : 'stopped'}
                  label={session.status}
                />
                <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
                <span style={{ marginLeft: 'auto' }}>{formatRelativeTime(session.startedAt)}</span>
              </div>
            </button>
          );
        })}
      </nav>
    </>
  );
};
