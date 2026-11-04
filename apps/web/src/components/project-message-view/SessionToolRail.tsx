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
import { Count, paneClassName } from '@simple-agent-manager/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CSSProperties } from 'react';

import { useChatImmersive } from '../shell/chat-immersive-context';
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

/**
 * On desktop the rail is its own SAM Glass pane beside the conversation column, wide enough
 * for 44px targets with the pane's padding (the design's 3.75rem).
 */
const DESKTOP_ICON_RAIL_WIDTH_PX = 60;
const DESKTOP_LABEL_RAIL_WIDTH_PX = 168;

function railWidth(mode: ToolStripMode, isMobile: boolean): number {
  if (isMobile || mode === 'hidden') return RAIL_WIDTH_PX[mode];
  return mode === 'icons' ? DESKTOP_ICON_RAIL_WIDTH_PX : DESKTOP_LABEL_RAIL_WIDTH_PX;
}

/** Width of the pull-tab shown in `hidden` mode. */
const RAIL_TAB_WIDTH_PX = 26;

/**
 * Collapsed pull-tab placement: biased below centre so it sits further from the floating
 * header at its tallest (~73px headroom vs ~36px at centre) and closer to the thumb.
 */
const RAIL_TAB_STYLE: CSSProperties = { top: '62%', transform: 'translateY(-50%)' };

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
  /*
   * Hidden reserves NOTHING. It used to reserve `RAIL_TAB_WIDTH_PX`, which meant the one
   * mode whose entire purpose is giving the space back still took a 26px column off the
   * conversation for the full height of the view — for a tab occupying a fraction of it.
   *
   * With the tab at the top that column looked plausible, because the tab sat in the part
   * of it the header also occupied. Anchoring the tab lower exposed it: the header ended
   * 26px short of the viewport with empty space beside it and nothing in that space,
   * which reads as a broken layout rather than a collapsed rail.
   *
   * The tab now overlays instead. Its wrapper is a zero-width flex child pinned to the
   * right edge, so `right-0` puts the tab's right edge at the viewport edge and it
   * extends inward over the conversation — the ordinary drawer-handle arrangement.
   */
  if (mode === 'hidden') return 0;
  if (mode === 'labels' && isMobile) return RAIL_WIDTH_PX.icons;
  return railWidth(mode, isMobile);
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
  isLowerBound,
}: Readonly<{
  count: number;
  compact: boolean;
  needsAttention: boolean;
  /** Renders "N+" — the server could only establish a minimum count. */
  isLowerBound: boolean;
}>) {
  if (compact) {
    return (
      <span
        aria-hidden="true"
        className={`absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full shadow-[0_0_0_2px_var(--sam-separator)] ${
          needsAttention ? 'bg-[var(--sam-color-warning)]' : 'bg-[var(--sam-color-fg-muted)]'
        }`}
      />
    );
  }
  // Amber only when someone is waiting on you; otherwise a muted count (SAM Glass).
  return (
    <Count
      value={`${count}${isLowerBound ? '+' : ''}`}
      tone={needsAttention ? 'attention' : 'muted'}
      asText
      className="ml-auto"
    />
  );
}

function RailDivider() {
  return <div aria-hidden="true" className="mx-2.5 my-1.5 h-px bg-[var(--sam-hairline)]" />;
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
    action.tone === 'success' ? 'var(--sam-status-success-fg)' : 'var(--sam-color-fg-muted)';
  // Shorter rows on mobile so more of the tool set clears the fold. On desktop each icon is
  // a 44px target, rounded like every SAM Glass control.
  const iconRowHeight = isMobile ? 'h-9 w-full' : 'mx-auto h-11 w-11';
  const className = `relative flex items-center border-none bg-transparent transition-colors hover:bg-[var(--sam-glass-v2-raised)] hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring ${
    isMobile ? '' : 'rounded-[var(--sam-radius-control)]'
  } ${
    compact
      ? `${iconRowHeight} justify-center px-0`
      : `${isMobile ? 'h-9' : 'h-10'} w-full gap-2.5 px-2.5 text-left`
  } ${action.disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`;

  const label = !compact && (
    <span className="min-w-0 truncate text-[13px] font-medium">{action.label}</span>
  );

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
      <Icon size={isMobile ? 17 : 19} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      {label}
      {action.badge !== undefined && (
        <ToolBadge
          count={action.badge}
          compact={compact}
          needsAttention={action.badgeNeedsAttention ?? false}
          isLowerBound={action.badgeIsLowerBound ?? false}
        />
      )}
    </button>
  );
}

export function SessionToolRail({
  actions,
  mode,
  onModeChange,
  onSelect,
  isMobile,
}: Readonly<{
  actions: SessionToolAction[];
  mode: ToolStripMode;
  onModeChange: (mode: ToolStripMode) => void;
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
  // The immersive chat view slides the rail away, so its slot stops reserving width and the
  // conversation takes the whole row (`shell/chat-immersive-transition.ts`).
  const immersive = useChatImmersive().active;
  const gutter = immersive ? 0 : sessionToolRailGutter(mode, isMobile);

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
          data-immersive-chrome="tool-rail"
          className="sam-raised absolute right-0 z-30 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-l-[var(--sam-radius-control)] border-0 py-3 text-fg-muted shadow-[var(--sam-glass-v2-depth-slab)] transition-colors hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
          style={{ ...RAIL_TAB_STYLE, width: RAIL_TAB_WIDTH_PX }}
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
        data-immersive-chrome="tool-rail"
        data-mode={mode}
        aria-label="Session tools"
        className={`absolute inset-y-0 right-0 z-20 flex flex-col overflow-hidden ${
          isMobile
            ? // Inside the conversation pane: a hairline sets it apart; the mobile labels rail
              // floats over the conversation, so it takes the overlay pane's fill and shadow.
              overlaying
              ? `${paneClassName('overlay')} rounded-none rounded-l-[var(--sam-radius-pane)]`
              : 'border-l border-[var(--sam-hairline)]'
            : // Desktop: its own pane beside the conversation column (SAM Glass "tool rail").
              `${paneClassName('pane')} py-1`
        }`}
        style={{ width: railWidth(mode, isMobile) }}
      >
        <button
          type="button"
          onClick={() => onModeChange(next)}
          aria-label={cycleLabel}
          title={cycleLabel}
          data-testid="session-tool-rail-cycle"
          className={`flex shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent text-fg-muted transition-colors hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring ${
            isMobile ? 'h-8' : 'h-11'
          } ${
            compact
              ? 'justify-center px-0'
              : // Tinted ONLY in labels mode, where the segment carries the word "TOOLS"
                // and reads unambiguously as a section header. In compact mode the label
                // is suppressed, so a tinted 46x32 box at the head of a vertical list of
                // icon buttons reads as "selected" instead — the universal meaning of a
                // tinted first list item. There the hard seam and rounded outer corner
                // mark the segment on their own.
                //
                // A class, not an inline style: inline `backgroundColor` outranks every
                // class selector, which silently killed `hover:bg-surface-hover` on this
                // button. The `hover:` variant beats a plain utility on specificity.
                'justify-between px-3'
          }`}
          style={isMobile ? { borderBottom: '1px solid var(--sam-hairline)' } : undefined}
        >
          {!compact && (
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em]">Tools</span>
          )}
          {compact ? (
            <ChevronLeft size={isMobile ? 13 : 18} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={isMobile ? 13 : 18} strokeWidth={1.75} />
          )}
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
            className="shrink-0 border-t border-[var(--sam-hairline)] py-1"
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
