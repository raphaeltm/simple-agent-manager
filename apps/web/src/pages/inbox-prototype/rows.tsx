/** PROTOTYPE ONLY — list building blocks for /prototype/inbox. */
import { PersonAvatar } from '@simple-agent-manager/ui';
import {
  CircleCheckBig,
  Eye,
  GitPullRequest,
  Inbox,
  KeyRound,
  ListChecks,
  MessageCircleQuestion,
  Rocket,
  ShieldCheck,
  ShieldQuestion,
  TrendingUp,
  Users,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

import { type InboxItem, type Kind, must, PEOPLE, UPDATES } from './mock-data';
import { type Filter, formatAge, type Row } from './model';

export const KIND_META: Record<Kind, { label: string; icon: typeof Inbox }> = {
  question: { label: 'Question', icon: MessageCircleQuestion },
  permission: { label: 'Permission', icon: ShieldQuestion },
  secret: { label: 'Secret', icon: KeyRound },
  approval: { label: 'Approval', icon: ShieldCheck },
  task: { label: 'Task', icon: ListChecks },
  review: { label: 'Review', icon: Eye },
};

/** Amber only when the agent is stopped on this ask: the one exception worth colour. */
export function KindIcon({ item, size = 32 }: { item: InboxItem; size?: 28 | 32 }) {
  const Icon = KIND_META[item.kind].icon;
  const waiting = item.agent === 'paused' && item.blocking;
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full ${size === 32 ? 'h-8 w-8' : 'h-7 w-7'} ${
        waiting ? 'bg-warning-tint text-warning-fg' : 'sam-well text-fg-muted'
      }`}
    >
      <Icon size={size === 32 ? 16 : 14} strokeWidth={2} />
    </span>
  );
}

export function agentStateText(item: InboxItem, long = false): string {
  if (item.agent === 'paused') return long ? 'Paused, waiting on this' : 'paused on this';
  if (item.agent === 'working') return long ? 'Still working' : 'still working';
  return 'finished';
}

/** Second row line: project · chat · age · state (plus who holds a team item). */
export function MetaLine({ item, showProject = true }: { item: InboxItem; showProject?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
      {showProject && <span className="shrink-0">{item.project}</span>}
      {showProject && <span aria-hidden="true">·</span>}
      <span className="min-w-0 truncate">{item.chat}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{formatAge(item.ageMin)}</span>
      <span aria-hidden="true">·</span>
      <span className={`shrink-0 ${item.agent === 'paused' ? 'text-warning-fg' : ''}`}>
        {item.deadlineMin !== undefined ? `${item.deadlineMin}m left` : agentStateText(item)}
      </span>
    </div>
  );
}

export function TeamLine({ item }: { item: InboxItem }) {
  if (!item.team) return null;
  const claimed = item.team.claimedBy;
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
      {claimed ? (
        <>
          <PersonAvatar
            name={PEOPLE[claimed].name}
            person={PEOPLE[claimed].slot}
            size={14}
            decorative
          />
          {PEOPLE[claimed].name.split(' ')[0]} took it
        </>
      ) : (
        <>
          <Users size={13} aria-hidden="true" /> Anyone on the team
        </>
      )}
    </div>
  );
}

export function InboxRow({
  row,
  selectedId,
  onOpen,
  children,
  trailing,
}: {
  row: Row;
  selectedId?: string | null;
  onOpen: (id: string) => void;
  /** Direction C puts quick answers under the row. */
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  const first = row.type === 'group' ? must(row.items[0]) : row.item;
  const selected =
    row.type === 'group' ? row.items.some((i) => i.id === selectedId) : first.id === selectedId;
  return (
    <li className={`relative list-none ${row.type === 'group' ? 'pb-1.5' : ''}`}>
      {row.type === 'group' && (
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
        className={`relative rounded-xl ${selected ? 'sam-raised' : row.type === 'group' ? 'sam-glass--quiet bg-[var(--sam-glass-v2-fill-quiet)]' : ''}`}
      >
        <div className="flex items-start gap-3 px-3 py-2.5">
          <button
            type="button"
            onClick={() => onOpen(first.id)}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 border-0 bg-transparent p-0 text-left"
          >
            <KindIcon item={first} />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[15px] leading-snug font-medium break-words text-fg-primary">
                {first.title}
              </span>
              {row.type === 'group' ? (
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                  <span className="shrink-0 font-medium text-fg-secondary">
                    {row.items.length} from
                  </span>
                  <span className="min-w-0 truncate">{first.chat}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">{first.project}</span>
                  {row.items.some((i) => i.agent === 'paused') && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0 text-warning-fg">paused</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="mt-0.5 block">
                  <MetaLine item={first} />
                  <TeamLine item={first} />
                </span>
              )}
            </span>
          </button>
          {trailing}
        </div>
        {children}
      </div>
    </li>
  );
}

export const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Needs you' },
  { value: 'blocking', label: 'Blocking' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'updates', label: 'Updates' },
  { value: 'archived', label: 'Archived' },
];

/**
 * One scrolling chip row carries both levels (Needs you / Updates and the kind filters).
 * Two stacked rows cost ~44px of a 667px phone screen for a control used rarely.
 */
export function FilterBar({
  value,
  onChange,
  counts,
}: {
  value: Filter;
  onChange: (f: Filter) => void;
  counts: Partial<Record<Filter, number>>;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <div
      role="tablist"
      aria-label="Inbox filters"
      className="flex min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none]"
    >
      {FILTERS.map((f) => {
        const current = f.value === value;
        const count = counts[f.value];
        return (
          <button
            key={f.value}
            ref={current ? currentRef : undefined}
            type="button"
            role="tab"
            aria-selected={current}
            onClick={() => onChange(f.value)}
            className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 text-[13px] ${
              current ? 'sam-raised font-medium text-fg-primary' : 'sam-well text-fg-muted'
            }`}
          >
            {f.label}
            {count !== undefined && count > 0 && (
              <span
                className={`font-mono text-[11px] ${current ? 'text-[var(--sam-status-success-fg)]' : ''}`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyInbox({ onUpdates }: { onUpdates: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <span className="sam-well grid h-12 w-12 place-items-center rounded-full text-fg-muted">
        <Inbox size={22} aria-hidden="true" />
      </span>
      <p className="m-0 text-[15px] font-semibold text-fg-primary">Nothing needs you</p>
      <p className="m-0 max-w-[260px] text-sm text-fg-muted">
        Questions, approvals and tasks from your agents land here.
      </p>
      <button
        type="button"
        onClick={onUpdates}
        className="mt-1 cursor-pointer border-0 bg-transparent text-sm text-accent"
      >
        See today’s updates
      </button>
    </div>
  );
}

const UPDATE_ICONS = {
  pr: GitPullRequest,
  done: CircleCheckBig,
  deploy: Rocket,
  progress: TrendingUp,
};

export function UpdatesList() {
  return (
    <ul className="m-0 flex flex-col p-0">
      {UPDATES.map((u) => {
        const Icon = UPDATE_ICONS[u.kind];
        return (
          <li key={u.id} className="flex list-none items-start gap-3 px-3 py-2.5">
            <span className="sam-well grid h-8 w-8 shrink-0 place-items-center rounded-full text-fg-muted">
              <Icon size={15} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm break-words text-fg-primary">{u.text}</span>
              <span className="text-xs text-fg-muted">
                {u.project} · {formatAge(u.ageMin)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
