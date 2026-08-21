import { Avatar, Button } from '@simple-agent-manager/ui';
import { useEffect, useRef, useState } from 'react';

import type { MessageCommentAction } from '../../../lib/api/comments';
import {
  authorDisplayName,
  relativeCommentTime,
  type UiMessageCommentThread,
} from './comment-utils';
import { CommentComposer } from './CommentComposer';
import { CommentStatusPill, QuotedAnchor } from './CommentPrimitives';

interface CommentThreadProps {
  comment: UiMessageCommentThread;
  focused?: boolean;
  onReply: (commentId: string, body: string, action: MessageCommentAction) => Promise<unknown>;
  onResolve: (commentId: string) => Promise<unknown>;
  onReopen: (commentId: string) => Promise<unknown>;
  onSendToAgent: (commentId: string) => Promise<unknown>;
}

export function CommentThread({
  comment,
  focused = false,
  onReply,
  onResolve,
  onReopen,
  onSendToAgent,
}: CommentThreadProps) {
  const isResolved = comment.status === 'resolved';
  const [expanded, setExpanded] = useState(!isResolved);
  const [replying, setReplying] = useState(false);
  const previousResolved = useRef(isResolved);

  useEffect(() => {
    if (previousResolved.current === isResolved) return;
    previousResolved.current = isResolved;
    setExpanded(!isResolved);
    setReplying(false);
  }, [isResolved]);

  const authorName = authorDisplayName(comment.author);
  const pending = comment.syncState === 'pending';
  const failed = comment.syncState === 'failed';

  return (
    <article
      data-comment-id={comment.id}
      data-comment-status={comment.status}
      className={`rounded-lg border p-3 transition-colors ${
        focused ? 'border-focus-ring bg-surface-hover' : 'border-border-default bg-surface'
      } ${isResolved && !expanded ? 'opacity-75' : ''}`}
      aria-label={`Comment by ${authorName}`}
    >
      <header className="flex min-w-0 items-start gap-2">
        <Avatar
          name={authorName}
          imageUrl={comment.author.avatarUrl}
          tone={comment.author.kind === 'agent' ? 'agent' : 'human'}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="break-words text-xs font-semibold text-fg-primary">{authorName}</span>
            <span className="whitespace-nowrap text-[0.6875rem] text-fg-muted">
              {relativeCommentTime(comment.createdAt)}
            </span>
            {pending && <span className="text-[0.6875rem] text-fg-muted">Saving…</span>}
            {failed && <span className="text-[0.6875rem] text-danger-fg">Failed to save</span>}
          </div>
        </div>
        <CommentStatusPill status={comment.status} />
      </header>

      {isResolved && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-xs text-fg-muted underline hover:text-fg-primary"
        >
          Show resolved thread{comment.replies.length > 0 && ` (${comment.replies.length + 1})`}
        </button>
      ) : (
        <div className="mt-2 min-w-0">
          {comment.anchor.quote && <QuotedAnchor quote={comment.anchor.quote} />}
          <p className="m-0 text-sm leading-relaxed text-fg-primary [overflow-wrap:anywhere]">
            {comment.body}
          </p>

          {comment.replies.length > 0 && (
            <ul className="mt-3 flex list-none flex-col gap-3 border-l border-border-default pl-3">
              {comment.replies.map((reply) => {
                const replyAuthor = authorDisplayName(reply.author);
                return (
                  <li key={reply.id} className="flex min-w-0 items-start gap-2">
                    <Avatar
                      name={replyAuthor}
                      imageUrl={reply.author.avatarUrl}
                      tone={reply.author.kind === 'agent' ? 'agent' : 'human'}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="break-words text-xs font-semibold text-fg-primary">
                          {replyAuthor}
                        </span>
                        <span className="whitespace-nowrap text-[0.6875rem] text-fg-muted">
                          {relativeCommentTime(reply.createdAt)}
                        </span>
                        {reply.sentToAgent && (
                          <span className="text-[0.6875rem] text-info-fg">Sent to agent</span>
                        )}
                      </div>
                      <p className="m-0 mt-0.5 text-sm leading-relaxed text-fg-primary [overflow-wrap:anywhere]">
                        {reply.body}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-3">
            {replying ? (
              <CommentComposer
                placeholder="Reply…"
                submitLabel="Reply"
                onSubmit={async (body, action) => {
                  await onReply(comment.id, body, action);
                  setReplying(false);
                }}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
                  Reply
                </Button>
                {comment.status === 'open' && (
                  <Button size="sm" variant="ghost" onClick={() => onSendToAgent(comment.id)}>
                    Send to agent
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => (isResolved ? onReopen(comment.id) : onResolve(comment.id))}
                >
                  {isResolved ? 'Reopen' : 'Resolve'}
                </Button>
                {isResolved && (
                  <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
                    Collapse
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function CommentThreadList({
  comments,
  focusedCommentId,
  emptyMessage = 'No comments yet.',
  onReply,
  onResolve,
  onReopen,
  onSendToAgent,
}: {
  comments: UiMessageCommentThread[];
  focusedCommentId?: string | null;
  emptyMessage?: string;
  onReply: CommentThreadProps['onReply'];
  onResolve: CommentThreadProps['onResolve'];
  onReopen: CommentThreadProps['onReopen'];
  onSendToAgent: CommentThreadProps['onSendToAgent'];
}) {
  if (comments.length === 0) {
    return <p className="m-0 text-sm text-fg-muted">{emptyMessage}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {comments.map((comment) => (
        <CommentThread
          key={comment.id}
          comment={comment}
          focused={focusedCommentId === comment.id}
          onReply={onReply}
          onResolve={onResolve}
          onReopen={onReopen}
          onSendToAgent={onSendToAgent}
        />
      ))}
    </div>
  );
}
