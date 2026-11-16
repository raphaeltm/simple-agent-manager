import type { InboxItem } from '@simple-agent-manager/shared';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  agentStateShort,
  formatAge,
  type InboxRowModel,
  isPausedOnItem,
  KIND_META,
  minutesLeft,
} from './inbox-model';

/** Kind icon. Amber only when the agent is stopped on this ask. */
export function InboxKindIcon({ item }: { item: InboxItem }) {
  const Icon = KIND_META[item.kind].icon;
  const tone =
    item.kind === 'error'
      ? 'bg-danger-tint text-danger-fg'
      : isPausedOnItem(item) || minutesLeft(item, Date.now()) !== null
        ? 'bg-warning-tint text-warning-fg'
        : 'sam-well text-fg-muted';
  return (
    <span
      aria-hidden="true"
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${tone}`}
    >
      <Icon size={16} strokeWidth={2} />
    </span>
  );
}

function Dot() {
  return <span aria-hidden="true">·</span>;
}

/** Second line: project (cross-project only) · chat · age · agent state or time left. */
export function InboxMetaLine({
  item,
  showProject,
  now,
}: {
  item: InboxItem;
  showProject: boolean;
  now: number;
}) {
  const left = minutesLeft(item, now);
  const state = left !== null ? `${left}m left` : agentStateShort(item);
  const amber = left !== null || isPausedOnItem(item);
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-fg-muted">
      {showProject && item.projectName && (
        <>
          <span className="min-w-0 max-w-full truncate">{item.projectName}</span>
          <Dot />
        </>
      )}
      {item.topic && (
        <>
          <span className="min-w-0 max-w-full truncate">{item.topic}</span>
          <Dot />
        </>
      )}
      <span className="shrink-0">{formatAge(item.createdAt, now)}</span>
      {state && (
        <>
          <Dot />
          <span className={`shrink-0 ${amber ? 'text-warning-fg' : ''}`}>{state}</span>
        </>
      )}
    </span>
  );
}

/**
 * One inbox row: kind icon, the ask in one sentence, then where it came from and the agent's
 * state. A stack (several items from one chat) shows its first item and "3 from <chat>".
 * Reused by the Inbox page, the quick view and (later) "Needs you" on the Project Overview.
 */
export function InboxRow({
  row,
  selectedRef,
  showProject,
  now,
  onOpen,
  children,
}: {
  row: InboxRowModel;
  selectedRef?: string | null;
  showProject: boolean;
  now: number;
  onOpen: (item: InboxItem) => void;
  /** Extra content under the row (the quick view's one-tap answers). */
  children?: ReactNode;
}) {
  const first = row.type === 'item' ? row.item : row.items[0];
  if (!first) return null;
  const stack = row.type === 'stack' ? row.items : null;
  const selected = stack
    ? stack.some((item) => item.ref === selectedRef)
    : first.ref === selectedRef;
  return (
    <li className={`relative list-none ${stack ? 'pb-1.5' : ''}`} data-testid="inbox-row">
      {stack && (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-x-5 bottom-0 h-3 rounded-b-xl border-x border-b border-[var(--sam-hairline)] bg-[var(--sam-glass-v2-fill-quiet)]"
          />
          <span
            aria-hidden="true"
            className="absolute inset-x-3 bottom-[3px] h-3 rounded-b-xl border-x border-b border-[var(--sam-hairline)] bg-[var(--sam-glass-v2-fill-quiet)]"
          />
        </>
      )}
      <div
        className={`relative rounded-xl ${selected ? 'sam-raised' : stack ? 'bg-[var(--sam-glass-v2-fill-quiet)]' : ''}`}
      >
        <button
          type="button"
          onClick={() => onOpen(first)}
          aria-current={selected ? 'true' : undefined}
          className="flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <InboxKindIcon item={first} />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-3 text-[15px] leading-snug font-medium break-words text-fg-primary [overflow-wrap:anywhere]">
              {first.title}
            </span>
            {stack ? (
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-fg-muted">
                <span className="shrink-0 font-medium text-fg-secondary">{stack.length} from</span>
                <span className="min-w-0 max-w-full truncate">{first.topic ?? 'one chat'}</span>
                {showProject && first.projectName && (
                  <>
                    <Dot />
                    <span className="min-w-0 max-w-full truncate">{first.projectName}</span>
                  </>
                )}
                {stack.some(isPausedOnItem) && (
                  <>
                    <Dot />
                    <span className="shrink-0 text-warning-fg">paused</span>
                  </>
                )}
              </span>
            ) : (
              <InboxMetaLine item={first} showProject={showProject} now={now} />
            )}
          </span>
        </button>
        {children}
      </div>
    </li>
  );
}

export function InboxEmptyState({
  archived,
  onShowUpdates,
}: {
  archived?: boolean;
  onShowUpdates?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center" role="status">
      <span className="sam-well grid h-12 w-12 place-items-center rounded-full text-fg-muted">
        <Inbox size={22} aria-hidden="true" />
      </span>
      <p className="m-0 text-[15px] font-semibold text-fg-primary">
        {archived ? 'Nothing archived' : 'Nothing needs you'}
      </p>
      <p className="m-0 max-w-[280px] text-sm text-fg-muted">
        {archived
          ? 'Items you archive are listed here.'
          : 'Questions, approvals and reviews from your agents land here.'}
      </p>
      {onShowUpdates && (
        <button
          type="button"
          onClick={onShowUpdates}
          className="mt-1 min-h-11 cursor-pointer border-0 bg-transparent px-2 text-sm text-accent"
        >
          See updates
        </button>
      )}
    </div>
  );
}
