/**
 * Direction A — "Reader + thread". The conversation is the main surface, opened on the
 * commented passage; the thread sits beside it (desktop) or in a bottom sheet (phone), so
 * scrolling the conversation never loses the comment and the comment never hides the context.
 */
import { Avatar } from '@simple-agent-manager/ui';
import { ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { relative } from '../comments-inbox-prototype/model';
import { flatten } from '../comments-inbox-prototype/ui';
import { type CommentNav, ReaderHeader } from './chrome';
import { type ChatSession, type ContextThread, positionOf } from './mock-session';
import { AnchoredReader } from './reader';
import { ResolveButton, ThreadEntries, ThreadReason, ThreadReply } from './thread-view';

/** Height the collapsed phone sheet takes, kept clear at the bottom of the reader. */
const SHEET_PEEK_PX = 172;

export interface DirectionProps {
  wide: boolean;
  session: ChatSession;
  /** Every thread (the list and comment nav span chats). */
  threads: ContextThread[];
  thread: ContextThread;
  nav: CommentNav;
  onSelectThread: (id: string) => void;
  onReply: (threadId: string, body: string, sendToAgent: boolean) => void;
  onToggleResolved: (threadId: string) => void;
  onBack?: () => void;
  /** Phone only: start with the thread sheet open (for screenshots). */
  sheetOpen?: boolean;
}

/** Other threads on the same chat, so you can hop between them in place. */
export function AlsoInThisChat({
  threads,
  onSelect,
}: {
  threads: ContextThread[];
  onSelect: (id: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="m-0 text-xs font-medium text-fg-muted">Also in this chat</p>
      {threads.map((thread) => {
        const first = thread.entries[0];
        return (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelect(thread.id)}
            className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-border-default px-2.5 py-2 text-left hover:bg-surface-hover"
          >
            <Avatar name={first?.author.name} tone="human" size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs italic text-fg-muted">“{thread.quote}”</span>
              <span className="block truncate text-sm text-fg-primary">
                {first ? flatten(first.body) : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ThreadPanel({
  session,
  thread,
  others,
  onSelectThread,
  onReply,
  onToggleResolved,
}: {
  session: ChatSession;
  thread: ContextThread;
  others: ContextThread[];
  onSelectThread: (id: string) => void;
  onReply: (body: string, sendToAgent: boolean) => void;
  onToggleResolved: () => void;
}) {
  const last = thread.entries[thread.entries.length - 1];
  return (
    <aside
      aria-label="Comment thread"
      className="flex min-h-0 flex-col border-0 border-l border-solid border-border-default"
    >
      <div className="flex shrink-0 items-start gap-2 border-0 border-b border-solid border-border-default px-4 py-3">
        <div className="min-w-0 flex-1">
          <ThreadReason thread={thread} />
          <p className="m-0 mt-0.5 text-xs text-fg-muted">
            {last ? `${relative(last.at)} ago` : ''} · on message{' '}
            {positionOf(session, thread.anchorId)}
          </p>
        </div>
        <ResolveButton resolved={thread.status === 'resolved'} onToggle={onToggleResolved} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
        <ThreadEntries thread={thread} />
        <AlsoInThisChat threads={others} onSelect={onSelectThread} />
      </div>
      <footer className="shrink-0 border-0 border-t border-solid border-border-default px-3 pt-2.5 pb-3">
        <ThreadReply session={session} thread={thread} onReply={onReply} />
      </footer>
    </aside>
  );
}

function ThreadSheet({
  session,
  thread,
  others,
  open,
  onToggle,
  onSelectThread,
  onReply,
  onToggleResolved,
}: {
  session: ChatSession;
  thread: ContextThread;
  others: ContextThread[];
  open: boolean;
  onToggle: () => void;
  onSelectThread: (id: string) => void;
  onReply: (body: string, sendToAgent: boolean) => void;
  onToggleResolved: () => void;
}) {
  const last = thread.entries[thread.entries.length - 1];
  return (
    <section
      aria-label="Comment thread"
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl border border-b-0 border-border-default bg-surface shadow-[0_-10px_30px_rgba(0,0,0,0.45)] ${
        open ? 'h-[74%]' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full shrink-0 flex-col gap-1.5 px-4 pt-2 pb-2 text-left"
      >
        <span aria-hidden className="mx-auto mb-1 h-1 w-10 rounded-full bg-border-default" />
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            name={last?.author.name}
            tone={last?.author.kind === 'agent' ? 'agent' : 'human'}
            size="lg"
          />
          <span className="min-w-0 flex-1">
            <ThreadReason thread={thread} />
          </span>
          <span className="shrink-0 text-xs tabular-nums text-fg-muted">
            {last ? relative(last.at) : ''}
          </span>
          <ChevronUp
            size={18}
            aria-hidden
            className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
        {!open && last && (
          <span className="line-clamp-2 text-sm leading-snug text-fg-primary">
            {flatten(last.body)}
          </span>
        )}
      </button>
      {open ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-4">
            <ThreadEntries thread={thread} dense />
            <AlsoInThisChat threads={others} onSelect={onSelectThread} />
            <div>
              <ResolveButton resolved={thread.status === 'resolved'} onToggle={onToggleResolved} />
            </div>
          </div>
          <footer className="shrink-0 border-0 border-t border-solid border-border-default px-3 pt-2.5 pb-3">
            <ThreadReply session={session} thread={thread} onReply={onReply} />
          </footer>
        </>
      ) : (
        <div className="shrink-0 px-3 pb-3">
          <button
            type="button"
            onClick={onToggle}
            className="flex h-10 w-full items-center rounded-lg border border-border-default bg-inset px-3 text-sm text-fg-muted"
          >
            Reply…
          </button>
        </div>
      )}
    </section>
  );
}

export function DirectionA({
  wide,
  session,
  threads,
  thread,
  nav,
  onSelectThread,
  onReply,
  onToggleResolved,
  onBack,
  sheetOpen = false,
}: DirectionProps) {
  const [open, setOpen] = useState(sheetOpen);
  const sessionThreads = threads.filter((candidate) => candidate.sessionId === session.id);
  const others = sessionThreads.filter((candidate) => candidate.id !== thread.id);
  const reply = (body: string, sendToAgent: boolean) => onReply(thread.id, body, sendToAgent);
  const resolve = () => onToggleResolved(thread.id);

  if (wide) {
    return (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: 'minmax(0, 1fr) 380px' }}>
        <section aria-label="Conversation" className="flex min-h-0 flex-col">
          <ReaderHeader session={session} thread={thread} nav={nav} />
          <AnchoredReader
            session={session}
            threads={sessionThreads}
            activeThread={thread}
            onSelectThread={onSelectThread}
            showTrack
          />
        </section>
        <ThreadPanel
          session={session}
          thread={thread}
          others={others}
          onSelectThread={onSelectThread}
          onReply={reply}
          onToggleResolved={resolve}
        />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <ReaderHeader session={session} thread={thread} nav={nav} onBack={onBack} />
      <AnchoredReader
        session={session}
        threads={sessionThreads}
        activeThread={thread}
        onSelectThread={(id) => {
          onSelectThread(id);
          setOpen(false);
        }}
        quoteRatio={0.22}
        footerSpace={SHEET_PEEK_PX}
      />
      <ThreadSheet
        session={session}
        thread={thread}
        others={others}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        onSelectThread={(id) => {
          onSelectThread(id);
          setOpen(false);
        }}
        onReply={reply}
        onToggleResolved={resolve}
      />
    </div>
  );
}
