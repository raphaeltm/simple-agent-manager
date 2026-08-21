/**
 * A single comment thread. Anchor-agnostic on purpose: the same component renders
 * a thread on a chat message and a thread on a markdown block. That is the whole
 * bet of this prototype — one thread UI, many surfaces.
 */

import { Button } from '@simple-agent-manager/ui';
import { useEffect, useRef, useState } from 'react';

import type { Comment } from './comment-types';
import { relativeTime } from './comment-types';
import {
  CommentAvatar,
  CommentComposer,
  CommentStatusPill,
  QuotedAnchor,
} from './CommentPrimitives';

export interface CommentThreadProps {
  comment: Comment;
  now: number;
  onReply: (commentId: string, body: string, sendToAgent: boolean) => void;
  onToggleResolved: (commentId: string) => void;
  /** Highlighted when the thread was opened from its anchor marker. */
  focused?: boolean;
}

export function CommentThread({
  comment,
  now,
  onReply,
  onToggleResolved,
  focused,
}: CommentThreadProps) {
  const isResolved = comment.status === 'resolved';
  // Resolved threads collapse by default — the list stays scannable once a
  // review has churned through 30 of them.
  const [expanded, setExpanded] = useState(!isResolved);
  const [replying, setReplying] = useState(false);

  // Collapse/expand must follow a status *change*, not just the mount value.
  // Without this, resolving an already-open thread left it expanded — the whole
  // point of resolving is to get it out of the way.
  const prevResolved = useRef(isResolved);
  useEffect(() => {
    if (prevResolved.current !== isResolved) {
      prevResolved.current = isResolved;
      setExpanded(!isResolved);
      setReplying(false);
    }
  }, [isResolved]);

  const quote = comment.anchor.quote;

  return (
    <article
      data-comment-id={comment.id}
      data-comment-status={comment.status}
      className="rounded-lg border p-3 transition-colors"
      style={{
        backgroundColor: 'var(--sam-color-bg-surface, #13201d)',
        borderColor: focused
          ? 'var(--sam-color-focus-ring, #34d399)'
          : 'var(--sam-color-border-default, #29423b)',
        opacity: isResolved && !expanded ? 0.7 : 1,
      }}
    >
      <header className="flex items-start gap-2">
        <CommentAvatar author={comment.author} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* Long display names must wrap, not truncate — a truncated name on a
                375px screen is unreadable (rule 56). */}
            <span
              className="text-xs font-semibold break-words"
              style={{ color: 'var(--sam-color-fg-primary, #e6f2ee)' }}
            >
              {comment.author.name}
            </span>
            <span
              className="text-[0.6875rem] whitespace-nowrap"
              style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}
            >
              {relativeTime(comment.createdAt, now)}
            </span>
          </div>
        </div>
        <CommentStatusPill status={comment.status} />
      </header>

      {isResolved && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-xs underline focus-visible:outline focus-visible:outline-2"
          style={{
            color: 'var(--sam-color-fg-muted, #9fb7ae)',
            outlineColor: 'var(--sam-color-focus-ring, #34d399)',
          }}
        >
          Show resolved thread
          {comment.replies.length > 0 && ` (${comment.replies.length + 1})`}
        </button>
      ) : (
        <div className="mt-2">
          {quote && <QuotedAnchor quote={quote} />}
          <p
            className="m-0 text-sm leading-relaxed"
            style={{
              color: 'var(--sam-color-fg-primary, #e6f2ee)',
              overflowWrap: 'anywhere',
            }}
          >
            {comment.body}
          </p>

          {comment.replies.length > 0 && (
            <ul
              className="mt-3 flex list-none flex-col gap-3 border-l pl-3"
              style={{ borderColor: 'var(--sam-color-border-default, #29423b)' }}
            >
              {comment.replies.map((reply) => (
                <li key={reply.id} className="flex items-start gap-2">
                  <CommentAvatar author={reply.author} size={20} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span
                        className="text-xs font-semibold break-words"
                        style={{ color: 'var(--sam-color-fg-primary, #e6f2ee)' }}
                      >
                        {reply.author.name}
                      </span>
                      <span
                        className="text-[0.6875rem] whitespace-nowrap"
                        style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}
                      >
                        {relativeTime(reply.createdAt, now)}
                      </span>
                    </div>
                    <p
                      className="m-0 mt-0.5 text-sm leading-relaxed"
                      style={{
                        color: 'var(--sam-color-fg-primary, #e6f2ee)',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {reply.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3">
            {replying ? (
              <CommentComposer
                placeholder="Reply…"
                submitLabel="Reply"
                onSubmit={(body, sendToAgent) => {
                  onReply(comment.id, body, sendToAgent);
                  setReplying(false);
                }}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
                  Reply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onToggleResolved(comment.id)}>
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

/** Renders a list of threads plus a "new comment" composer slot. */
export function CommentThreadList({
  comments,
  now,
  onReply,
  onToggleResolved,
  focusedCommentId,
  emptyMessage = 'No comments yet.',
}: {
  comments: Comment[];
  now: number;
  onReply: (commentId: string, body: string, sendToAgent: boolean) => void;
  onToggleResolved: (commentId: string) => void;
  focusedCommentId?: string | null;
  emptyMessage?: string;
}) {
  if (comments.length === 0) {
    return (
      <p className="m-0 text-sm" style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}>
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {comments.map((c) => (
        <CommentThread
          key={c.id}
          comment={c}
          now={now}
          onReply={onReply}
          onToggleResolved={onToggleResolved}
          focused={focusedCommentId === c.id}
        />
      ))}
    </div>
  );
}
