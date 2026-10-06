import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';

import type { MessageCommentDraft } from './comment-utils';
import type { MessageCommentRowState } from './CommentableConversationItem';
import { SelectionActionBar, SelectionPopover } from './CommentPrimitives';
import { type CommentActions, MobileSelectedTextCommentComposer } from './MessageCommentPanels';
import { useCoarsePointer, useCommentSelection } from './useCommentSelection';
import { useCommentsRailViewport } from './useCommentsRailViewport';
import { type useMessageComments } from './useMessageComments';

type MessageCommentsController = ReturnType<typeof useMessageComments>;

export function useProjectMessageCommentUi({
  messageComments,
  canWriteSession,
  hasMessages,
  chatLogRef,
  sessionId,
  onRequestCommentSurface,
}: {
  messageComments: MessageCommentsController;
  canWriteSession: boolean;
  hasMessages: boolean;
  chatLogRef: RefObject<HTMLDivElement | null>;
  sessionId: string;
  onRequestCommentSurface?: () => void;
}) {
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MessageCommentDraft | null>(null);

  const { selection, clear: clearSelection } = useCommentSelection(
    canWriteSession && hasMessages,
    chatLogRef
  );
  const coarsePointer = useCoarsePointer();
  const usesDesktopRail = useCommentsRailViewport();

  const startComment = useCallback(
    (nextDraft: MessageCommentDraft) => {
      setDraft(nextDraft);
      setActiveMessageId(nextDraft.anchorId);
      setFocusedCommentId(null);
      if (usesDesktopRail) onRequestCommentSurface?.();
      clearSelection();
    },
    [clearSelection, onRequestCommentSurface, usesDesktopRail]
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

  const rowState = useMemo<MessageCommentRowState>(
    () => ({
      comments: messageComments.comments,
      activeMessageId,
      focusedCommentId,
      draft,
      actions,
      onToggleMessageComments: (messageId) => {
        if (usesDesktopRail) {
          setActiveMessageId(messageId);
          setFocusedCommentId(null);
          onRequestCommentSurface?.();
          return;
        }
        setActiveMessageId((current) => (current === messageId ? null : messageId));
        setFocusedCommentId(null);
      },
      onSelectMessageComments: (messageId, commentId) => {
        setActiveMessageId(messageId);
        setFocusedCommentId(commentId ?? null);
        if (usesDesktopRail) onRequestCommentSurface?.();
      },
      onStartComment: startComment,
      onCloseMessageComments: () => setActiveMessageId(null),
      onClearDraft: clearDraft,
      detachedDraftMessageId: draft?.quote ? draft.anchorId : null,
    }),
    [
      actions,
      activeMessageId,
      clearDraft,
      draft,
      focusedCommentId,
      messageComments.comments,
      onRequestCommentSurface,
      startComment,
      usesDesktopRail,
    ]
  );

  const selectionControls =
    selection && canWriteSession ? (
      coarsePointer ? (
        <SelectionActionBar
          quote={selection.quote}
          selectionBottom={selection.rectBottom}
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

  return {
    rowState,
    selectionControls,
    selectedTextComposer:
      draft?.quote && !usesDesktopRail ? (
        <MobileSelectedTextCommentComposer
          draft={draft}
          actions={actions}
          onClearDraft={clearDraft}
        />
      ) : null,
    usesDesktopRail,
  };
}
