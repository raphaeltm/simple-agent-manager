import type { InboxItem, InboxItemContext } from '@simple-agent-manager/shared';
import { Check, ChevronDown, CircleAlert, Undo2, X } from 'lucide-react';
import { type ReactNode, type Ref, useState } from 'react';
import { Link } from 'react-router';

import {
  agentStateLong,
  contextSummary,
  isIrreversibleApproval,
  isPausedOnItem,
  KIND_META,
  linkIcon,
  linkLabel,
  linkTarget,
  timeLeft,
} from './inbox-model';

/** Agent-chosen links as one scrolling row of chips; each resolves with the reader's access. */
export function InboxLinkChips({ item }: { item: InboxItem }) {
  if (item.links.length === 0) return null;
  const chip =
    'flex h-11 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full border border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)] px-3 text-[13px] text-fg-primary no-underline sm:h-9';
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
      {item.links.map((link) => {
        const Icon = linkIcon(link);
        const target = linkTarget(item.projectId, link);
        const content = (
          <>
            <Icon size={13} aria-hidden="true" className="shrink-0 text-fg-muted" />
            <span className="min-w-0 truncate">{linkLabel(link)}</span>
          </>
        );
        const key = `${link.kind}:${link.id}`;
        if (!target)
          return (
            <span key={key} className={chip}>
              {content}
            </span>
          );
        return target.external ? (
          <a
            key={key}
            href={target.href}
            target="_blank"
            rel="noopener noreferrer"
            className={chip}
            title={target.href}
          >
            {content}
            {/* The agent wrote the label; the host says where the link really goes. */}
            {target.host && (
              <span className="shrink-0 text-[11px] text-fg-muted">· {target.host}</span>
            )}
          </a>
        ) : (
          <Link key={key} to={target.href} className={chip}>
            {content}
          </Link>
        );
      })}
    </div>
  );
}

/** Messages before the ask and what the agent did since, collapsed to one line. */
export function InboxContextDisclosure({ context }: { context: InboxItemContext }) {
  const [open, setOpen] = useState(false);
  const sinceCount = context.since.messages.length + context.since.activityCount;
  return (
    <div className="rounded-xl border border-[var(--sam-hairline)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-xl border-0 bg-transparent px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <span className="font-medium text-fg-primary">Context</span>
        <span className="min-w-0 flex-1 text-fg-muted">
          {contextSummary(context.before.length, sinceCount)}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--sam-hairline)] px-3 py-3">
          {context.before.length > 0 && (
            <div className="flex flex-col gap-2">
              {context.before.map((message) => (
                <p
                  key={message.id}
                  className="m-0 text-sm whitespace-pre-wrap break-words text-fg-secondary [overflow-wrap:anywhere]"
                >
                  <span className="font-medium text-fg-primary">
                    {message.role === 'user' ? 'You' : 'Agent'}:{' '}
                  </span>
                  {message.content}
                  {message.truncated ? '…' : ''}
                </p>
              ))}
            </div>
          )}
          <div>
            <p className="m-0 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">
              Since it asked
            </p>
            {sinceCount === 0 ? (
              <p className="m-0 text-sm text-fg-muted">Nothing yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {context.since.messages.map((message) => (
                  <p
                    key={message.id}
                    className="m-0 text-sm whitespace-pre-wrap break-words text-fg-secondary [overflow-wrap:anywhere]"
                  >
                    {message.content}
                    {message.truncated ? '…' : ''}
                  </p>
                ))}
                {context.since.activityCount > 0 && (
                  <p className="m-0 text-xs text-fg-muted">
                    {context.since.activityCount} tool run
                    {context.since.activityCount === 1 ? '' : 's'}
                    {context.since.truncated ? ' and more' : ''}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "2 of 3 from Ship billing": the one counter shown inside a stack. */
export function InboxStackCounter({
  position,
}: {
  position: { index: number; total: number; topic: string | null };
}) {
  return (
    <p className="m-0 text-xs text-fg-muted" data-testid="inbox-stack-counter">
      {position.index} of {position.total} from{' '}
      <span className="text-fg-secondary">{position.topic ?? 'this chat'}</span>
    </p>
  );
}

export interface InboxReceipt {
  id: number;
  text: string;
  tone: 'success' | 'error';
  /** Present while an archive can still be undone. */
  onUndo?: () => void;
  /** Error receipts stay until dismissed. */
  onDismiss?: () => void;
}

/** One line above the next item after answering or archiving. */
export function InboxReceiptLine({ receipt }: { receipt: InboxReceipt }) {
  const success = receipt.tone === 'success';
  return (
    <div
      className={`flex min-w-0 items-center gap-2 border-b border-[var(--sam-hairline)] px-4 py-2 text-sm ${
        success ? 'text-[var(--sam-status-success-fg)]' : 'text-danger-fg'
      }`}
      data-testid="inbox-receipt"
    >
      {success ? (
        <Check size={15} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />
      ) : (
        <CircleAlert size={15} aria-hidden="true" className="shrink-0" />
      )}
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{receipt.text}</span>
      {receipt.onUndo && (
        <button
          type="button"
          onClick={receipt.onUndo}
          className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 font-semibold text-fg-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <Undo2 size={14} aria-hidden="true" /> Undo
        </button>
      )}
      {receipt.onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={receipt.onDismiss}
          className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-fg-muted hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * An always-mounted live region for receipts: screen readers announce a change of its content
 * reliably, but not a region that is inserted together with its text.
 */
export function InboxReceiptRegion({ receipt }: { receipt: InboxReceipt | null }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="shrink-0">
      {receipt && <InboxReceiptLine receipt={receipt} />}
    </div>
  );
}

/**
 * The ask: kind and agent state on one muted line, the title, the agent's reason, link chips and
 * the collapsed context. Answer controls are not here: the page pins them at the bottom.
 */
export function InboxItemBody({
  item,
  context,
  now,
  stackPosition,
  detail,
  headingRef,
}: {
  item: InboxItem;
  context: InboxItemContext | null;
  now: number;
  stackPosition: { index: number; total: number; topic: string | null } | null;
  /** What the ask is about, right under the reason (a permission's command). */
  detail?: ReactNode;
  /** The title takes focus when an item opens (tabIndex -1). */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const left = timeLeft(item, now);
  const state = left !== null ? `Expires in ${left}` : agentStateLong(item);
  const amber = left !== null || isPausedOnItem(item);
  const irreversible = isIrreversibleApproval(item.answerSpec);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="inbox-item-body">
      {stackPosition && <InboxStackCounter position={stackPosition} />}
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
        <span className="font-medium text-fg-secondary">{KIND_META[item.kind].label}</span>
        {state && (
          <>
            <span aria-hidden="true">·</span>
            <span className={amber ? 'text-warning-fg' : ''}>{state}</span>
          </>
        )}
        {item.status !== 'open' && (
          <>
            <span aria-hidden="true">·</span>
            <span>{item.status}</span>
          </>
        )}
      </p>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-lg leading-snug font-semibold break-words text-fg-primary outline-none [overflow-wrap:anywhere]"
      >
        {item.title}
      </h2>
      {item.body && (
        // Agent-written: plain text, never markup.
        <p className="m-0 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-fg-secondary [overflow-wrap:anywhere]">
          {item.body}
        </p>
      )}
      {item.answerSpec.type === 'secret' && (
        <code className="w-fit max-w-full rounded-sm bg-inset px-1.5 py-0.5 text-[0.8125rem] font-semibold text-fg-primary [overflow-wrap:anywhere]">
          {item.answerSpec.envKey}
        </code>
      )}
      {item.answerSpec.type === 'approval' && (
        <p className="m-0 font-mono text-xs break-all text-fg-muted">
          {item.answerSpec.action} · {item.answerSpec.targetType} {item.answerSpec.targetId}
        </p>
      )}
      {irreversible && (
        <p className="m-0 text-xs font-semibold text-danger-fg">
          Cannot be undone: approving permanently deletes this{' '}
          {item.answerSpec.type === 'approval' ? item.answerSpec.targetType : 'target'}.
        </p>
      )}
      {detail}
      <InboxLinkChips item={item} />
      {context && <InboxContextDisclosure context={context} />}
    </div>
  );
}
