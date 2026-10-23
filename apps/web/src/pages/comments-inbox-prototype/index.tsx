/**
 * PROTOTYPE (dev-only route `/prototype/comments-inbox`): the project Comments page as a
 * notification-style inbox. Each item says who did what and where, shows the passage in its
 * message, and can be answered or resolved in place; the chat is opened only when needed.
 *
 * Mock data only, no API calls, no auth. Remove before merging to main
 * (.claude/rules/37-prototype-development.md).
 *
 * URL parameters set the starting state for screenshots: `?open=<id>` opens a comment,
 * `?quick=<id>` opens a card's quick reply, `?filter=waiting|resolved`, `?caughtup=1`.
 */
import { Check, Inbox, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMediaQuery } from '../../hooks/useMediaQuery';
import { CommentDetail } from './detail';
import { AppFrame } from './frame';
import { InboxCard } from './inbox-card';
import { INBOX_ITEMS, type InboxItem, ME } from './mock-data';
import { countFor, type Filter, FILTERS, matchesFilter, sortByActivity } from './model';

interface Toast {
  text: string;
  undo?: () => void;
}

function initialState() {
  const params = new URLSearchParams(window.location.search);
  const filterParam = params.get('filter');
  const filter: Filter =
    filterParam === 'waiting' || filterParam === 'resolved' ? filterParam : 'needs_you';
  let items = INBOX_ITEMS;
  if (params.get('caughtup') === '1') {
    items = items.map((item) =>
      matchesFilter(item, 'needs_you') ? { ...item, status: 'resolved' as const } : item
    );
  }
  return { items, filter, openId: params.get('open'), quickId: params.get('quick') };
}

function FilterTabs({
  value,
  items,
  onChange,
}: {
  value: Filter;
  items: InboxItem[];
  onChange: (filter: Filter) => void;
}) {
  return (
    <div role="tablist" aria-label="Show" className="flex min-w-0 items-center gap-1.5">
      {FILTERS.map((filter) => {
        const count = countFor(items, filter.value);
        const active = filter.value === value;
        const attention = filter.value === 'needs_you' && count > 0;
        return (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(filter.value)}
            className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors ${
              active
                ? 'border-transparent bg-surface-hover text-fg-primary'
                : 'border-border-default text-fg-muted hover:text-fg-primary'
            }`}
          >
            {filter.label}
            {filter.value !== 'resolved' && count > 0 && (
              <span
                className="rounded-full px-1.5 text-xs font-semibold tabular-nums"
                style={
                  attention
                    ? {
                        background: 'var(--sam-color-warning-tint)',
                        color: 'var(--sam-color-warning-fg)',
                      }
                    : { color: 'var(--sam-color-fg-muted)' }
                }
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

function EmptyList({
  filter,
  waiting,
  onShowWaiting,
}: {
  filter: Filter;
  waiting: number;
  onShowWaiting: () => void;
}) {
  if (filter === 'needs_you') {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border-default bg-surface px-6 py-12 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success-tint text-success-fg">
          <Check size={22} aria-hidden />
        </span>
        <p className="m-0 text-base font-semibold text-fg-primary">You’re all caught up</p>
        <p className="m-0 max-w-[280px] text-sm text-fg-muted">
          Nobody is waiting on you. New comments and replies show up here first.
        </p>
        {waiting > 0 && (
          <button
            type="button"
            onClick={onShowWaiting}
            className="mt-1 h-9 rounded-md px-2 text-sm font-medium text-accent hover:underline"
          >
            {waiting} {waiting === 1 ? 'comment is' : 'comments are'} waiting on others
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border-default bg-surface px-6 py-12 text-center">
      <Inbox size={22} className="text-fg-muted" aria-hidden />
      <p className="m-0 text-sm text-fg-muted">Nothing here.</p>
    </div>
  );
}

export function CommentsInboxPrototype() {
  const initial = useMemo(initialState, []);
  const wide = useMediaQuery('(min-width: 1024px)');
  const [items, setItems] = useState<InboxItem[]>(initial.items);
  const [filter, setFilter] = useState<Filter>(initial.filter);
  const [openId, setOpenId] = useState<string | null>(initial.openId);
  const [quickId, setQuickId] = useState<string | null>(initial.quickId);
  // An item you just acted on stays in place until you move on, like a read email in Unread.
  const [stickyId, setStickyId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = useMemo(
    () =>
      sortByActivity(items.filter((item) => matchesFilter(item, filter) || item.id === stickyId)),
    [items, filter, stickyId]
  );
  const needsYou = countFor(items, 'needs_you');
  const waiting = countFor(items, 'waiting');

  // Desktop always shows a comment beside the list.
  const selectedId = wide
    ? openId && visible.some((item) => item.id === openId)
      ? openId
      : (visible[0]?.id ?? null)
    : openId;
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const position = selected ? visible.findIndex((item) => item.id === selected.id) : -1;

  const showToast = useCallback((next: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  const goTo = useCallback((id: string | null) => {
    setStickyId(null);
    setQuickId(null);
    setOpenId(id);
  }, []);

  const neighbour = useCallback(
    (id: string, step: 1 | -1) => {
      const index = visible.findIndex((item) => item.id === id);
      return visible[index + step]?.id ?? null;
    },
    [visible]
  );

  const update = useCallback((id: string, change: (item: InboxItem) => InboxItem) => {
    setItems((current) => current.map((item) => (item.id === id ? change(item) : item)));
  }, []);

  const reply = useCallback(
    (id: string, body: string, sendToAgent: boolean) => {
      update(id, (item) => ({
        ...item,
        status: sendToAgent ? 'sent' : item.status === 'resolved' ? 'open' : item.status,
        entries: [
          ...item.entries,
          { id: `reply-${Date.now()}`, author: ME, body, at: Date.now(), sentToAgent: sendToAgent },
        ],
      }));
      setStickyId(id);
      setQuickId(null);
      showToast({ text: sendToAgent ? 'Replied and sent to the agent' : 'Replied' });
    },
    [showToast, update]
  );

  const resolve = useCallback(
    (id: string) => {
      const previous = items.find((item) => item.id === id);
      if (!previous) return;
      const next = neighbour(id, 1) ?? neighbour(id, -1);
      update(id, (item) => ({ ...item, status: 'resolved' }));
      setQuickId(null);
      setStickyId(null);
      // Opened (phone detail or desktop pane): move straight on to the next comment.
      if (openId === id || wide) setOpenId(next);
      showToast({
        text: 'Resolved',
        undo: () => {
          update(id, () => previous);
          setToast(null);
        },
      });
    },
    [items, neighbour, openId, showToast, update, wide]
  );

  const reopen = useCallback(
    (id: string) => {
      update(id, (item) => ({ ...item, status: 'open' }));
      setStickyId(id);
      showToast({ text: 'Reopened' });
    },
    [showToast, update]
  );

  // Desktop keyboard triage: J/K move, E resolves. Ignored while typing.
  useEffect(() => {
    if (!wide) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (!selectedId) return;
      if (event.key === 'j') goTo(neighbour(selectedId, 1) ?? selectedId);
      if (event.key === 'k') goTo(neighbour(selectedId, -1) ?? selectedId);
      if (event.key === 'e') resolve(selectedId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, neighbour, resolve, selectedId, wide]);

  const list = (
    <div className="flex min-w-0 flex-col gap-3">
      {visible.length === 0 ? (
        <EmptyList filter={filter} waiting={waiting} onShowWaiting={() => setFilter('waiting')} />
      ) : (
        visible.map((item) => (
          <InboxCard
            key={item.id}
            item={item}
            selected={wide && item.id === selectedId}
            quickReplyOpen={quickId === item.id}
            onOpen={() => goTo(item.id)}
            onToggleQuickReply={() =>
              setQuickId((current) => (current === item.id ? null : item.id))
            }
            onReply={(body, sendToAgent) => reply(item.id, body, sendToAgent)}
            onResolve={() => resolve(item.id)}
            onReopen={() => reopen(item.id)}
          />
        ))
      )}
    </div>
  );

  const header = (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h1 className="m-0 text-xl font-semibold text-fg-primary">Comments</h1>
        {wide && (
          <span className="text-xs text-fg-muted">
            <kbd className="rounded border border-border-default px-1">J</kbd>{' '}
            <kbd className="rounded border border-border-default px-1">K</kbd> move ·{' '}
            <kbd className="rounded border border-border-default px-1">E</kbd> resolve
          </span>
        )}
      </div>
      <FilterTabs
        value={filter}
        items={items}
        onChange={(next) => {
          setFilter(next);
          setStickyId(null);
          setQuickId(null);
          if (!wide) setOpenId(null);
        }}
      />
    </div>
  );

  const detail = selected ? (
    <CommentDetail
      key={selected.id}
      item={selected}
      position={position + 1}
      total={visible.length}
      onPrev={position > 0 ? () => goTo(neighbour(selected.id, -1)) : undefined}
      onNext={position < visible.length - 1 ? () => goTo(neighbour(selected.id, 1)) : undefined}
      onBack={wide ? undefined : () => goTo(null)}
      onResolve={() => resolve(selected.id)}
      onReopen={() => reopen(selected.id)}
      onReply={(body, sendToAgent) => reply(selected.id, body, sendToAgent)}
    />
  ) : null;

  const toastView = toast && (
    <div
      role="status"
      // Above the pinned reply box on a phone; under the list on desktop, clear of the detail pane.
      className={`pointer-events-none fixed z-[60] flex px-4 ${
        wide
          ? 'bottom-4 left-[232px] w-[420px] justify-center'
          : `inset-x-0 justify-center ${detail ? 'bottom-[136px]' : 'bottom-4'}`
      }`}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border-default bg-surface py-1.5 pr-1.5 pl-4 text-sm text-fg-primary shadow-xl">
        {toast.text}
        {toast.undo && (
          <button
            type="button"
            onClick={toast.undo}
            className="h-8 rounded-full px-3 text-sm font-semibold text-accent hover:bg-surface-hover"
          >
            Undo
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setToast(null)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-fg-muted hover:bg-surface-hover"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  );

  if (wide) {
    return (
      <div data-testid="comments-inbox-prototype-page">
        <AppFrame wide needsYou={needsYou} scroll={false}>
          <div
            className="grid min-h-0 flex-1"
            style={{ gridTemplateColumns: 'minmax(360px, 420px) minmax(0, 1fr)' }}
          >
            <div className="flex min-h-0 flex-col border-0 border-r border-solid border-border-default">
              <div className="shrink-0 px-4 pt-5 pb-3">{header}</div>
              <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-8">{list}</div>
            </div>
            <div className="min-h-0">
              {detail ?? (
                <div className="flex h-full items-center justify-center text-sm text-fg-muted">
                  Pick a comment
                </div>
              )}
            </div>
          </div>
        </AppFrame>
        {toastView}
      </div>
    );
  }

  return (
    <div data-testid="comments-inbox-prototype-page">
      <AppFrame wide={false} needsYou={needsYou}>
        {/* Inert while a comment is open full screen, so focus and taps cannot reach the list. */}
        <div className="flex min-w-0 flex-col gap-4 px-4 pt-4 pb-24" inert={Boolean(detail)}>
          {header}
          {list}
        </div>
      </AppFrame>
      {detail && <div className="fixed inset-0 z-50 flex flex-col bg-canvas">{detail}</div>}
      {toastView}
    </div>
  );
}
