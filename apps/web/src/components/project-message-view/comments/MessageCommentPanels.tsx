import { Button } from '@simple-agent-manager/ui';

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

export function getMessageComments(comments: UiMessageCommentThread[], messageId: string) {
  return commentsForMessage(comments, messageId);
}
