import { useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { PageLayout, EmptyState, SkeletonList, Alert } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { useAllChatSessions } from '../hooks/useAllChatSessions';
import {
  getSessionState,
  isStaleSession,
  isActiveSession,
  getLastActivity,
  formatRelativeTime,
  STATE_COLORS,
  STATE_LABELS,
  STATE_BADGE_BG,
} from '../lib/chat-session-utils';

export function Chats() {
  const navigate = useNavigate();
  const { sessions, loading, error, refresh } = useAllChatSessions();

  // Only show sessions that are recent (not stale) and not stopped
  const activeSessions = sessions.filter((s) => !isStaleSession(s) && isActiveSession(s));

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
        // Row skeletons match the actual compact row height of session items
        <SkeletonList count={5} variant="row" />
      )}

      {!loading && activeSessions.length === 0 && !error && (
        <EmptyState
          icon={<MessageSquare size={32} />}
          heading="No active chats"
          description="Start a conversation from any project to see it here."
        />
      )}

      {!loading && activeSessions.length > 0 && (
        <div
          className="flex flex-col gap-1"
          role="list"
          aria-label="Active chat sessions"
        >
          {activeSessions.map((session) => {
            const state = getSessionState(session);
            const dotColor = STATE_COLORS[state];
            const stateLabel = STATE_LABELS[state];
            const badgeBg = STATE_BADGE_BG[state];
            const topic = session.topic || 'Untitled Chat';
            const lastActivity = getLastActivity(session);

            return (
              <button
                key={session.id}
                role="listitem"
                onClick={() =>
                  navigate(`/projects/${session.projectId}/chat/${session.id}`)
                }
                aria-label={`${topic}, ${session.projectName}, ${stateLabel}, ${formatRelativeTime(lastActivity)}`}
                className="flex items-center gap-3 w-full px-4 py-3 bg-transparent border border-border-default rounded-md text-left cursor-pointer hover:bg-surface-hover transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {/* State dot — decorative; label carried by aria-label on the button */}
                <span
                  aria-hidden="true"
                  className="shrink-0 w-2 h-2 rounded-full"
                  style={{ backgroundColor: dotColor }}
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

                {/* State badge — decorative; state announced via aria-label */}
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm"
                  style={{ color: dotColor, backgroundColor: badgeBg }}
                >
                  {stateLabel}
                </span>

                {/* Relative time — decorative; announced via aria-label */}
                <span aria-hidden="true" className="shrink-0 text-xs text-fg-muted whitespace-nowrap">
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
