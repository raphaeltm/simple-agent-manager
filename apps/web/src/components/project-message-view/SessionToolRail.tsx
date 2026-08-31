/**
 * Persistent vertical tool rail on the right edge of the chat.
 *
 * Replaces the collapsed details disclosure as the home for the session's controls.
 * Previously all seven of Files/Git/Workspace/Timeline/Comments/Report/Complete lived
 * inside that disclosure and Retry/Fork were unlabeled icons in the title row, so nine
 * controls sat behind one 14px chevron named "Show session details" — a name that
 * promises metadata, not tools.
 *
 * Renders as a flex CHILD that reserves `gutter` px, with the visible panel absolutely
 * positioned inside that slot. Two earlier shapes were wrong:
 *
 *  - Anchoring to the floating header's measured height needed a clamp, because the
 *    header grows past the viewport when the details disclosure opens and pushed the
 *    rail off-screen entirely (measured y=763 in a 667px viewport).
 *  - Absolute-positioning against the messages container with a sibling spacer reserved
 *    no horizontal space below `lg`, where that container is `flex-col` — the expanded
 *    details panel slid underneath the rail. Screenshots did not show it; measuring the
 *    header's right edge against the rail's left edge did.
 *
 * The slot/panel split is also what lets labels mode overlay on mobile: the slot stays
 * at icon width while the panel renders wider and extends left over the conversation.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CSSProperties } from 'react';

import {
  isToolGroupStart,
  nextToolStripMode,
  type SessionToolAction,
  type SessionToolId,
  TOOL_STRIP_MODE_LABEL,
  type ToolStripMode,
} from './session-tool-actions';

const RAIL_WIDTH_PX: Record<ToolStripMode, number> = {
  icons: 46,
  labels: 158,
  hidden: 0,
};

/** Width of the pull-tab shown in `hidden` mode. */
const RAIL_TAB_WIDTH_PX = 26;

/**
 * Where the pull-tab sits when the rail is collapsed.
 *
 * Only meaningful in `hidden` mode: once the bar is out it is full-height, so its tab is
 * necessarily its top segment. The variants exist because the shipped `top` placement put
 * the tab inside the floating header's vertical band ON EVERY SESSION — the header is
 * `absolute top-0 left-0 right-0` in the same container and 150-210px tall, while the tab
 * anchored at 12px. Not an edge case; a guaranteed collision.
 *
 * `below-header` was considered and NOT built: it couples the tab to a header height that
 * grows when chips wrap or Details expands, and needs a `min(headerHeight, 45%)` clamp to
 * stop the tab being pushed off-screen entirely. Anchoring away from the header deletes
 * that failure mode instead of managing it.
 */
export type RailTabAnchor = 'top' | 'center' | 'lower';

export const RAIL_TAB_ANCHORS: readonly RailTabAnchor[] = ['top', 'center', 'lower'];

export const DEFAULT_RAIL_TAB_ANCHOR: RailTabAnchor = 'center';

/** Absolute-position styles per anchor. */
const RAIL_TAB_ANCHOR_STYLE: Record<RailTabAnchor, CSSProperties> = {
  // Shipped placement, kept only so the comparison screenshots have a baseline.
  top: { top: 12 },
  center: { top: '50%', transform: 'translateY(-50%)' },
  // Biased below centre: further from the header at its tallest, closer to the thumb.
  lower: { top: '62%', transform: 'translateY(-50%)' },
};

/**
 * Horizontal space the conversation must give up.
 *
 * At 375px a 158px labels rail is 42% of the viewport — the prototype audit measured
 * message bubbles collapsing to ~200px with code spans breaking mid-token. So on mobile
 * the labels rail OVERLAYS: the gutter stays at icon width and the rail floats above the
 * conversation. Labels are a transient "what does this icon mean" state, so briefly
 * covering the chat is the better trade. On desktop 158/1280 is 12% and pushing is fine.
 */
export function sessionToolRailGutter(mode: ToolStripMode, isMobile: boolean): number {
  if (mode === 'hidden') return RAIL_TAB_WIDTH_PX;
  if (mode === 'labels' && isMobile) return RAIL_WIDTH_PX.icons;
  return RAIL_WIDTH_PX[mode];
}

/**
 * Comment count.
 *
 * `needsAttention` mirrors the header's `SessionCommentChip`, which turns amber when
 * someone else is waiting on you. Without it the two surfaces disagreed: the chip glowed
 * "N needs you" while the rail showed a neutral dot for the same session.
 */
function ToolBadge({
  count,
  compact,
  needsAttention,
}: Readonly<{
  count: number;
  compact: boolean;
  needsAttention: boolean;
}>) {
  const accent = needsAttention ? 'var(--sam-color-warning)' : 'var(--sam-color-fg-muted)';

  if (compact) {
    return (
      <span
        aria-hidden="true"
        className="absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full ring-2"
        style={{
          backgroundColor: accent,
          // Ring matches the rail surface so the dot reads as lifted, not clipped.
          ['--tw-ring-color' as string]: 'var(--sam-color-bg-surface)',
        }}
      />
    );
  }
  return (
    <span
      className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums"
      style={{
        backgroundColor: needsAttention
          ? 'var(--sam-color-warning-tint)'
          : 'var(--sam-color-bg-surface)',
        color: needsAttention ? 'var(--sam-color-warning-fg)' : 'var(--sam-color-fg-muted)',
      }}
    >
      {count}
    </span>
  );
}

function RailDivider() {
  return (
    <div
      aria-hidden="true"
      className="mx-2 my-1 h-px"
      style={{ backgroundColor: 'var(--sam-chrome-accent-active)' }}
    />
  );
}

/** One rail row. Renders an anchor for navigating actions and a button for the rest. */
function RailAction({
  action,
  compact,
  isMobile,
  onSelect,
}: Readonly<{
  action: SessionToolAction;
  compact: boolean;
  isMobile: boolean;
  onSelect: (id: SessionToolId) => void;
}>) {
  const Icon = action.icon;
  const color =
    action.tone === 'success' ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)';
  // Shorter rows on mobile so more of the tool set clears the fold.
  const iconRowHeight = isMobile ? 'h-9' : 'h-10';
  const className = `relative flex w-full items-center border-none bg-transparent transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
    compact ? `${iconRowHeight} justify-center px-0` : 'h-9 gap-2.5 px-2.5 text-left'
  } ${action.disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`;

  const label = !compact && (
    <span className="min-w-0 truncate text-xs font-medium">{action.label}</span>
  );

  if (action.href) {
    return (
      <a
        href={action.href}
        aria-label={action.hint}
        title={action.hint}
        data-testid={`session-tool-${action.id}`}
        className={`${className} no-underline`}
        style={{ color }}
      >
        <Icon size={17} className="shrink-0" aria-hidden="true" />
        {label}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(action.id)}
      disabled={action.disabled}
      aria-label={action.hint}
      aria-expanded={action.expanded}
      title={action.hint}
      data-testid={`session-tool-${action.id}`}
      className={className}
      style={{ color }}
    >
      <Icon size={17} className="shrink-0" aria-hidden="true" />
      {label}
      {action.badge !== undefined && (
        <ToolBadge
          count={action.badge}
          compact={compact}
          needsAttention={action.badgeNeedsAttention ?? false}
        />
      )}
    </button>
  );
}

export function SessionToolRail({
  actions,
  mode,
  onModeChange,
  tabAnchor = DEFAULT_RAIL_TAB_ANCHOR,
  onSelect,
  isMobile,
}: Readonly<{
  actions: SessionToolAction[];
  mode: ToolStripMode;
  onModeChange: (mode: ToolStripMode) => void;
  /** Collapsed-tab placement. See `RailTabAnchor`. */
  tabAnchor?: RailTabAnchor;
  onSelect: (id: SessionToolId) => void;
  isMobile: boolean;
}>) {
  const next = nextToolStripMode(mode);
  const cycleLabel = `Session tools: ${TOOL_STRIP_MODE_LABEL[mode]}. Activate for ${TOOL_STRIP_MODE_LABEL[
    next
  ].toLowerCase()}.`;

  // The rail is a flex child that reserves `gutter` px, with the visible panel
  // absolutely positioned inside it. That split is what lets labels mode OVERLAY on
  // mobile: the slot stays at icon width while the panel renders wider and extends left
  // over the conversation.
  //
  // It must be a flex CHILD, not absolutely positioned against the messages container:
  // that container is `flex-col` below `lg`, so a sibling spacer reserved no horizontal
  // space at all on mobile and the expanded details panel slid underneath the rail.
  const gutter = sessionToolRailGutter(mode, isMobile);

  // `meta` (Report / Complete / Details) is pinned; everything else scrolls. See the
  // comment on the scrolling list below for why.
  const scrollingActions = actions.filter((action) => action.group !== 'meta');
  const pinnedActions = actions.filter((action) => action.group === 'meta');

  if (mode === 'hidden') {
    return (
      <div className="relative shrink-0" style={{ width: gutter }}>
        <button
          type="button"
          onClick={() => onModeChange('icons')}
          aria-label={cycleLabel}
          title={cycleLabel}
          data-testid="session-tool-rail-tab"
          className="absolute right-0 z-30 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-l-lg border border-r-0 py-3 transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
          style={{
            ...RAIL_TAB_ANCHOR_STYLE[tabAnchor],
            width: RAIL_TAB_WIDTH_PX,
            borderColor: 'var(--sam-color-border-default)',
            backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-surface) 92%, transparent)',
            color: 'var(--sam-color-fg-muted)',
            // Collapsed, the tab genuinely floats over the conversation, so it earns an
            // elevation. Tokenized rather than hardcoded: the previous rgba(0,0,0,0.28)
            // ignored the theme and rendered as the heaviest edge on a light background.
            boxShadow: 'var(--sam-shadow-rail-tab)',
          }}
        >
          <ChevronLeft size={13} aria-hidden="true" />
          <span
            aria-hidden="true"
            className="text-[9px] font-semibold uppercase tracking-[0.14em]"
            style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
          >
            Tools
          </span>
        </button>
      </div>
    );
  }

  const compact = mode === 'icons';
  // See `sessionToolRailGutter` — on mobile the labels rail floats over the conversation
  // instead of squeezing it, so it needs an opaque backdrop and a heavier shadow.
  const overlaying = mode === 'labels' && isMobile;

  return (
    <div className="relative shrink-0" style={{ width: gutter }}>
      <aside
        data-testid="session-tool-rail"
        data-mode={mode}
        aria-label="Session tools"
        className="absolute inset-y-0 right-0 z-20 flex flex-col overflow-hidden rounded-tl-lg border-l"
        style={{
          width: RAIL_WIDTH_PX[mode],
          borderColor: 'var(--sam-chrome-accent-divider)',
          backgroundColor: overlaying
            ? 'var(--sam-color-bg-surface)'
            : 'color-mix(in srgb, var(--sam-color-bg-canvas) 88%, transparent)',
          backdropFilter: 'blur(12px)',
          /*
           * An elevation only where one is TRUE. In icons mode — and in labels mode on
           * desktop — the rail owns a layout slot and PUSHES the conversation; it sits
           * beside the content, not above it, so a drop shadow was asserting a
           * relationship that does not exist. The hairline border carries the separation.
           * Only the mobile labels rail actually floats over the conversation.
           */
          boxShadow: overlaying ? 'var(--sam-shadow-rail-overlay)' : 'none',
        }}
      >
        <button
          type="button"
          onClick={() => onModeChange(next)}
          aria-label={cycleLabel}
          title={cycleLabel}
          data-testid="session-tool-rail-cycle"
          className={`flex h-8 shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
            compact ? 'justify-center px-0' : 'justify-between px-2.5'
          }`}
          /*
           * The bar's top segment is styled as a TAB that flows into the bar rather than
           * sitting on it as a separate pill. The assembly's OUTER corner is rounded
           * (`rounded-tl-lg` on the aside, which clips this button), while the seam
           * between tab and bar is a hard square edge — one continuous piece of chrome,
           * not two stacked shapes. A slightly lifted background separates the two
           * without a second border.
           */
          style={{
            borderBottom: '1px solid var(--sam-chrome-accent-active)',
            backgroundColor: 'var(--sam-chrome-accent-active-subtle)',
          }}
        >
          {!compact && (
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em]">Tools</span>
          )}
          {compact ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
        </button>

        {/*
        A fully-provisioned active session offers ten tools, which does not fit a short
        mobile viewport — especially with the wake-progress and reconnect banners stacked
        above. Whatever gets cut must not be the controls this rail exists to surface, so
        the `meta` group (Report / Complete / Details) is PINNED as a non-scrolling footer,
        mirroring the pinned mode-cycle header. Details is the direct replacement for the
        old chevron and Complete ends the task; neither may depend on the user noticing
        that a 46px strip scrolls.

        Only the workspace/session tools scroll. That list is a real scroller (never
        `overflow: hidden`) and the mask fades whatever reaches its bottom edge, which
        reads as "there is more" exactly when there is. When everything fits, the faded
        band is empty and the mask has no visible effect.
      */}
        <div
          data-testid="session-tool-rail-scroller"
          className="min-h-0 flex-1 overflow-y-auto py-1"
          style={{
            maskImage: 'linear-gradient(to bottom, black calc(100% - 16px), transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, black calc(100% - 16px), transparent 100%)',
          }}
        >
          {scrollingActions.map((action, index) => (
            <div key={action.id}>
              {isToolGroupStart(scrollingActions, index) && <RailDivider />}
              <RailAction
                action={action}
                compact={compact}
                isMobile={isMobile}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>

        {pinnedActions.length > 0 && (
          <div
            data-testid="session-tool-rail-pinned"
            className="shrink-0 py-1"
            style={{ borderTop: '1px solid var(--sam-chrome-accent-active)' }}
          >
            {pinnedActions.map((action) => (
              <RailAction
                key={action.id}
                action={action}
                compact={compact}
                isMobile={isMobile}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
