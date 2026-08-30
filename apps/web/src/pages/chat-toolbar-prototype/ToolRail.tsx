/**
 * Variation A — "Right Rail".
 *
 * Faithful to Raphaël's sketch: the controls currently buried in the session-header
 * disclosure become a persistent vertical strip on the right edge of the chat,
 * starting below the header and running to the composer.
 *
 * Costs horizontal width (44px in icon mode, 156px with labels). In production this
 * would be absolutely positioned inside the same `relative` container as
 * `FloatingHeader`, offset by the measured `useFloatingHeaderHeight()` value, with the
 * message list taking a matching `paddingRight`.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';

import {
  isGroupStart,
  MODE_LABEL,
  nextMode,
  type ToolAction,
  type ToolStripMode,
} from './tool-actions';

export const RAIL_WIDTH: Record<ToolStripMode, number> = {
  icons: 46,
  labels: 158,
  hidden: 0,
};

/**
 * Width the message list must reserve, including the pull-tab when hidden.
 *
 * On a 375px viewport a 158px labels rail is 42% of the screen — the visual audit
 * showed message bubbles collapsing to ~200px with code spans breaking mid-token. So
 * on mobile the labels rail OVERLAYS instead: the gutter stays at icon width and the
 * rail floats above the conversation. Labels are a transient "what does this icon
 * mean" state, so briefly covering the chat is the better trade. On desktop 158px of
 * 1280 is 12% and pushing is fine.
 */
export function railGutter(mode: ToolStripMode, isMobile: boolean): number {
  if (mode === 'hidden') return 26;
  if (mode === 'labels' && isMobile) return RAIL_WIDTH.icons;
  return RAIL_WIDTH[mode];
}

function Badge({ count, compact }: { count: number; compact: boolean }) {
  if (compact) {
    return (
      <span
        aria-hidden="true"
        className="absolute top-1.5 right-1.5 w-[7px] h-[7px] rounded-full ring-2"
        style={{
          backgroundColor: 'var(--sam-color-warning)',
          // Ring matches the rail surface so the dot reads as lifted, not clipped.
          ['--tw-ring-color' as string]: 'var(--sam-color-bg-surface)',
        }}
      />
    );
  }
  return (
    <span
      className="ml-auto shrink-0 text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded-full tabular-nums"
      style={{
        backgroundColor: 'var(--sam-color-warning-tint)',
        color: 'var(--sam-color-warning-fg)',
      }}
    >
      {count}
    </span>
  );
}

export function ToolRail({
  actions,
  mode,
  onModeChange,
  onSelect,
  top,
  isMobile,
}: {
  actions: ToolAction[];
  mode: ToolStripMode;
  onModeChange: (mode: ToolStripMode) => void;
  onSelect: (id: string) => void;
  /** Distance from the top of the chat container — clears the floating header. */
  top: number;
  isMobile: boolean;
}) {
  const next = nextMode(mode);
  const cycleLabel = `Tool strip: ${MODE_LABEL[mode]}. Activate for ${MODE_LABEL[next].toLowerCase()}.`;
  // See `railGutter` — on mobile the labels rail floats over the conversation instead
  // of squeezing it, so it needs a heavier shadow and an opaque backdrop.
  const overlaying = mode === 'labels' && isMobile;

  // The rail hangs below the floating header, but that header GROWS: opening the
  // session-details disclosure makes it taller than the viewport, which pushed the
  // rail entirely off-screen in the first audit pass. Clamping against a percentage
  // of the container guarantees the rail always keeps the lower half — a persistent
  // strip that a sibling panel can evict is not persistent.
  const railTop = `min(${top}px, 45%)`;

  if (mode === 'hidden') {
    return (
      <button
        type="button"
        onClick={() => onModeChange('icons')}
        aria-label={cycleLabel}
        title={cycleLabel}
        data-testid="tool-rail-tab"
        className="absolute right-0 z-20 flex flex-col items-center justify-center gap-1 w-[26px] py-3 rounded-l-lg border border-r-0 cursor-pointer transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
        style={{
          top: `min(${top + 12}px, calc(45% + 12px))`,
          borderColor: 'var(--sam-color-border-default)',
          backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-surface) 92%, transparent)',
          color: 'var(--sam-color-fg-muted)',
          boxShadow: '-2px 0 12px rgba(0,0,0,0.28)',
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
    );
  }

  const compact = mode === 'icons';

  return (
    <div
      data-testid="tool-rail"
      data-mode={mode}
      className="absolute right-0 bottom-0 z-20 flex flex-col rounded-tl-xl border-l border-t overflow-hidden"
      style={{
        top: railTop,
        width: RAIL_WIDTH[mode],
        borderColor: 'rgba(34,197,94,0.14)',
        backgroundColor: overlaying
          ? 'var(--sam-color-bg-surface)'
          : 'color-mix(in srgb, var(--sam-color-bg-canvas) 88%, transparent)',
        backdropFilter: 'blur(12px)',
        boxShadow: overlaying ? '-8px 0 32px rgba(0,0,0,0.55)' : '-4px 0 24px rgba(0,0,0,0.34)',
      }}
    >
      <button
        type="button"
        onClick={() => onModeChange(next)}
        aria-label={cycleLabel}
        title={cycleLabel}
        data-testid="tool-rail-cycle"
        className={`shrink-0 flex items-center gap-1 h-8 bg-transparent border-none border-b cursor-pointer text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
          compact ? 'justify-center px-0' : 'justify-between px-2.5'
        }`}
        style={{ borderBottom: '1px solid rgba(34,197,94,0.10)' }}
      >
        {!compact && (
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em]">Tools</span>
        )}
        {compact ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
      </button>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {actions.map((action, i) => {
          const Icon = action.icon;
          const color =
            action.tone === 'success' ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)';
          return (
            <div key={action.id}>
              {isGroupStart(actions, i) && (
                <div
                  aria-hidden="true"
                  className="my-1 mx-2 h-px"
                  style={{ backgroundColor: 'rgba(34,197,94,0.12)' }}
                />
              )}
              <button
                type="button"
                onClick={() => onSelect(action.id)}
                aria-label={action.hint}
                title={action.hint}
                data-testid={`tool-${action.id}`}
                className={`relative w-full flex items-center bg-transparent border-none cursor-pointer transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
                  compact ? 'justify-center h-10 px-0' : 'gap-2.5 h-9 px-2.5 text-left'
                }`}
                style={{ color }}
              >
                <Icon size={17} className="shrink-0" aria-hidden="true" />
                {!compact && (
                  <span className="text-xs font-medium truncate min-w-0">{action.label}</span>
                )}
                {action.badge !== undefined && <Badge count={action.badge} compact={compact} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
