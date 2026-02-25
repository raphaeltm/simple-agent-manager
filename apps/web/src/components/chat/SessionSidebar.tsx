import { type FC } from 'react';
import { EmptyState, Spinner } from '@simple-agent-manager/ui';
import type { ChatSessionResponse } from '../../lib/api';

interface SessionSidebarProps {
  sessions: ChatSessionResponse[];
  selectedSessionId: string | null;
  loading: boolean;
  onSelect: (sessionId: string) => void;
  onNewChat?: () => void;
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

type SessionState = 'active' | 'idle' | 'terminated';

function getSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  // If the session has agentCompletedAt set, it's idle (agent done, workspace alive)
  const s = session as ChatSessionResponse & { agentCompletedAt?: number | null; isIdle?: boolean };
  if (s.isIdle || s.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

const STATE_COLORS: Record<SessionState, string> = {
  active: 'var(--sam-color-success)',     // green
  idle: 'var(--sam-color-warning, #f59e0b)', // amber
  terminated: 'var(--sam-color-fg-muted)',    // gray
};

const STATE_LABELS: Record<SessionState, string> = {
  active: 'Active',
  idle: 'Idle',
  terminated: 'Stopped',
};

export const SessionSidebar: FC<SessionSidebarProps> = ({
  sessions,
  selectedSessionId,
  loading,
  onSelect,
  onNewChat,
}) => {
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-6)' }}>
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <>
      <style>{`
        .session-item:hover { background-color: var(--sam-color-bg-surface-hover); }
      `}</style>

      {/* Header with New Chat button */}
      <div style={{
        padding: 'var(--sam-space-3)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: 'var(--sam-type-secondary-size)',
          fontWeight: 600,
          color: 'var(--sam-color-fg-primary)',
        }}>
          Chats
        </span>
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            style={{
              background: 'none',
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-sm)',
              padding: '2px 8px',
              cursor: 'pointer',
              color: 'var(--sam-color-fg-primary)',
              fontSize: 'var(--sam-type-caption-size)',
              fontWeight: 500,
            }}
          >
            + New
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div style={{ padding: 'var(--sam-space-4)' }}>
          <EmptyState
            heading="No chats yet"
            description="Start a new chat to get going."
          />
        </div>
      ) : (
        <nav style={{ overflowY: 'auto', flex: 1 }}>
          {sessions.map((session) => {
            const isSelected = session.id === selectedSessionId;
            const state = getSessionState(session);
            const dotColor = STATE_COLORS[state];
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
                  padding: 'var(--sam-space-3)',
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
                  {/* State dot: green (active), amber (idle), gray (terminated) */}
                  <span style={{
                    display: 'inline-block',
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: dotColor,
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 'var(--sam-type-secondary-size)',
                    fontWeight: isSelected ? 600 : 500,
                    color: 'var(--sam-color-fg-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {session.topic || `Chat ${session.id.slice(0, 8)}`}
                  </span>
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sam-space-2)',
                  fontSize: 'var(--sam-type-caption-size)',
                  color: 'var(--sam-color-fg-muted)',
                  paddingLeft: 'calc(6px + var(--sam-space-2))',
                }}>
                  <span style={{ color: dotColor, fontWeight: 500 }}>
                    {STATE_LABELS[state]}
                  </span>
                  <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
                  <span style={{ marginLeft: 'auto' }}>{formatRelativeTime(session.startedAt)}</span>
                </div>
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
};
