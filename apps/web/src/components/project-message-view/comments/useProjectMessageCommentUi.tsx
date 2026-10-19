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
  canComment,
  canSendToAgent,
  hasMessages,
  chatLogRef,
  sessionId,
  projectId,
  onRequestCommentSurface,
  focusCommentThreadId,
}: {
  messageComments: MessageCommentsController;
  /** Start threads, including from selected text. Every project member who can see the session. */
  canComment: boolean;
  /** Offer Send to agent anywhere in the comment UI. Session owner and grantees only. */
  canSendToAgent: boolean;
  hasMessages: boolean;
  chatLogRef: RefObject<HTMLDivElement | null>;
  sessionId: string;
  /** Scopes the @mention member list. */
  projectId: string;
  onRequestCommentSurface?: () => void;
  /**
   * A thread to open focused, from a route-level deep link (`?commentThread=` on a comment
   * notification). Latched: it may be cleared from the URL before the threads have loaded.
   */
  focusCommentThreadId?: string | null;
}) {
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MessageCommentDraft | null>(null);
  const [pendingFocusThreadId, setPendingFocusThreadId] = useState<string | null>(
    focusCommentThreadId ?? null
  );

  const { selection, clear: clearSelection } = useCommentSelection(
    canComment && hasMessages,
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

  const { createThread, reply, resolve, reopen, sendToAgent } = messageComments;
  // The viewer's capabilities are baked in here, once: a reader's actions have no
  // `sendToAgent`, so no surface reached through them can offer it.
  const actions = useMemo<CommentActions>(
    () => ({
      mentionProjectId: projectId,
      createThread,
      reply,
      resolve,
      reopen,
      sendToAgent: canSendToAgent ? sendToAgent : undefined,
    }),
    [canSendToAgent, createThread, projectId, reopen, reply, resolve, sendToAgent]
  );

  useEffect(() => {
    setActiveMessageId(null);
    setFocusedCommentId(null);
    setDraft(null);
    clearSelection();
  }, [clearSelection, sessionId]);

  // A new deep link (another notification for this same session) replaces the pending one.
  useEffect(() => {
    if (focusCommentThreadId) setPendingFocusThreadId(focusCommentThreadId);
  }, [focusCommentThreadId]);

  // Open the linked thread once it is loaded: in the docked rail on desktop, inline under its
  // message on smaller screens. Declared after the session reset above so, when both run in
  // one commit, the focus wins.
  const commentsSettled = !messageComments.loading && !messageComments.refreshing;
  useEffect(() => {
    if (!pendingFocusThreadId) return;
    const thread = messageComments.comments.find(
      (candidate) => candidate.id === pendingFocusThreadId
    );
    if (thread) {
      setPendingFocusThreadId(null);
      setActiveMessageId(thread.anchor.messageId);
      setFocusedCommentId(thread.id);
      if (usesDesktopRail) onRequestCommentSurface?.();
      return;
    }
    // Deleted, or not a thread of this session: stop waiting once the list has settled.
    if (commentsSettled) setPendingFocusThreadId(null);
  }, [
    commentsSettled,
    messageComments.comments,
    onRequestCommentSurface,
    pendingFocusThreadId,
    usesDesktopRail,
  ]);

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
    selection && canComment ? (
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
