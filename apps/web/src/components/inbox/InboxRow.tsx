import type { InboxItem } from '@simple-agent-manager/shared';
import { Inbox } from 'lucide-react';
import { memo, type ReactNode } from 'react';

import {
  agentStateShort,
  formatAge,
  type InboxRowModel,
  type InboxView,
  isPausedOnItem,
  KIND_META,
  timeLeft,
} from './inbox-model';

/** Kind icon. Amber only when the agent is stopped on this ask, or a live deadline runs. */
export function InboxKindIcon({ item, now }: { item: InboxItem; now: number }) {
  const Icon = KIND_META[item.kind].icon;
  const tone =
    item.kind === 'error'
      ? 'bg-danger-tint text-danger-fg'
      : isPausedOnItem(item) || timeLeft(item, now) !== null
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

interface MetaSegment {
  key: string;
  text: string;
  /** Long, agent- or user-written text that may truncate; short facts never do. */
  flexible?: boolean;
  className?: string;
}

/**
 * A wrapping line of facts joined by "·". Each dot trails its fact inside one unbreakable group, so
 * a wrap never strands a dot on a line of its own or starts a line with one.
 */
export function InboxMetaSegments({ segments }: { segments: MetaSegment[] }) {
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-fg-muted">
      {segments.map((segment, index) => (
        <span
          key={segment.key}
          className={`inline-flex items-center gap-1 ${segment.flexible ? 'min-w-0 max-w-full' : 'shrink-0'}`}
        >
          <span
            className={`${segment.flexible ? 'min-w-0 truncate' : ''} ${segment.className ?? ''}`}
          >
            {segment.text}
          </span>
          {index < segments.length - 1 && <span aria-hidden="true">·</span>}
        </span>
      ))}
    </span>
  );
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
  const left = timeLeft(item, now);
  const state = left !== null ? `${left} left` : agentStateShort(item);
  const amber = left !== null || isPausedOnItem(item);
  const segments: MetaSegment[] = [];
  if (showProject && item.projectName)
    segments.push({ key: 'project', text: item.projectName, flexible: true });
  if (item.topic) segments.push({ key: 'topic', text: item.topic, flexible: true });
  segments.push({ key: 'age', text: formatAge(item.createdAt, now) });
  if (state)
    segments.push({ key: 'state', text: state, className: amber ? 'text-warning-fg' : '' });
  return <InboxMetaSegments segments={segments} />;
}

/**
 * One inbox row: kind icon, the ask in one sentence, then where it came from and the agent's
 * state. A stack (several items from one chat) shows its first item and "3 from <chat>".
 * Reused by the Inbox page, the quick view and (later) "Needs you" on the Project Overview.
 */
export const InboxRow = memo(function InboxRow({
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
      {/* The cards behind the first one. The front card is translucent, so each back card is
          clipped to the 3px it shows below the card in front of it: unclipped, its outline and
          fill showed through the front card. */}
      {stack && (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-x-5 bottom-0 h-3 rounded-b-xl border-x border-b border-[var(--sam-hairline)] bg-[var(--sam-glass-v2-fill-quiet)] [clip-path:inset(9px_0_0_0)]"
          />
          <span
            aria-hidden="true"
            className="absolute inset-x-3 bottom-[3px] h-3 rounded-b-xl border-x border-b border-[var(--sam-hairline)] bg-[var(--sam-glass-v2-fill-quiet)] [clip-path:inset(9px_0_0_0)]"
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
          data-inbox-refs={(stack ?? [first]).map((member) => member.ref).join(' ')}
          className="flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <InboxKindIcon item={first} now={now} />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-3 text-[15px] leading-snug font-medium break-words text-fg-primary [overflow-wrap:anywhere]">
              <span className="sr-only">{KIND_META[first.kind].label}: </span>
              {first.title}
            </span>
            {stack ? (
              <InboxMetaSegments
                segments={[
                  {
                    key: 'count',
                    text: `${stack.length} from ${first.topic ?? 'one chat'}`,
                    flexible: true,
                    className: 'font-medium text-fg-secondary',
                  },
                  ...(showProject && first.projectName
                    ? [{ key: 'project', text: first.projectName, flexible: true }]
                    : []),
                  ...(stack.some(isPausedOnItem)
                    ? [{ key: 'paused', text: 'paused', className: 'text-warning-fg' }]
                    : []),
                ]}
              />
            ) : (
              <InboxMetaLine item={first} showProject={showProject} now={now} />
            )}
          </span>
        </button>
        {children}
      </div>
    </li>
  );
});

const EMPTY_COPY: Record<InboxView, { title: string; body: string }> = {
  needs_you: {
    title: 'Nothing needs you',
    body: 'Questions, approvals, reviews and results from your agents land here.',
  },
  blocking: { title: 'No agent is waiting on you', body: 'Asks an agent is stopped on show here.' },
  tasks: { title: 'No tasks for you', body: 'Tasks agents assign to you show here.' },
  reviews: { title: 'Nothing to review', body: 'Work an agent asks you to check shows here.' },
  updates: {
    title: 'No updates',
    body: 'Finished tasks, pull requests and mentions show up here.',
  },
  archived: { title: 'Nothing archived', body: 'Items you archive are listed here.' },
};

export function InboxEmptyState({
  view = 'needs_you',
  onShowUpdates,
}: {
  view?: InboxView;
  onShowUpdates?: () => void;
}) {
  const copy = EMPTY_COPY[view];
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center" role="status">
      <span className="sam-well grid h-12 w-12 place-items-center rounded-full text-fg-muted">
        <Inbox size={22} aria-hidden="true" />
      </span>
      <p className="m-0 text-[15px] font-semibold text-fg-primary">{copy.title}</p>
      <p className="m-0 max-w-[280px] text-sm text-fg-muted">{copy.body}</p>
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
