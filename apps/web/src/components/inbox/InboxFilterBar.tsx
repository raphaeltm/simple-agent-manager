import { useClickOutside, useEscapeKey } from '@simple-agent-manager/ui';
import { Archive, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { INBOX_CHIPS, type InboxView } from './inbox-model';

/** Views whose count means "waiting on you" (amber); Updates stays neutral. */
const ATTENTION_VIEWS: ReadonlySet<InboxView> = new Set(['needs_you', 'blocking']);

const CHIP =
  'flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring sm:h-9';

/**
 * One scrolling chip row: Needs you, Blocking, Tasks, Reviews, Updates. Archived is rare, so it
 * lives behind ⋯ instead of costing a chip; ⋯ sits right after the last chip (the group is
 * content-width and only shrinks to scroll when the row is too narrow). The active chip scrolls into view, so a filter chosen
 * off-screen at 375px is never hidden. The chips are toggle buttons (`aria-pressed`): each one
 * filters the same list, so they are not tabs over separate panels.
 */
export function InboxFilterBar({
  value,
  onChange,
  counts,
}: {
  value: InboxView;
  onChange: (view: InboxView) => void;
  counts: Partial<Record<InboxView, number>>;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  useEffect(() => {
    if (menuOpen) firstItemRef.current?.focus();
  }, [menuOpen]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeMenuAndRefocus = useCallback(() => {
    setMenuOpen(false);
    moreRef.current?.focus();
  }, []);
  useClickOutside(menuRef, closeMenu, menuOpen);
  useEscapeKey(closeMenuAndRefocus, menuOpen);

  const chips =
    value === 'archived'
      ? [...INBOX_CHIPS, { value: 'archived' as const, label: 'Archived' }]
      : INBOX_CHIPS;

  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      <div
        role="group"
        aria-label="Inbox filters"
        className="flex min-w-0 flex-initial gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none]"
      >
        {chips.map((chip) => {
          const current = chip.value === value;
          const count = counts[chip.value];
          return (
            <button
              key={chip.value}
              ref={current ? currentRef : undefined}
              type="button"
              aria-pressed={current}
              aria-label={count ? `${chip.label}, ${count}` : undefined}
              onClick={() => onChange(chip.value)}
              className={`${CHIP} ${
                current
                  ? 'sam-raised font-medium text-fg-primary'
                  : 'sam-well text-fg-muted hover:text-fg-primary'
              }`}
            >
              {chip.value === 'archived' && <Archive size={13} aria-hidden="true" />}
              {chip.label}
              {count !== undefined && count > 0 && (
                <span
                  aria-hidden="true"
                  className={`font-mono text-[11px] ${ATTENTION_VIEWS.has(chip.value) ? 'text-warning-fg' : ''}`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div ref={menuRef} className="relative shrink-0">
        <button
          ref={moreRef}
          type="button"
          aria-label="More filters"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="sam-well grid h-11 w-11 cursor-pointer place-items-center rounded-full border-0 text-fg-muted hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring sm:h-9 sm:w-9"
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="sam-glass sam-glass-rim sam-glass-live absolute top-full right-0 z-50 mt-1 flex w-48 flex-col rounded-[14px] p-1">
            <button
              ref={firstItemRef}
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onChange('archived');
              }}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-transparent px-3 text-left text-sm text-fg-primary hover:bg-[var(--sam-glass-v2-raised)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <Archive size={15} aria-hidden="true" className="text-fg-muted" /> Archived
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
