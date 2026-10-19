import type { CommentMention } from '@simple-agent-manager/shared';
import { useMemo } from 'react';

import type { MessageCommentAction } from '../../lib/api/comments';
import { ChatTimelineDrawer } from '../chat/ChatTimelineDrawer';
import { apiResourceHistorySource } from '../chat/resource-timeline/resource-source';
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
  canSendToAgent,
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
  /** Session owner or grantee: the only viewers offered Send to agent. */
  canSendToAgent: boolean;
  onCloseComments: () => void;
  onJump: (target: TimelineJumpTarget) => void;
  onReply: (
    threadId: string,
    body: string,
    action: MessageCommentAction,
    mentions: CommentMention[]
  ) => Promise<unknown>;
  onResolve: (threadId: string) => Promise<unknown>;
  onReopen: (threadId: string) => Promise<unknown>;
  onSendToAgent: (threadId: string) => Promise<unknown>;
}>) {
  const resourceSource = useMemo(
    () => apiResourceHistorySource(projectId, sessionId),
    [projectId, sessionId]
  );

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
        <SessionResourceHistoryDrawer source={resourceSource} onClose={onCloseResources} />
      )}

      {showComments && (
        <SessionCommentsDrawer
          items={commentItems}
          loading={commentsLoading}
          viewerId={viewerId}
          mentionProjectId={projectId}
          onClose={onCloseComments}
          onJump={onJump}
          onReply={onReply}
          onResolve={onResolve}
          onReopen={onReopen}
          onSendToAgent={canSendToAgent ? onSendToAgent : undefined}
        />
      )}
    </>
  );
}
