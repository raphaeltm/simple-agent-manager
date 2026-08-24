import { Avatar } from '@simple-agent-manager/ui';
import { FileText, MessageSquare, Reply } from 'lucide-react';

import {
  bucketFor,
  COMMENT_BUCKET_COLORS,
  COMMENT_BUCKET_LABELS,
  type CommentInboxItem,
  lastActivitySummary,
  sourceLabel,
} from './comment-inbox';
import { relativeCommentTime } from './comment-utils';

function anchorFallbackLabel(source: CommentInboxItem['source']): string {
  if (source.kind === 'library_file') return 'on this file';
  if (source.messageRole === 'user') return 'on your message';
  return "on the agent's reply";
}

/**
 * One scannable comment thread in a list.
 *
 * Optimised for triage, not for reading: the eye should be able to run down a
 * column of these and answer "which of these still needs me?" without opening
 * any of them. That means the bucket accent, the last-activity line, and the
 * timestamp all sit at fixed positions, and the thread body is clamped rather
 * than allowed to set the row height.
 *
 * The expanded thread itself is NOT rendered here — callers slot in the real
 * `CommentThread` so reply/resolve/reopen behaviour cannot fork.
 */
export function CommentInboxRow({
  item,
  viewerId,
  showSource = false,
  showBucket = true,
  selected = false,
  onSelect,
}: Readonly<{
  item: CommentInboxItem;
  viewerId: string | null;
  /** Show the "which session / which file" line. Off inside a single session. */
  showSource?: boolean;
  /**
   * Off when the row already sits under a bucket heading — repeating the state
   * on every row inside a group labelled with that state is pure noise.
   */
  showBucket?: boolean;
  selected?: boolean;
  onSelect: () => void;
}>) {
  const bucket = bucketFor(item, viewerId);
  const accent = COMMENT_BUCKET_COLORS[bucket];
  const { thread } = item;
  const quote = thread.anchor.quote?.trim();
  const replyCount = thread.replies.length;
  const fallbackLabel = anchorFallbackLabel(item.source);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      data-comment-bucket={bucket}
      data-comment-thread-id={thread.id}
      className={`group w-full min-w-0 border-l-2 py-2.5 pr-2 pl-2.5 text-left transition-colors focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-ring ${
        selected ? 'bg-surface-hover' : 'hover:bg-surface-hover'
      }`}
      style={{ borderLeftColor: accent }}
    >
      {/* Line 1 — anchor, or the body when there is nothing quoted, plus time. */}
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {quote ? (
            <span className="italic">&ldquo;{quote}&rdquo;</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              {item.source.kind === 'session' ? (
                <MessageSquare size={11} className="shrink-0" />
              ) : (
                <FileText size={11} className="shrink-0" />
              )}
              {fallbackLabel}
            </span>
          )}
        </span>
        <time className="shrink-0 text-[0.6875rem] text-fg-muted tabular-nums">
          {relativeCommentTime(item.lastActivityAt)}
        </time>
      </div>

      {/*
        Line 2 — the comment itself. Clamped so rows stay uniform, and capped at
        a readable measure so a full-width desktop list does not run 200
        characters to the line.
      */}
      <p className="m-0 mt-1 line-clamp-2 max-w-[85ch] text-sm leading-snug text-fg-primary [overflow-wrap:anywhere]">
        {thread.body}
      </p>

      {/* Line 3 — who moved last, how deep the thread is, and its state. */}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Avatar
          name={item.lastActor.name}
          imageUrl={item.lastActor.avatarUrl}
          tone={item.lastActor.kind === 'agent' ? 'agent' : 'human'}
          size="sm"
        />
        <span className="min-w-0 truncate text-[0.6875rem] text-fg-muted">
          {lastActivitySummary(item, viewerId)}
        </span>
        {replyCount > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.6875rem] text-fg-muted">
            <Reply size={10} />
            {replyCount}
          </span>
        )}
        {showBucket && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium"
            style={{ color: accent }}
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            {COMMENT_BUCKET_LABELS[bucket]}
          </span>
        )}
      </div>

      {/* Line 4 — only in cross-source lists, where "where is this?" is a real question. */}
      {showSource && (
        <div className="mt-1 flex min-w-0 items-center gap-1 text-[0.6875rem] text-fg-muted">
          {item.source.kind === 'session' ? (
            <MessageSquare size={10} className="shrink-0" />
          ) : (
            <FileText size={10} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{sourceLabel(item.source)}</span>
        </div>
      )}
    </button>
  );
}
