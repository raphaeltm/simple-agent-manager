import { Avatar, Spinner } from '@simple-agent-manager/ui';
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useProjectMembers } from '../../../hooks/useProjectMembers';
import { type MentionCandidate, toMentionCandidates } from './comment-mentions';

export interface MentionCandidatesState {
  candidates: MentionCandidate[];
  loading: boolean;
}

/**
 * Loads the project's active members for a composer's @mention palette.
 *
 * A separate render-nothing child so a composer only touches the members query (and the
 * QueryClient/auth context it needs) when mentions are turned on: library-file comments have
 * no mentions and keep a composer with no data dependencies. Mounted with the composer, not
 * on the first `@`, so the list is usually ready by the time someone types one.
 */
export function MentionCandidatesSource({
  projectId,
  onChange,
}: Readonly<{ projectId: string; onChange: (state: MentionCandidatesState) => void }>) {
  const { members, isPending } = useProjectMembers(projectId);
  const candidates = useMemo(() => toMentionCandidates(members), [members]);
  useEffect(() => {
    onChange({ candidates, loading: isPending });
  }, [candidates, isPending, onChange]);
  return null;
}

/** Gap between the field and the palette. */
const FIELD_GAP_PX = 4;
/** Distance kept from the edges of the visible viewport. */
const VIEW_MARGIN_PX = 8;
/** About four rows; the list scrolls past that. */
const MAX_HEIGHT_PX = 192;
/** Never shrink below two rows: flip sides instead. */
const MIN_HEIGHT_PX = 96;
/** Fields narrower than this (jsdom reports 0) still get a usable list. */
const MIN_WIDTH_PX = 220;

/**
 * Where the palette sits: under the field when there is room, otherwise above it, inside the
 * visible viewport (the visual viewport, so a phone keyboard counts).
 *
 * Fixed and portaled rather than in the composer's flow, for two measured reasons. In flow,
 * opening the list grew the newest message's row; the conversation is pinned to its bottom
 * while you are there, so it scrolled the field up under the floating session header and
 * hid what you were typing. And every comment surface is its own scroll container (rail,
 * drawer, bottom sheet), which would clip an absolutely positioned list.
 */
function usePalettePlacement(anchorRef: RefObject<HTMLElement | null>): CSSProperties | null {
  const [placement, setPlacement] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      const viewTop = (viewport?.offsetTop ?? 0) + VIEW_MARGIN_PX;
      const viewBottom =
        (viewport ? viewport.offsetTop + viewport.height : layoutHeight) - VIEW_MARGIN_PX;
      const viewLeft = (viewport?.offsetLeft ?? 0) + VIEW_MARGIN_PX;
      const viewRight =
        (viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - VIEW_MARGIN_PX;

      const spaceBelow = viewBottom - rect.bottom - FIELD_GAP_PX;
      const spaceAbove = rect.top - FIELD_GAP_PX - viewTop;
      const below = spaceBelow >= MAX_HEIGHT_PX || spaceBelow >= spaceAbove;
      const maxHeight = Math.max(
        MIN_HEIGHT_PX,
        Math.min(MAX_HEIGHT_PX, below ? spaceBelow : spaceAbove)
      );
      const width = Math.min(Math.max(rect.width, MIN_WIDTH_PX), viewRight - viewLeft);
      const left = Math.min(Math.max(rect.left, viewLeft), viewRight - width);

      setPlacement(
        below
          ? { top: rect.bottom + FIELD_GAP_PX, left, width, maxHeight }
          : { bottom: layoutHeight - rect.top + FIELD_GAP_PX, left, width, maxHeight }
      );
    };

    update();
    // Follow the field while anything scrolls (the conversation, a drawer, the page), the
    // viewport changes (rotation, the keyboard opening) or the field grows a line.
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    const resizeObserver = new ResizeObserver(update);
    if (anchorRef.current) resizeObserver.observe(anchorRef.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      resizeObserver.disconnect();
    };
  }, [anchorRef]);

  return placement;
}

/**
 * The member list for an `@name` being typed in a comment field.
 *
 * Presentational: `useMemberMentions` owns the filter, the active option and the keyboard.
 * The field keeps focus throughout (options are `aria-activedescendant` targets, not tab
 * stops), and ids come from React `useId` so several composers can be open at once.
 */
export function MemberMentionPalette({
  anchorRef,
  listboxId,
  optionId,
  options,
  activeIndex,
  loading,
  onPick,
  onHover,
}: Readonly<{
  /** The field the palette belongs to; it opens next to it. */
  anchorRef: RefObject<HTMLElement | null>;
  listboxId: string;
  optionId: (index: number) => string;
  options: readonly MentionCandidate[];
  activeIndex: number;
  loading: boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}>) {
  const listRef = useRef<HTMLDivElement>(null);
  const placement = usePalettePlacement(anchorRef);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // jsdom has no scrollIntoView.
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, options]);

  const style: CSSProperties = placement ?? { visibility: 'hidden' };
  const content =
    options.length === 0 ? (
      <div
        // The field's aria-controls points here while teammates load.
        id={listboxId}
        role="status"
        style={style}
        className="fixed z-panel flex items-center gap-2 rounded-md border border-border-default bg-surface px-3 py-2 text-xs text-fg-muted shadow-lg"
      >
        <Spinner size="sm" />
        Loading teammates…
      </div>
    ) : (
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Mention a teammate"
        style={style}
        className="fixed z-panel min-w-0 overflow-y-auto rounded-md border border-border-default bg-surface py-1 shadow-lg"
      >
        {options.map((option, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={option.userId}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={active}
              // The email tells two people with the same name apart.
              aria-label={option.email ? `${option.label}, ${option.email}` : option.label}
              tabIndex={-1}
              // Keep the caret in the field: picking must not blur it first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(index)}
              onMouseEnter={() => onHover(index)}
              className={`flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 border-none px-3 py-1.5 text-left transition-colors ${
                active ? 'bg-surface-hover' : 'bg-transparent hover:bg-surface-hover'
              }`}
            >
              <Avatar
                name={option.label}
                imageUrl={option.avatarUrl}
                tone="human"
                size="sm"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                {option.label}
              </span>
              {option.email && (
                <span className="hidden min-w-0 max-w-[45%] truncate text-xs text-fg-muted sm:inline">
                  {option.email}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );

  if (options.length === 0 && !loading) return null;
  return createPortal(content, document.body);
}
