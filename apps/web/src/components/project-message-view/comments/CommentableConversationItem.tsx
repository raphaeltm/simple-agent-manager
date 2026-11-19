import type { ToolCallContentItem } from '@simple-agent-manager/acp-client';
import type { ReactNode } from 'react';

import { AcpConversationItemView } from '../AcpConversationItemView';
import { noticeOf } from '../sam-notice/notice-items';
import type { DisplayItem } from '../tool-call-groups';
import type { MessageCommentDraft, UiMessageCommentThread } from './comment-utils';
import {
  type CommentActions,
  getMessageComments,
  InlineMessageComments,
  MessageCommentActionRow,
} from './MessageCommentPanels';

export interface MessageCommentRowState {
  comments: UiMessageCommentThread[];
  activeMessageId: string | null;
  focusedCommentId: string | null;
  draft: MessageCommentDraft | null;
  detachedDraftMessageId: string | null;
  actions: CommentActions;
  onToggleMessageComments: (messageId: string) => void;
  onSelectMessageComments: (messageId: string, commentId?: string) => void;
  onStartComment: (draft: MessageCommentDraft) => void;
  onCloseMessageComments: () => void;
  onClearDraft: () => void;
}

export function CommentableConversationItem({
  index,
  firstItemIndex,
  item,
  projectId,
  highlighted,
  onFileClick,
  onLoadToolContent,
  animateAgentText,
  animateUserMessage,
  canComment,
  canSendToAgent,
  agentActivity,
  animationTargetIdx,
  commentState,
  groupExpanded,
  onToggleGroup,
  groupLive,
  afterContent,
  serverTextToSpeech,
}: {
  index: number;
  firstItemIndex: number;
  item: DisplayItem;
  projectId: string;
  highlighted: boolean;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadToolContent: (messageId: string) => Promise<ToolCallContentItem[]>;
  animateAgentText: boolean;
  animateUserMessage: boolean;
  /** Start threads on this message. Every project member who can see the session. */
  canComment: boolean;
  /** Offer Send to agent on this message's threads. Session owner and grantees only. */
  canSendToAgent: boolean;
  agentActivity: string;
  animationTargetIdx: number;
  commentState: MessageCommentRowState;
  /** Controlled expansion for a `tool_call_group` row; undefined for other kinds. */
  groupExpanded?: boolean;
  /** Stable toggle callback — keeps `AcpConversationItemView`'s memo intact. */
  onToggleGroup?: (groupId: string) => void;
  /** True when this group is the tail row and the agent is mid-turn. */
  groupLive?: boolean;
  /** Durable interaction UI anchored directly after the message/tool row. */
  afterContent?: ReactNode;
  /** Read once by the list (`AcpConversationItemView` explains why). */
  serverTextToSpeech: boolean;
}) {
  const isMessageRow =
    item.kind === 'agent_message' || (item.kind === 'user_message' && item.origin !== 'system');
  // A SAM notice row is not a message anyone wrote, so it takes no new comments. Threads made
  // on it before (by a client that drew it as a bubble) stay visible.
  const isNoticeRow = isMessageRow && noticeOf(item) !== null;
  const itemComments = isMessageRow ? getMessageComments(commentState.comments, item.id) : [];
  const isCommentableMessage = isMessageRow && (!isNoticeRow || itemComments.length > 0);
  const canCommentHere = canComment && !isNoticeRow;
  const hasUnresolvedComments = itemComments.some((comment) => comment.status !== 'resolved');
  const isCommentsExpanded = commentState.activeMessageId === item.id;
  const draftForMessage = commentState.draft?.anchorId === item.id ? commentState.draft : null;
  const inlineDraftForMessage =
    commentState.detachedDraftMessageId === item.id ? null : draftForMessage;
  const inlineComments = isCommentsExpanded || inlineDraftForMessage ? itemComments : [];
  const commentAccentClass =
    itemComments.length === 0
      ? ''
      : hasUnresolvedComments
        ? ' lg:border-l-2 lg:border-warning/60'
        : ' lg:border-l-2 lg:border-border-default';

  return (
    <div
      className={`sam-message-entry px-3 pb-3 md:px-4${highlighted ? ' sam-message-highlight' : ''}${commentAccentClass}`}
      data-commented={itemComments.length > 0 ? 'true' : undefined}
      data-conversation-item-id={item.id}
    >
      <div data-comment-anchor={isCommentableMessage && !isNoticeRow ? item.id : undefined}>
        <AcpConversationItemView
          item={item}
          projectId={projectId}
          onFileClick={onFileClick}
          onLoadToolContent={onLoadToolContent}
          animateText={
            animateAgentText &&
            item.kind === 'agent_message' &&
            index - firstItemIndex === animationTargetIdx &&
            agentActivity === 'responding'
          }
          animateUserMessage={animateUserMessage}
          groupExpanded={groupExpanded}
          onToggleGroup={onToggleGroup}
          groupLive={groupLive}
          serverTextToSpeech={serverTextToSpeech}
        />
        {afterContent}
      </div>

      {isCommentableMessage && (canCommentHere || itemComments.length > 0) && (
        <MessageCommentActionRow
          comments={itemComments}
          expanded={isCommentsExpanded}
          canComment={canCommentHere}
          onToggle={() => commentState.onToggleMessageComments(item.id)}
          onStartComment={() => commentState.onStartComment({ anchorId: item.id })}
        />
      )}

      {isCommentableMessage && (
        <div className="lg:hidden">
          <InlineMessageComments
            messageId={item.id}
            comments={inlineComments}
            draft={inlineDraftForMessage}
            focusedCommentId={commentState.focusedCommentId}
            actions={commentState.actions}
            canSendToAgent={canSendToAgent}
            onClose={commentState.onCloseMessageComments}
            onClearDraft={commentState.onClearDraft}
          />
        </div>
      )}
    </div>
  );
}
