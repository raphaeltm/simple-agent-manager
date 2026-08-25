import type { ConversationItem, ToolCallContentItem } from '@simple-agent-manager/acp-client';

import { AcpConversationItemView } from '../AcpConversationItemView';
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
  canWriteSession,
  agentActivity,
  animationTargetIdx,
  commentState,
}: {
  index: number;
  firstItemIndex: number;
  item: ConversationItem;
  projectId: string;
  highlighted: boolean;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadToolContent: (messageId: string) => Promise<ToolCallContentItem[]>;
  animateAgentText: boolean;
  animateUserMessage: boolean;
  canWriteSession: boolean;
  agentActivity: string;
  animationTargetIdx: number;
  commentState: MessageCommentRowState;
}) {
  const isCommentableMessage =
    item.kind === 'agent_message' || (item.kind === 'user_message' && item.origin !== 'system');
  const itemComments = isCommentableMessage
    ? getMessageComments(commentState.comments, item.id)
    : [];
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
      className={`sam-message-entry px-4 pb-3${highlighted ? ' sam-message-highlight' : ''}${commentAccentClass}`}
      data-commented={itemComments.length > 0 ? 'true' : undefined}
    >
      <div data-comment-anchor={isCommentableMessage ? item.id : undefined}>
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
        />
      </div>

      {isCommentableMessage && (canWriteSession || itemComments.length > 0) && (
        <MessageCommentActionRow
          messageId={item.id}
          comments={itemComments}
          expanded={isCommentsExpanded}
          canComment={canWriteSession}
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
            onClose={commentState.onCloseMessageComments}
            onClearDraft={commentState.onClearDraft}
          />
        </div>
      )}
    </div>
  );
}
