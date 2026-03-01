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
      <div className="flex justify-center p-6">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <>
      {/* Header with New Chat button */}
      <div className="p-3 border-b border-border-default shrink-0 flex items-center justify-between">
        <span className="text-sm font-semibold text-fg-primary">
          Chats
        </span>
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="bg-transparent border border-border-default rounded-sm px-2 py-[2px] cursor-pointer text-fg-primary text-xs font-medium"
          >
            + New
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="p-4">
          <EmptyState
            heading="No chats yet"
            description="Start a new chat to get going."
          />
        </div>
      ) : (
        <nav className="overflow-y-auto flex-1">
          {sessions.map((session) => {
            const isSelected = session.id === selectedSessionId;
            const state = getSessionState(session);
            const dotColor = STATE_COLORS[state];
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                className={`block w-full text-left p-3 border-none border-b border-border-default cursor-pointer transition-colors duration-100 ${isSelected ? 'bg-inset' : 'hover:bg-surface-hover'}`}
                style={{
                  borderLeft: isSelected
                    ? '3px solid var(--sam-color-accent-primary)'
                    : '3px solid transparent',
                }}
              >
                <div className="flex items-center gap-2 mb-[2px]">
                  {/* State dot: green (active), amber (idle), gray (terminated) */}
                  <span
                    className="inline-block w-[6px] h-[6px] rounded-full shrink-0"
                    style={{ backgroundColor: dotColor }}
                  />
                  <span className={`text-sm text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap flex-1 ${isSelected ? 'font-semibold' : 'font-medium'}`}>
                    {session.topic || `Chat ${session.id.slice(0, 8)}`}
                  </span>
                </div>
                <div
                  className="flex items-center gap-2 text-xs text-fg-muted"
                  style={{ paddingLeft: 'calc(6px + var(--sam-space-2))' }}
                >
                  <span style={{ color: dotColor }} className="font-medium">
                    {STATE_LABELS[state]}
                  </span>
                  <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
                  <span className="ml-auto">{formatRelativeTime(session.startedAt)}</span>
                </div>
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
};
