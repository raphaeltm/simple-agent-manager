/**
 * One comment in the inbox, read like a notification: who did what and where, the passage it
 * is about (in its sentence), and the latest message. Reply and Resolve work in place.
 */
import { Avatar } from '@simple-agent-manager/ui';
import { Bot, Check, Reply, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { type InboxItem, ME } from './mock-data';
import { bucketFor, excerptFor, lastEntry, reasonFor, relative, sourceLabel } from './model';
import { CardAction, ExcerptText, flatten, ReplyBox, RichText, SourceIcon, UnreadDot } from './ui';

export function sourceTitle(item: InboxItem): string {
  return item.source.kind === 'chat' ? item.source.chatTitle : item.source.fileName;
}

export function sourceText(item: InboxItem): string {
  return item.source.kind === 'chat' ? item.source.message.text : item.source.text;
}

export function canSendToAgent(item: InboxItem): boolean {
  return item.source.kind === 'chat' && item.source.youControl && item.status !== 'resolved';
}

export function replyPlaceholder(item: InboxItem): string {
  const last = lastEntry(item);
  if (last.author.id === ME.id) return 'Add to this thread…';
  if (last.author.kind === 'agent') return 'Reply to the agent…';
  return `Reply to ${last.author.name.split(' ')[0]}…`;
}

export function readerHint(item: InboxItem): string | undefined {
  if (item.source.kind === 'file') return 'People see replies here. Files have no agent.';
  if (!item.source.youControl) return `Only ${item.source.ownerName} can send this to the agent.`;
  return undefined;
}

export function InboxCard({
  item,
  selected,
  quickReplyOpen,
  onOpen,
  onToggleQuickReply,
  onReply,
  onResolve,
  onReopen,
}: {
  item: InboxItem;
  selected: boolean;
  quickReplyOpen: boolean;
  onOpen: () => void;
  onToggleQuickReply: () => void;
  onReply: (body: string, sendToAgent: boolean) => void;
  onResolve: () => void;
  onReopen: () => void;
}) {
  const last = lastEntry(item);
  const bucket = bucketFor(item);
  const reason = reasonFor(item);
  const excerpt = excerptFor(sourceText(item), item.quote, { before: 70, after: 110 });
  const count = item.entries.length;
  const resolved = item.status === 'resolved';
  const replyRef = useRef<HTMLDivElement>(null);

  // Bring the whole reply box, buttons included, into view when it opens.
  useEffect(() => {
    if (quickReplyOpen) replyRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [quickReplyOpen]);

  return (
    <article
      data-item-id={item.id}
      data-bucket={bucket}
      className={`min-w-0 rounded-xl border bg-surface transition-colors ${
        selected ? 'border-focus-ring' : 'border-border-default'
      } ${resolved ? 'opacity-75' : ''}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 flex-col gap-2.5 rounded-t-xl p-3 text-left transition-colors hover:bg-surface-hover/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
        aria-label={`${reason.actor} ${reason.verb}: open the comment`}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <Avatar
            name={last.author.name}
            tone={last.author.kind === 'agent' ? 'agent' : 'human'}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-sm leading-snug text-fg-primary [overflow-wrap:anywhere]">
              <span className="font-semibold">{reason.actor}</span> {reason.verb}
            </p>
            <p className="m-0 mt-0.5 flex min-w-0 items-center gap-1 text-xs text-fg-muted">
              <SourceIcon kind={item.source.kind} size={12} />
              <span className="min-w-0 truncate">{sourceTitle(item)}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{relative(last.at)}</span>
            </p>
          </div>
          {bucket === 'needs_you' && <UnreadDot />}
        </div>

        <div className="min-w-0 rounded-lg border-0 border-l-2 border-solid border-border-default bg-inset px-2.5 py-2">
          <p className="m-0 mb-0.5 text-[0.6875rem] font-medium text-fg-muted">
            On{' '}
            {sourceLabel(item)
              .replace(/^The /, 'the ')
              .replace(/^Your /, 'your ')}
          </p>
          <ExcerptText excerpt={excerpt} className="line-clamp-3" />
        </div>

        <RichText text={flatten(last.body)} className="line-clamp-3" />

        {item.status === 'sent' && bucket === 'waiting' && (
          <p className="m-0 flex items-center gap-1.5 text-xs text-info-fg">
            <Bot size={13} aria-hidden /> Sent to the agent · waiting for a reply
          </p>
        )}
      </button>

      <div className="flex min-w-0 items-center gap-0.5 border-0 border-t border-solid border-border-default px-1.5 py-1">
        <CardAction
          icon={<Reply size={15} aria-hidden />}
          onClick={onToggleQuickReply}
          pressed={quickReplyOpen}
        >
          Reply
        </CardAction>
        {resolved ? (
          <CardAction icon={<RotateCcw size={14} aria-hidden />} onClick={onReopen}>
            Reopen
          </CardAction>
        ) : (
          <CardAction icon={<Check size={15} aria-hidden />} onClick={onResolve}>
            Resolve
          </CardAction>
        )}
        {count > 1 && (
          <span className="ml-auto pr-2 text-xs tabular-nums text-fg-muted">{count} messages</span>
        )}
      </div>

      {quickReplyOpen && (
        <div
          ref={replyRef}
          className="scroll-mb-4 border-0 border-t border-solid border-border-default px-3 pt-2.5 pb-3"
        >
          <ReplyBox
            focusOnMount
            canSendToAgent={canSendToAgent(item)}
            readerHint={readerHint(item)}
            placeholder={replyPlaceholder(item)}
            onSubmit={onReply}
            onCancel={onToggleQuickReply}
          />
        </div>
      )}
    </article>
  );
}
