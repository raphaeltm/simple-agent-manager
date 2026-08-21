import { Button, Spinner } from '@simple-agent-manager/ui';

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

export interface CommentActions {
  createThread: (input: {
    messageId: string;
    quote?: string;
    body: string;
    action: MessageCommentAction;
  }) => Promise<unknown>;
  reply: (input: {
    commentId: string;
    body: string;
    action: MessageCommentAction;
  }) => Promise<unknown>;
  resolve: (commentId: string) => Promise<unknown>;
  reopen: (commentId: string) => Promise<unknown>;
  sendToAgent: (input: { commentId: string; body?: string }) => Promise<unknown>;
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
  onClose,
  onClearDraft,
}: {
  messageId: string;
  comments: UiMessageCommentThread[];
  draft: MessageCommentDraft | null;
  focusedCommentId: string | null;
  actions: CommentActions;
  onClose: () => void;
  onClearDraft: () => void;
}) {
  const shouldRender = comments.length > 0 || draft;
  if (!shouldRender) return null;

  return (
    <section
      className="mb-4 ml-0 flex min-w-0 flex-col gap-3 rounded-lg border border-border-default bg-inset/50 p-3 sm:ml-6"
      aria-label="Message comments"
    >
      {draft && (
        <CommentComposer
          quote={draft.quote}
          onSubmit={async (body, action) => {
            await actions.createThread({ messageId, quote: draft.quote, body, action });
            onClearDraft();
          }}
          onCancel={onClearDraft}
        />
      )}
      <CommentThreadList
        comments={comments}
        focusedCommentId={focusedCommentId}
        onReply={(commentId, body, action) => actions.reply({ commentId, body, action })}
        onResolve={actions.resolve}
        onReopen={actions.reopen}
        onSendToAgent={(commentId) => actions.sendToAgent({ commentId })}
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
}) {
  return (
    <aside className="hidden min-h-0 w-[22rem] shrink-0 border-l border-border-default bg-surface/80 lg:flex lg:flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border-default px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-fg-primary">Comments</h2>
          <p className="text-[0.6875rem] text-fg-muted">
            {comments.length === 0 ? 'No message comments' : `${comments.length} thread${comments.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {refreshing && <Spinner size="sm" />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {draft && (
          <section className="mb-4 rounded-lg border border-focus-ring bg-inset/70 p-3">
            <h3 className="mb-2 text-xs font-semibold text-fg-primary">
              New comment on message {draft.anchorId}
            </h3>
            <CommentComposer
              quote={draft.quote}
              onSubmit={async (body, action) => {
                await actions.createThread({
                  messageId: draft.anchorId,
                  quote: draft.quote,
                  body,
                  action,
                });
                onClearDraft();
              }}
              onCancel={onClearDraft}
            />
          </section>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Spinner size="sm" />
            Loading comments…
          </div>
        ) : error ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-danger-fg">
            <p className="mb-2 font-medium">Comments failed to load.</p>
            <p className="mb-3 [overflow-wrap:anywhere]">{error}</p>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : comments.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Select text in a user or agent message to start a comment.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {comments.map((comment) => (
              <section key={comment.id} className="min-w-0">
                <button
                  type="button"
                  className={`mb-2 flex w-full min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1 text-left text-xs ${
                    activeMessageId === comment.anchor.messageId
                      ? 'border-focus-ring bg-surface-hover text-fg-primary'
                      : 'border-border-default text-fg-muted hover:text-fg-primary'
                  }`}
                  onClick={() => onSelectMessage(comment.anchor.messageId, comment.id)}
                >
                  <span className="min-w-0 truncate">Message {comment.anchor.messageId}</span>
                  <span className="shrink-0">View</span>
                </button>
                <CommentThreadList
                  comments={[comment]}
                  focusedCommentId={focusedCommentId}
                  onReply={(commentId, body, action) => actions.reply({ commentId, body, action })}
                  onResolve={actions.resolve}
                  onReopen={actions.reopen}
                  onSendToAgent={(commentId) => actions.sendToAgent({ commentId })}
                />
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

export function getMessageComments(comments: UiMessageCommentThread[], messageId: string) {
  return commentsForMessage(comments, messageId);
}
