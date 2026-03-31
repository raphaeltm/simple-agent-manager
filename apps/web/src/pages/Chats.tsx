import { useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { PageLayout, EmptyState, SkeletonCard, Alert } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { useAllChatSessions } from '../hooks/useAllChatSessions';
import {
  getSessionState,
  isStaleSession,
  getLastActivity,
  formatRelativeTime,
  STATE_COLORS,
  STATE_LABELS,
} from '../lib/chat-session-utils';

export function Chats() {
  const navigate = useNavigate();
  const { sessions, loading, error, refresh } = useAllChatSessions();

  // Filter to non-stale sessions
  const activeSessions = sessions.filter((s) => !isStaleSession(s));

  return (
    <PageLayout title="Chats" maxWidth="xl" headerRight={<UserMenu />}>
      {error && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => void refresh()}>
            {error}
          </Alert>
        </div>
      )}

      {loading && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      )}

      {!loading && activeSessions.length === 0 && !error && (
        <EmptyState
          icon={<MessageSquare size={32} />}
          heading="No active chats"
          description="Start a conversation from any project to see it here."
        />
      )}

      {!loading && activeSessions.length > 0 && (
        <div className="flex flex-col gap-1">
          {activeSessions.map((session) => {
            const state = getSessionState(session);
            const dotColor = STATE_COLORS[state];
            const stateLabel = STATE_LABELS[state];
            const topic = session.topic || 'Untitled Chat';
            const lastActivity = getLastActivity(session);

            return (
              <button
                key={session.id}
                onClick={() =>
                  navigate(`/projects/${session.projectId}/chat/${session.id}`)
                }
                className="flex items-center gap-3 w-full px-4 py-3 bg-transparent border border-border-default rounded-md text-left cursor-pointer hover:bg-surface-hover transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {/* State dot */}
                <span
                  className="shrink-0 w-2 h-2 rounded-full"
                  style={{ backgroundColor: dotColor }}
                  title={stateLabel}
                />

                {/* Topic + project */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-fg-primary m-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {topic}
                  </p>
                  <p className="text-xs text-fg-muted m-0 mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
                    {session.projectName}
                  </p>
                </div>

                {/* State badge */}
                <span
                  className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm"
                  style={{
                    color: dotColor,
                    backgroundColor:
                      state === 'active'
                        ? 'var(--sam-color-success-tint, rgba(34, 197, 94, 0.1))'
                        : state === 'idle'
                          ? 'var(--sam-color-warning-tint, rgba(245, 158, 11, 0.1))'
                          : 'var(--sam-color-surface-hover)',
                  }}
                >
                  {stateLabel}
                </span>

                {/* Relative time */}
                <span className="shrink-0 text-xs text-fg-muted whitespace-nowrap">
                  {formatRelativeTime(lastActivity)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </PageLayout>
  );
}
