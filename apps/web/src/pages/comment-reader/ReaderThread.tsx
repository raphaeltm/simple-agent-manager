/**
 * The comment thread beside the conversation (desktop) or in a bottom sheet over it (phone).
 *
 * Both render the real `CommentThread`, so reply, resolve, reopen and send-to-agent behave
 * exactly as they do in the chat. Below it, the other comments on the same chat, so you can
 * move between them without leaving the conversation.
 */
import { Avatar } from '@simple-agent-manager/ui';
import { ChevronUp } from 'lucide-react';
import { forwardRef, useRef } from 'react';

import {
  authorDisplayName,
  relativeCommentTime,
  type UiMessageCommentThread,
} from '../../components/project-message-view/comments/comment-utils';
import { CommentThread } from '../../components/project-message-view/comments/CommentThread';
import type { threadCallbacks } from '../../components/project-message-view/comments/MessageCommentPanels';

type ThreadCallbacks = ReturnType<typeof threadCallbacks>;

export interface ReaderThreadProps {
  thread: UiMessageCommentThread;
  /** The other threads on this chat. */
  others: readonly UiMessageCommentThread[];
  /** "Grace replied", from the viewer's side. */
  summary: string;
  mentionProjectId: string;
  callbacks: ThreadCallbacks;
  onSelectThread: (threadId: string) => void;
}

function latestEntry(thread: UiMessageCommentThread) {
  const reply = thread.replies[thread.replies.length - 1];
  return reply
    ? { author: reply.author, body: reply.body, at: reply.createdAt }
    : { author: thread.author, body: thread.body, at: thread.createdAt };
}

function OtherThreads({
  threads,
  onSelect,
}: {
  threads: readonly UiMessageCommentThread[];
  onSelect: (threadId: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <section aria-label="Other comments in this chat" className="flex min-w-0 flex-col gap-1.5">
      <h2 className="m-0 text-xs font-medium text-fg-muted">Also in this chat</h2>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {threads.map((thread) => (
          <li key={thread.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(thread.id)}
              className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-border-default px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <Avatar
                name={authorDisplayName(thread.author)}
                imageUrl={thread.author.avatarUrl}
                tone={thread.author.kind === 'agent' ? 'agent' : 'human'}
                size="sm"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                {thread.anchor.quote && (
                  <span className="truncate text-xs text-fg-muted italic">
                    &ldquo;{thread.anchor.quote}&rdquo;
                  </span>
                )}
                <span className="line-clamp-2 text-sm text-fg-primary [overflow-wrap:anywhere]">
                  {thread.body}
                </span>
              </span>
              {thread.status === 'resolved' && (
                <span className="shrink-0 text-[0.6875rem] text-fg-muted">Resolved</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Thread({
  thread,
  mentionProjectId,
  callbacks,
  startReplying = false,
}: Pick<ReaderThreadProps, 'thread' | 'mentionProjectId' | 'callbacks'> & {
  startReplying?: boolean;
}) {
  return (
    <CommentThread
      key={thread.id}
      comment={thread}
      focused
      startReplying={startReplying}
      mentionProjectId={mentionProjectId}
      {...callbacks}
    />
  );
}

/** Desktop: a column beside the conversation. */
export function ReaderThreadPanel({
  thread,
  others,
  summary,
  mentionProjectId,
  callbacks,
  onSelectThread,
}: ReaderThreadProps) {
  return (
    <aside
      aria-label="Comment thread"
      className="flex min-h-0 w-[380px] shrink-0 flex-col border-0 border-l border-solid border-border-default bg-canvas"
    >
      <div className="shrink-0 border-0 border-b border-solid border-border-default px-4 py-3">
        <p className="m-0 text-sm font-medium text-fg-primary">{summary}</p>
        <p className="m-0 mt-0.5 text-xs text-fg-muted">
          {relativeCommentTime(latestEntry(thread).at)}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
        <Thread thread={thread} mentionProjectId={mentionProjectId} callbacks={callbacks} />
        <OtherThreads threads={others} onSelect={onSelectThread} />
      </div>
    </aside>
  );
}

/** Vertical travel, in px, that counts as a swipe on the sheet's handle rather than a tap. */
const SWIPE_PX = 24;

/**
 * Phone: a sheet over the bottom of the conversation. Collapsed, it shows who moved last and
 * what they said, so the passage and the comment are on one screen; open, the whole thread.
 */
export const ReaderThreadSheet = forwardRef<
  HTMLElement,
  ReaderThreadProps & {
    open: boolean;
    replying: boolean;
    onOpenChange: (open: boolean, reply?: boolean) => void;
  }
>(function ReaderThreadSheet(
  {
    thread,
    others,
    summary,
    mentionProjectId,
    callbacks,
    onSelectThread,
    open,
    replying,
    onOpenChange,
  },
  ref
) {
  const latest = latestEntry(thread);
  // Swipe up opens the sheet and down closes it, as the handle suggests; a tap toggles.
  const touchStartY = useRef<number | null>(null);
  return (
    <section
      ref={ref}
      aria-label="Comment thread"
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl border border-b-0 border-border-default bg-surface shadow-[0_-10px_30px_rgba(0,0,0,0.45)] ${
        open ? 'h-[78%]' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        onTouchStart={(event) => {
          touchStartY.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(event) => {
          const start = touchStartY.current;
          const end = event.changedTouches[0]?.clientY;
          touchStartY.current = null;
          if (start === null || end === undefined || Math.abs(end - start) < SWIPE_PX) return;
          onOpenChange(end < start);
        }}
        aria-expanded={open}
        aria-label={open ? 'Hide the thread' : `Show the whole thread. ${summary}`}
        className="flex w-full shrink-0 flex-col gap-1.5 px-4 pt-2 pb-2 text-left focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <span aria-hidden="true" className="mx-auto mb-1 h-1 w-10 rounded-full bg-border-default" />
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            name={authorDisplayName(latest.author)}
            imageUrl={latest.author.avatarUrl}
            tone={latest.author.kind === 'agent' ? 'agent' : 'human'}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-primary">
            {summary}
          </span>
          <span className="shrink-0 text-xs text-fg-muted tabular-nums">
            {relativeCommentTime(latest.at)}
          </span>
          <ChevronUp
            size={18}
            aria-hidden="true"
            className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
        {!open && (
          <span className="line-clamp-2 text-sm leading-snug text-fg-primary [overflow-wrap:anywhere]">
            {latest.body}
          </span>
        )}
      </button>
      {open ? (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-4">
          <Thread
            thread={thread}
            mentionProjectId={mentionProjectId}
            callbacks={callbacks}
            startReplying={replying}
          />
          <OtherThreads
            threads={others}
            onSelect={(threadId) => {
              onOpenChange(false);
              onSelectThread(threadId);
            }}
          />
        </div>
      ) : (
        <div className="shrink-0 px-3 pb-3">
          <button
            type="button"
            onClick={() => onOpenChange(true, true)}
            className="flex min-h-10 w-full items-center rounded-lg border border-border-default bg-inset px-3 text-sm text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            Reply…
          </button>
        </div>
      )}
    </section>
  );
});
