import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';

import type { MessageCommentDraft } from './comment-utils';
import type { MessageCommentRowState } from './CommentableConversationItem';
import { SelectionActionBar, SelectionPopover } from './CommentPrimitives';
import { type CommentActions, DesktopCommentRail } from './MessageCommentPanels';
import { useCoarsePointer, useCommentSelection } from './useCommentSelection';
import { type useMessageComments } from './useMessageComments';

type MessageCommentsController = ReturnType<typeof useMessageComments>;

export function useProjectMessageCommentUi({
  messageComments,
  canWriteSession,
  hasMessages,
  chatLogRef,
  sessionId,
  scrollAndHighlight,
}: {
  messageComments: MessageCommentsController;
  canWriteSession: boolean;
  hasMessages: boolean;
  chatLogRef: RefObject<HTMLDivElement | null>;
  sessionId: string;
  scrollAndHighlight: (messageId: string) => boolean;
}) {
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MessageCommentDraft | null>(null);

  const { selection, clear: clearSelection } = useCommentSelection(
    canWriteSession && hasMessages,
    chatLogRef
  );
  const coarsePointer = useCoarsePointer();

  const startComment = useCallback(
    (nextDraft: MessageCommentDraft) => {
      setDraft(nextDraft);
      setActiveMessageId(nextDraft.anchorId);
      setFocusedCommentId(null);
      clearSelection();
    },
    [clearSelection]
  );

  const clearDraft = useCallback(() => setDraft(null), []);

  const actions = useMemo<CommentActions>(
    () => ({
      createThread: (input) => messageComments.createThread(input),
      reply: (input) => messageComments.reply(input),
      resolve: (commentId) => messageComments.resolve(commentId),
      reopen: (commentId) => messageComments.reopen(commentId),
      sendToAgent: (input) => messageComments.sendToAgent(input),
    }),
    [messageComments]
  );

  useEffect(() => {
    setActiveMessageId(null);
    setFocusedCommentId(null);
    setDraft(null);
    clearSelection();
  }, [clearSelection, sessionId]);

  const selectMessage = useCallback(
    (messageId: string, commentId?: string) => {
      setActiveMessageId(messageId);
      setFocusedCommentId(commentId ?? null);
      scrollAndHighlight(messageId);
    },
    [scrollAndHighlight]
  );

  const rowState = useMemo<MessageCommentRowState>(
    () => ({
      comments: messageComments.comments,
      activeMessageId,
      focusedCommentId,
      draft,
      actions,
      onToggleMessageComments: (messageId) => {
        setActiveMessageId((current) => (current === messageId ? null : messageId));
        setFocusedCommentId(null);
      },
      onStartComment: startComment,
      onCloseMessageComments: () => setActiveMessageId(null),
      onClearDraft: clearDraft,
    }),
    [
      actions,
      activeMessageId,
      clearDraft,
      draft,
      focusedCommentId,
      messageComments.comments,
      startComment,
    ]
  );

  const selectionControls =
    selection && canWriteSession ? (
      coarsePointer ? (
        <SelectionActionBar
          quote={selection.quote}
          onComment={() =>
            startComment({
              anchorId: selection.anchorId,
              quote: selection.quote,
            })
          }
          onDismiss={clearSelection}
        />
      ) : (
        <SelectionPopover
          x={selection.x}
          y={selection.y}
          onComment={() =>
            startComment({
              anchorId: selection.anchorId,
              quote: selection.quote,
            })
          }
        />
      )
    ) : null;

  const desktopRail = (
    <DesktopCommentRail
      comments={messageComments.comments}
      draft={draft}
      loading={messageComments.loading}
      refreshing={messageComments.refreshing}
      error={messageComments.error}
      activeMessageId={activeMessageId}
      focusedCommentId={focusedCommentId}
      actions={actions}
      onRetry={() => {
        void messageComments.refetch();
      }}
      onClearDraft={clearDraft}
      onSelectMessage={selectMessage}
    />
  );

  return {
    rowState,
    selectionControls,
    desktopRail,
  };
}
