/**
 * Persistent vertical tool rail on the right edge of the chat.
 *
 * Replaces the collapsed details disclosure as the home for the session's controls.
 * Previously all seven of Files/Git/Workspace/Timeline/Comments/Report/Complete lived
 * inside that disclosure and Retry/Fork were unlabeled icons in the title row, so nine
 * controls sat behind one 14px chevron named "Show session details" — a name that
 * promises metadata, not tools.
 *
 * Anchored to the messages-area container (`inset-y-0 right-0`), NOT to the floating
 * header's measured height. The header grows past the viewport when the details
 * disclosure opens; anchoring below it pushed the rail off-screen entirely (measured
 * y=763 in a 667px viewport during the prototype audit). Anchoring to the container
 * removes that failure mode by construction.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';

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

function ToolBadge({ count, compact }: { count: number; compact: boolean }) {
  if (compact) {
    return (
      <span
        aria-hidden="true"
        className="absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full ring-2"
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
      className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums"
      style={{
        backgroundColor: 'var(--sam-color-warning-tint)',
        color: 'var(--sam-color-warning-fg)',
      }}
    >
      {count}
    </span>
  );
}

export function SessionToolRail({
  actions,
  mode,
  onModeChange,
  onSelect,
  isMobile,
}: {
  actions: SessionToolAction[];
  mode: ToolStripMode;
  onModeChange: (mode: ToolStripMode) => void;
  onSelect: (id: SessionToolId) => void;
  isMobile: boolean;
}) {
  const next = nextToolStripMode(mode);
  const cycleLabel = `Session tools: ${TOOL_STRIP_MODE_LABEL[mode]}. Activate for ${TOOL_STRIP_MODE_LABEL[
    next
  ].toLowerCase()}.`;

  if (mode === 'hidden') {
    return (
      <button
        type="button"
        onClick={() => onModeChange('icons')}
        aria-label={cycleLabel}
        title={cycleLabel}
        data-testid="session-tool-rail-tab"
        className="absolute top-3 right-0 z-20 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-l-lg border border-r-0 py-3 transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
        style={{
          width: RAIL_TAB_WIDTH_PX,
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
  // See `sessionToolRailGutter` — on mobile the labels rail floats over the conversation
  // instead of squeezing it, so it needs an opaque backdrop and a heavier shadow.
  const overlaying = mode === 'labels' && isMobile;

  return (
    <aside
      data-testid="session-tool-rail"
      data-mode={mode}
      aria-label="Session tools"
      className="absolute inset-y-0 right-0 z-20 flex flex-col overflow-hidden border-l"
      style={{
        width: RAIL_WIDTH_PX[mode],
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
        data-testid="session-tool-rail-cycle"
        className={`flex h-8 shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
          compact ? 'justify-center px-0' : 'justify-between px-2.5'
        }`}
        style={{ borderBottom: '1px solid rgba(34,197,94,0.10)' }}
      >
        {!compact && (
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em]">Tools</span>
        )}
        {compact ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
      </button>

      {/*
        A fully-provisioned active session offers ten tools. On a short mobile viewport —
        especially with the wake-progress and reconnect banners stacked above — that does
        not fit, and a silently scrolling rail would hide Complete and Details below a
        fold the user has no reason to suspect. The list is a real scroller (never
        `overflow: hidden`), and the mask fades whatever content reaches the bottom edge,
        which reads as "there is more" exactly when there is. When everything fits, the
        faded band is empty and the mask has no visible effect.
      */}
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        style={{
          maskImage: 'linear-gradient(to bottom, black calc(100% - 16px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 16px), transparent 100%)',
        }}
      >
        {actions.map((action, index) => {
          const Icon = action.icon;
          const color =
            action.tone === 'success' ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)';
          // Shorter rows on mobile so the full tool set clears the fold more often.
          const iconRowHeight = isMobile ? 'h-9' : 'h-10';
          const buttonClass = `relative flex w-full items-center border-none bg-transparent transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
            compact ? `${iconRowHeight} justify-center px-0` : 'h-9 gap-2.5 px-2.5 text-left'
          } ${action.disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`;

          return (
            <div key={action.id}>
              {isToolGroupStart(actions, index) && (
                <div
                  aria-hidden="true"
                  className="mx-2 my-1 h-px"
                  style={{ backgroundColor: 'rgba(34,197,94,0.12)' }}
                />
              )}
              {action.href ? (
                <a
                  href={action.href}
                  aria-label={action.hint}
                  title={action.hint}
                  data-testid={`session-tool-${action.id}`}
                  className={`${buttonClass} no-underline`}
                  style={{ color }}
                >
                  <Icon size={17} className="shrink-0" aria-hidden="true" />
                  {!compact && (
                    <span className="min-w-0 truncate text-xs font-medium">{action.label}</span>
                  )}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(action.id)}
                  disabled={action.disabled}
                  aria-label={action.hint}
                  aria-expanded={action.expanded}
                  title={action.hint}
                  data-testid={`session-tool-${action.id}`}
                  className={buttonClass}
                  style={{ color }}
                >
                  <Icon size={17} className="shrink-0" aria-hidden="true" />
                  {!compact && (
                    <span className="min-w-0 truncate text-xs font-medium">{action.label}</span>
                  )}
                  {action.badge !== undefined && (
                    <ToolBadge count={action.badge} compact={compact} />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
