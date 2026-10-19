import type { CommentMention } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { MessageSquareQuote, X } from 'lucide-react';
import { createPortal } from 'react-dom';

import type { MessageCommentAction } from '../../../lib/api/comments';
import {
  commentsForMessage,
  type MessageCommentDraft,
  summarizeComments,
  type UiMessageCommentThread,
} from './comment-utils';
import { CommentComposer } from './CommentComposer';
import { CommentCountMarker, CommentGlyph } from './CommentPrimitives';
import { CommentThreadList } from './CommentThread';

/**
 * Everything a comment surface may do for the current viewer, decided once by
 * `useProjectMessageCommentUi`. Surfaces that only receive this object (the desktop rail, the
 * mobile selected-text composer) read their gates from it rather than re-deriving them.
 */
export interface CommentActions {
  /** Project whose active members the composers offer as @mentions. */
  mentionProjectId: string;
  createThread: (input: {
    messageId: string;
    quote?: string;
    body: string;
    action: MessageCommentAction;
    mentions: CommentMention[];
  }) => Promise<unknown>;
  reply: (input: {
    commentId: string;
    body: string;
    action: MessageCommentAction;
    mentions: CommentMention[];
  }) => Promise<unknown>;
  resolve: (commentId: string) => Promise<unknown>;
  reopen: (commentId: string) => Promise<unknown>;
  /**
   * Present only when the viewer controls the session (owner or grantee). Every
   * Send-to-agent affordance — the thread button, the new-thread and reply choices — keys on
   * its presence, so a reader never sees one.
   */
  sendToAgent?: (input: { commentId: string; body?: string }) => Promise<unknown>;
}

/** Thread-list callbacks for a surface, with Send to agent only when `actions` allows it. */
function threadCallbacks(actions: CommentActions, canSendToAgent = true) {
  const { sendToAgent } = actions;
  return {
    onReply: (
      commentId: string,
      body: string,
      action: MessageCommentAction,
      mentions: CommentMention[]
    ) => actions.reply({ commentId, body, action, mentions }),
    onResolve: actions.resolve,
    onReopen: actions.reopen,
    onSendToAgent:
      canSendToAgent && sendToAgent ? (commentId: string) => sendToAgent({ commentId }) : undefined,
  };
}

export function MessageCommentActionRow({
  messageId,
  comments,
  expanded,
  canComment,
  onToggle,
  onStartComment,
}: {
  messageId: string;
  comments: UiMessageCommentThread[];
  expanded: boolean;
  canComment: boolean;
  onToggle: () => void;
  onStartComment: () => void;
}) {
  const summary = summarizeComments(comments);

  return (
    <div className="mt-[-0.35rem] mb-2 flex flex-wrap items-center gap-2 text-fg-muted">
      {summary.count > 0 && (
        <CommentCountMarker
          count={summary.count}
          unresolvedCount={summary.unresolvedCount}
          expanded={expanded}
          onClick={onToggle}
        />
      )}
      {canComment && (
        <button
          type="button"
          onClick={onStartComment}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[0.6875rem] hover:text-fg-primary"
          aria-label={`Add comment on message ${messageId}`}
        >
          <CommentGlyph />
          Comment
        </button>
      )}
    </div>
  );
}

export function InlineMessageComments({
  messageId,
  comments,
  draft,
  focusedCommentId,
  actions,
  canSendToAgent,
  onClose,
  onClearDraft,
}: {
  messageId: string;
  comments: UiMessageCommentThread[];
  draft: MessageCommentDraft | null;
  focusedCommentId: string | null;
  actions: CommentActions;
  /** The row's explicit gate; Send to agent also needs `actions.sendToAgent`. */
  canSendToAgent: boolean;
  onClose: () => void;
  onClearDraft: () => void;
}) {
  const shouldRender = comments.length > 0 || draft;
  if (!shouldRender) return null;
  const callbacks = threadCallbacks(actions, canSendToAgent);

  return (
    <section
      className="mb-4 ml-0 flex min-w-0 flex-col gap-3 rounded-lg border border-border-default bg-inset/50 p-3 sm:ml-6"
      aria-label="Message comments"
    >
      {draft && (
        <CommentComposer
          quote={draft.quote}
          canSendToAgent={Boolean(callbacks.onSendToAgent)}
          mentionProjectId={actions.mentionProjectId}
          onSubmit={async (body, action, mentions) => {
            await actions.createThread({ messageId, quote: draft.quote, body, action, mentions });
            onClearDraft();
          }}
          onCancel={onClearDraft}
        />
      )}
      <CommentThreadList
        comments={comments}
        focusedCommentId={focusedCommentId}
        mentionProjectId={actions.mentionProjectId}
        {...callbacks}
      />
      <div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close comments
        </Button>
      </div>
    </section>
  );
}

export function DesktopCommentRail({
  comments,
  draft,
  loading,
  refreshing,
  error,
  activeMessageId,
  focusedCommentId,
  actions,
  onRetry,
  onClearDraft,
  onSelectMessage,
  onClose,
}: {
  comments: UiMessageCommentThread[];
  draft: MessageCommentDraft | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  activeMessageId: string | null;
  focusedCommentId: string | null;
  actions: CommentActions;
  onRetry: () => void;
  onClearDraft: () => void;
  onSelectMessage: (messageId: string, commentId?: string) => void;
  onClose: () => void;
}) {
  const hasDraft = Boolean(draft);
  const showLoading = loading && comments.length === 0;
  const showEmpty = !showLoading && !error && comments.length === 0 && !hasDraft;
  const callbacks = threadCallbacks(actions);

  return (
    <aside
      className="glass-panel-container glass-composited glass-modal relative hidden min-h-0 w-80 max-w-[42vw] shrink-0 flex-col overflow-hidden rounded-none border-y-0 border-r-0 border-l border-border-default shadow-xl lg:flex 2xl:w-[24rem]"
      aria-label="Session comments"
    >
      <header className="flex min-h-[44px] shrink-0 items-center gap-2 border-b border-border-default px-3 py-2">
        <MessageSquareQuote size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-semibold text-fg-primary">Comments</h2>
          <p className="m-0 text-[0.6875rem] text-fg-muted">
            {comments.length === 0
              ? hasDraft
                ? 'Drafting a new thread'
                : 'No message comments'
              : `${comments.length} thread${comments.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {refreshing && <Spinner size="sm" />}
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          aria-label="Close comments"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {draft && (
          <section
            className="mb-4 min-w-0 rounded-lg border border-focus-ring bg-inset/70 p-3"
            aria-label={draft.quote ? 'New comment on selected text' : 'New message comment'}
          >
            <h3 className="mb-2 text-xs font-semibold text-fg-primary">
              {draft.quote ? 'New comment on selected text' : 'New comment on message'}{' '}
              <span className="font-mono text-[0.6875rem] text-fg-muted">{draft.anchorId}</span>
            </h3>
            <CommentComposer
              quote={draft.quote}
              canSendToAgent={Boolean(callbacks.onSendToAgent)}
              mentionProjectId={actions.mentionProjectId}
              onSubmit={async (body, action, mentions) => {
                await actions.createThread({
                  messageId: draft.anchorId,
                  quote: draft.quote,
                  body,
                  action,
                  mentions,
                });
                onClearDraft();
              }}
              onCancel={onClearDraft}
            />
          </section>
        )}

        {showLoading ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Spinner size="sm" />
            Loading comments…
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-danger-fg"
          >
            <p className="mb-2 font-medium">Comments failed to load.</p>
            <p className="mb-3 [overflow-wrap:anywhere]">{error}</p>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : showEmpty ? (
          <p className="text-sm text-fg-muted">
            Select text in a user or agent message, or use a message Comment button to start a
            thread.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {comments.map((comment) => (
              <section key={comment.id} className="min-w-0">
                <button
                  type="button"
                  className={`mb-2 flex w-full min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${
                    activeMessageId === comment.anchor.messageId
                      ? 'border-focus-ring bg-surface-hover text-fg-primary'
                      : 'border-border-default text-fg-muted hover:text-fg-primary'
                  }`}
                  onClick={() => onSelectMessage(comment.anchor.messageId, comment.id)}
                  aria-label={`Show message ${comment.anchor.messageId} in conversation`}
                >
                  <span className="min-w-0 truncate">Message {comment.anchor.messageId}</span>
                  <span className="shrink-0">View</span>
                </button>
                <CommentThreadList
                  comments={[comment]}
                  focusedCommentId={focusedCommentId}
                  mentionProjectId={actions.mentionProjectId}
                  scrollFocusedIntoView
                  {...callbacks}
                />
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

export function MobileSelectedTextCommentComposer({
  draft,
  actions,
  onClearDraft,
}: {
  draft: MessageCommentDraft;
  actions: CommentActions;
  onClearDraft: () => void;
}) {
  return createPortal(
    <section
      aria-label="Selected text comment composer"
      className="fixed inset-x-2 bottom-2 z-panel max-h-[min(72dvh,32rem)] overflow-y-auto rounded-2xl border border-border-default bg-surface p-2 shadow-2xl lg:hidden"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <MessageSquareQuote size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <h2 className="m-0 min-w-0 flex-1 text-xs font-semibold text-fg-primary">
          Comment on selected text
        </h2>
        <button
          type="button"
          onClick={onClearDraft}
          className="rounded p-1.5 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          aria-label="Close selected text comment composer"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <CommentComposer
        quote={draft.quote}
        canSendToAgent={Boolean(actions.sendToAgent)}
        mentionProjectId={actions.mentionProjectId}
        onSubmit={async (body, action, mentions) => {
          await actions.createThread({
            messageId: draft.anchorId,
            quote: draft.quote,
            body,
            action,
            mentions,
          });
          onClearDraft();
        }}
        onCancel={onClearDraft}
      />
    </section>,
    document.body
  );
}

export function getMessageComments(comments: UiMessageCommentThread[], messageId: string) {
  return commentsForMessage(comments, messageId);
}
