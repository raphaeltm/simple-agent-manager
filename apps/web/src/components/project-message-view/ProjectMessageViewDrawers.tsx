import type { MessageCommentAction } from '../../lib/api/comments';
import { ChatTimelineDrawer } from '../chat/ChatTimelineDrawer';
import { SessionCommentsDrawer } from '../chat/SessionCommentsDrawer';
import { SessionResourceHistoryDrawer } from '../chat/SessionResourceHistoryDrawer';
import type { CommentInboxItem } from './comments/comment-inbox';
import type { TimelineEntry, TimelineJumpTarget } from './timeline-types';

export function ProjectMessageViewDrawers({
  showTimeline,
  projectId,
  sessionId,
  timelineEntries,
  timelineLoading,
  showTimelineContext,
  onToggleTimelineContext,
  onCloseTimeline,
  showResources,
  onCloseResources,
  showComments,
  commentItems,
  commentsLoading,
  viewerId,
  canWriteSession,
  onCloseComments,
  onJump,
  onReply,
  onResolve,
  onReopen,
  onSendToAgent,
}: Readonly<{
  showTimeline: boolean;
  projectId: string;
  sessionId: string;
  timelineEntries: TimelineEntry[];
  timelineLoading: boolean;
  showTimelineContext: boolean;
  onToggleTimelineContext: () => void;
  onCloseTimeline: () => void;
  showResources: boolean;
  onCloseResources: () => void;
  showComments: boolean;
  commentItems: CommentInboxItem[];
  commentsLoading: boolean;
  viewerId: string | null;
  canWriteSession: boolean;
  onCloseComments: () => void;
  onJump: (target: TimelineJumpTarget) => void;
  onReply: (threadId: string, body: string, action: MessageCommentAction) => Promise<unknown>;
  onResolve: (threadId: string) => Promise<unknown>;
  onReopen: (threadId: string) => Promise<unknown>;
  onSendToAgent: (threadId: string) => Promise<unknown>;
}>) {
  return (
    <>
      {showTimeline && (
        <ChatTimelineDrawer
          entries={timelineEntries}
          loading={timelineLoading}
          showContext={showTimelineContext}
          onToggleContext={onToggleTimelineContext}
          onClose={onCloseTimeline}
          onJump={onJump}
        />
      )}

      {showResources && (
        <SessionResourceHistoryDrawer
          projectId={projectId}
          sessionId={sessionId}
          onClose={onCloseResources}
        />
      )}

      {showComments && (
        <SessionCommentsDrawer
          items={commentItems}
          loading={commentsLoading}
          viewerId={viewerId}
          onClose={onCloseComments}
          onJump={onJump}
          onReply={onReply}
          onResolve={onResolve}
          onReopen={onReopen}
          onSendToAgent={canWriteSession ? onSendToAgent : undefined}
        />
      )}
    </>
  );
}
