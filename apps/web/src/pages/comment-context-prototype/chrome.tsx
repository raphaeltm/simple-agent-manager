/**
 * Headers, the desktop comment list and the prototype's direction switcher.
 */
import { Avatar } from '@simple-agent-manager/ui';
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { relative } from '../comments-inbox-prototype/model';
import { type ChatSession, type ContextThread, positionOf, SESSIONS } from './mock-session';

export type Direction = 'a' | 'b' | 'c';

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'a', label: 'A · Reader + thread' },
  { value: 'b', label: 'B · Thread inline' },
  { value: 'c', label: 'C · Expand around' },
];

export function DirectionSwitcher({
  value,
  onChange,
}: {
  value: Direction;
  onChange: (next: Direction) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-0 border-b border-dashed border-border-default bg-inset px-2 py-1.5 [scrollbar-width:none]"
      data-intentional-clip="prototype direction switcher scrolls sideways on a phone"
    >
      <span className="shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        Prototype
      </span>
      {DIRECTIONS.map((direction) => (
        <button
          key={direction.value}
          type="button"
          aria-pressed={value === direction.value}
          onClick={() => onChange(direction.value)}
          className={`h-7 shrink-0 rounded-full px-2.5 text-xs font-medium ${
            value === direction.value
              ? 'bg-surface-hover text-fg-primary'
              : 'text-fg-muted hover:text-fg-primary'
          }`}
        >
          {direction.label}
        </button>
      ))}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:opacity-35"
    >
      {children}
    </button>
  );
}

export interface CommentNav {
  position: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}

/** "Your chat · Idle · message 5 of 17" — which chat, and where in it. */
export function chatMeta(session: ChatSession, thread: ContextThread): string {
  const owner = session.ownerName === 'You' ? 'Your chat' : `${session.ownerName}'s chat`;
  return `${owner} · ${session.state} · message ${positionOf(session, thread.anchorId)} of ${session.items.length}`;
}

/** Header above the conversation: the chat, where the comment is in it, and comment nav. */
export function ReaderHeader({
  session,
  thread,
  nav,
  onBack,
}: {
  session: ChatSession;
  thread: ContextThread;
  nav: CommentNav;
  onBack?: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-0 border-b border-solid border-border-default px-2 py-1.5">
      {onBack && (
        <IconButton label="Back to comments" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden />
        </IconButton>
      )}
      <div className="min-w-0 flex-1 px-1.5">
        <p className="m-0 truncate text-sm font-semibold text-fg-primary" title={session.title}>
          {session.title}
        </p>
        <p className="m-0 truncate text-xs text-fg-muted">{chatMeta(session, thread)}</p>
      </div>
      <span className="hidden shrink-0 px-1 text-xs tabular-nums text-fg-muted sm:inline">
        {nav.position} of {nav.total}
      </span>
      <IconButton label="Previous comment" onClick={nav.onPrev} disabled={!nav.onPrev}>
        <ChevronUp size={18} aria-hidden />
      </IconButton>
      <IconButton label="Next comment" onClick={nav.onNext} disabled={!nav.onNext}>
        <ChevronDown size={18} aria-hidden />
      </IconButton>
      <a
        href="#open-chat"
        onClick={(event) => event.preventDefault()}
        className="hidden h-8 shrink-0 items-center gap-1 rounded-md border border-border-default px-2.5 text-xs font-medium text-fg-primary no-underline hover:bg-surface-hover sm:inline-flex"
      >
        Open chat <ArrowUpRight size={13} aria-hidden />
      </a>
    </header>
  );
}

/** Compact desktop list of comments: who did what, where, and the quoted words. */
export function CommentList({
  threads,
  activeThreadId,
  onSelect,
}: {
  threads: ContextThread[];
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col border-0 border-r border-solid border-border-default">
      <div className="shrink-0 px-4 pt-5 pb-3">
        <h1 className="m-0 text-xl font-semibold text-fg-primary">Comments</h1>
      </div>
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-2 pt-0">
        {threads.map((thread) => {
          const last = thread.entries[thread.entries.length - 1];
          const session = SESSIONS[thread.sessionId];
          const active = thread.id === activeThreadId;
          return (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => onSelect(thread.id)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full min-w-0 items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors ${
                  active
                    ? 'border-focus-ring bg-surface'
                    : 'border-transparent hover:bg-surface-hover'
                }`}
              >
                <Avatar
                  name={last?.author.name}
                  tone={last?.author.kind === 'agent' ? 'agent' : 'human'}
                  size="lg"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm leading-snug text-fg-primary">
                    <span className="font-semibold">{thread.reason.actor}</span>{' '}
                    {thread.reason.verb}
                  </span>
                  <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                    <MessageSquare size={11} aria-hidden className="shrink-0" />
                    <span className="truncate">{session?.title}</span>
                    <span className="shrink-0">· {last ? relative(last.at) : ''}</span>
                  </span>
                  <span className="line-clamp-1 text-xs italic text-fg-muted">
                    “{thread.quote}”
                  </span>
                </span>
                {thread.needsYou && (
                  <span
                    aria-label="Needs you"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: 'var(--sam-color-warning)' }}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
