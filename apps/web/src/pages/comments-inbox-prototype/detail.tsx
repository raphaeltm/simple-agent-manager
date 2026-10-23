/**
 * One comment, opened. Everything needed to answer without visiting the chat: where it lives,
 * the passage in its message (expandable to the whole message), the full thread, and a reply
 * field pinned to the bottom. "Open chat" is there for when the excerpt is not enough.
 */
import { Avatar, Button } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  RotateCcw,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import {
  canSendToAgent,
  readerHint,
  replyPlaceholder,
  sourceText,
  sourceTitle,
} from './inbox-card';
import { AGENT, type InboxItem } from './mock-data';
import { bucketFor, excerptFor, relative, sourceLabel } from './model';
import { ExcerptText, renderInline, ReplyBox, RichText, SourceIcon } from './ui';

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
      className="flex h-9 w-9 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

const STATE_LABEL = { working: 'Agent working', idle: 'Idle', sleeping: 'Asleep' } as const;

function WholeText({ text, quote }: { text: string; quote: string | null }) {
  const plain = text.replace(/\*\*/g, '');
  // The quote was selected from rendered text, which has no backticks.
  const index = quote ? plain.replace(/`/g, '').indexOf(quote) : -1;
  if (!quote || index === -1) return <RichText text={plain} className="text-fg-muted" />;
  // Map a backtick-free offset back onto `plain`, which still has its backticks.
  const toPlain = (target: number) => {
    let seen = 0;
    let at = 0;
    while (at < plain.length && seen < target) {
      if (plain[at] !== '`') seen += 1;
      at += 1;
    }
    return at;
  };
  const start = toPlain(index);
  const end = toPlain(index + quote.length);
  return (
    <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
      {renderInline(plain.slice(0, start))}
      <mark className="rounded-[3px] bg-[color-mix(in_srgb,var(--sam-color-warning)_24%,transparent)] px-0.5 text-fg-primary [box-decoration-break:clone]">
        {plain.slice(start, end).replace(/`/g, '')}
      </mark>
      {renderInline(plain.slice(end))}
    </p>
  );
}

export function CommentDetail({
  item,
  position,
  total,
  onPrev,
  onNext,
  onBack,
  onResolve,
  onReopen,
  onReply,
}: {
  item: InboxItem;
  position: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** Phone only: back to the list. */
  onBack?: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onReply: (body: string, sendToAgent: boolean) => void;
}) {
  const [showWhole, setShowWhole] = useState(false);
  const text = sourceText(item);
  const bucket = bucketFor(item);
  const resolved = item.status === 'resolved';
  const source = item.source;
  const messageAt = source.kind === 'chat' ? source.message.at : null;

  return (
    <section aria-label="Comment" className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex shrink-0 items-center gap-0.5 border-0 border-b border-solid border-border-default px-2 py-1.5">
        {onBack && (
          <IconButton label="Back to comments" onClick={onBack}>
            <ArrowLeft size={18} aria-hidden />
          </IconButton>
        )}
        <span className="px-1.5 text-xs tabular-nums text-fg-muted">
          {position} of {total}
        </span>
        <IconButton label="Previous comment" onClick={onPrev} disabled={!onPrev}>
          <ChevronUp size={18} aria-hidden />
        </IconButton>
        <IconButton label="Next comment" onClick={onNext} disabled={!onNext}>
          <ChevronDown size={18} aria-hidden />
        </IconButton>
        <div className="ml-auto">
          {resolved ? (
            <Button size="sm" variant="ghost" onClick={onReopen}>
              <RotateCcw size={14} aria-hidden /> Reopen
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onResolve}>
              <Check size={15} aria-hidden /> Resolve
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-4 px-4 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-1 text-fg-muted">
              <SourceIcon kind={source.kind} size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                title={sourceTitle(item)}
                className="m-0 line-clamp-2 text-base font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]"
              >
                {sourceTitle(item)}
              </h2>
              <p className="m-0 mt-0.5 text-xs text-fg-muted">
                {source.kind === 'chat'
                  ? `${source.ownerName === 'You' ? 'Your chat' : `${source.ownerName}'s chat`} · ${STATE_LABEL[source.chatState]}`
                  : `Library ${source.folder}`}
              </p>
            </div>
          </div>

          <figure className="m-0 flex min-w-0 flex-col gap-2 rounded-xl border border-border-default bg-inset p-3">
            <figcaption className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
              {source.kind === 'chat' && source.message.by === 'agent' && (
                <Avatar name={AGENT.name} tone="agent" size="sm" />
              )}
              <span className="font-medium text-fg-primary">{sourceLabel(item)}</span>
              {messageAt !== null && <span>· {relative(messageAt)} ago</span>}
            </figcaption>
            {showWhole ? (
              <WholeText text={text} quote={item.quote} />
            ) : (
              <ExcerptText
                excerpt={excerptFor(text, item.quote, { before: 110, after: 150 })}
                className="text-sm"
              />
            )}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setShowWhole((value) => !value)}
                className="flex h-8 items-center gap-1 rounded-md px-1 text-xs font-medium text-accent hover:underline"
              >
                {showWhole
                  ? 'Show less'
                  : `Show the whole ${source.kind === 'chat' ? 'message' : 'section'}`}
                <ChevronDown
                  size={13}
                  aria-hidden
                  className={showWhole ? 'rotate-180 transition-transform' : 'transition-transform'}
                />
              </button>
              <a
                href="#open"
                onClick={(event) => event.preventDefault()}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-fg-muted no-underline hover:text-fg-primary"
              >
                {source.kind === 'chat' ? 'Open in chat' : 'Open the file'}
                <ArrowUpRight size={13} aria-hidden />
              </a>
            </div>
          </figure>

          <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Thread">
            {item.entries.map((entry) => (
              <li key={entry.id} className="flex min-w-0 gap-2.5">
                <Avatar
                  name={entry.author.name}
                  tone={entry.author.kind === 'agent' ? 'agent' : 'human'}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold text-fg-primary [overflow-wrap:anywhere]">
                      {entry.author.name}
                    </span>
                    <span className="text-xs tabular-nums text-fg-muted">{relative(entry.at)}</span>
                    {entry.sentToAgent && (
                      <span className="inline-flex items-center gap-1 text-xs text-info-fg">
                        <Bot size={12} aria-hidden /> Sent to agent
                      </span>
                    )}
                  </div>
                  <RichText text={entry.body} className="mt-0.5" />
                </div>
              </li>
            ))}
          </ol>

          {item.status === 'sent' && bucket === 'waiting' && (
            <p className="m-0 flex items-center gap-1.5 text-xs text-info-fg">
              <Bot size={13} aria-hidden /> Waiting for the agent to reply
            </p>
          )}
          {resolved && (
            <p className="m-0 flex items-center gap-1.5 text-xs text-success-fg">
              <Check size={13} aria-hidden /> Resolved
            </p>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-0 border-t border-solid border-border-default bg-surface px-3 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-[720px]">
          <ReplyBox
            key={item.id}
            canSendToAgent={canSendToAgent(item)}
            readerHint={readerHint(item)}
            placeholder={replyPlaceholder(item)}
            onSubmit={onReply}
          />
        </div>
      </footer>
    </section>
  );
}
