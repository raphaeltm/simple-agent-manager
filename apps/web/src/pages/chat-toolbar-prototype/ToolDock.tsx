/**
 * Variation B — "Bottom Dock".
 *
 * Same controls, opposite trade-off: a horizontal strip docked directly above the
 * composer. Costs vertical height (40px in icon mode) instead of horizontal width, and
 * lands in the mobile thumb zone right next to the input the user is already touching.
 *
 * Overflow is a real horizontal scroller (`overflow-x-auto`), not `hidden`, so nothing
 * is silently clipped — see `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`.
 */
import './tool-strip.css';

import { ChevronDown, ChevronUp } from 'lucide-react';

import {
  isGroupStart,
  MODE_LABEL,
  nextMode,
  type ToolAction,
  type ToolStripMode,
} from './tool-actions';

function Badge({ count, compact }: { count: number; compact: boolean }) {
  if (compact) {
    return (
      <span
        aria-hidden="true"
        className="absolute top-1 right-1 w-[7px] h-[7px] rounded-full ring-2"
        style={{
          backgroundColor: 'var(--sam-color-warning)',
          ['--tw-ring-color' as string]: 'var(--sam-color-bg-canvas)',
        }}
      />
    );
  }
  return (
    <span
      className="shrink-0 text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded-full tabular-nums"
      style={{
        backgroundColor: 'var(--sam-color-warning-tint)',
        color: 'var(--sam-color-warning-fg)',
      }}
    >
      {count}
    </span>
  );
}

export function ToolDock({
  actions,
  mode,
  onModeChange,
  onSelect,
}: {
  actions: ToolAction[];
  mode: ToolStripMode;
  onModeChange: (mode: ToolStripMode) => void;
  onSelect: (id: string) => void;
}) {
  const next = nextMode(mode);
  const cycleLabel = `Tool strip: ${MODE_LABEL[mode]}. Activate for ${MODE_LABEL[next].toLowerCase()}.`;

  if (mode === 'hidden') {
    return (
      <div className="relative shrink-0 flex justify-center pb-1">
        <button
          type="button"
          onClick={() => onModeChange('icons')}
          aria-label={cycleLabel}
          title={cycleLabel}
          data-testid="tool-dock-tab"
          className="flex items-center gap-1.5 px-3 py-1 rounded-full border cursor-pointer transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
          style={{
            borderColor: 'var(--sam-color-border-default)',
            backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-surface) 92%, transparent)',
            color: 'var(--sam-color-fg-muted)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.28)',
          }}
        >
          <ChevronUp size={12} aria-hidden="true" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">Tools</span>
        </button>
      </div>
    );
  }

  const compact = mode === 'icons';

  return (
    <div
      data-testid="tool-dock"
      data-mode={mode}
      className="relative shrink-0 flex items-stretch border-t"
      style={{
        borderColor: 'rgba(34,197,94,0.12)',
        backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas) 88%, transparent)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div
        className={`flex-1 min-w-0 flex items-center gap-1 overflow-x-auto px-2 sam-dock-scroll ${
          compact ? 'py-1' : 'py-1.5 flex-wrap sm:flex-nowrap'
        }`}
      >
        {actions.map((action, i) => {
          const Icon = action.icon;
          const color =
            action.tone === 'success' ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)';
          return (
            <div key={action.id} className="flex items-center shrink-0">
              {isGroupStart(actions, i) && (
                <div
                  aria-hidden="true"
                  className="mx-1 w-px h-5 shrink-0"
                  style={{ backgroundColor: 'rgba(34,197,94,0.16)' }}
                />
              )}
              <button
                type="button"
                onClick={() => onSelect(action.id)}
                aria-label={action.hint}
                title={action.hint}
                data-testid={`tool-${action.id}`}
                className={`relative shrink-0 flex items-center justify-center bg-transparent border-none cursor-pointer rounded-md transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary ${
                  compact ? 'w-9 h-9' : 'gap-1.5 h-8 px-2'
                }`}
                style={{ color }}
              >
                <Icon size={17} className="shrink-0" aria-hidden="true" />
                {!compact && (
                  <span className="text-xs font-medium whitespace-nowrap">{action.label}</span>
                )}
                {action.badge !== undefined && <Badge count={action.badge} compact={compact} />}
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onModeChange(next)}
        aria-label={cycleLabel}
        title={cycleLabel}
        data-testid="tool-dock-cycle"
        className="shrink-0 w-9 flex items-center justify-center bg-transparent border-none border-l cursor-pointer text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary"
        style={{ borderLeft: '1px solid rgba(34,197,94,0.10)' }}
      >
        {compact ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
    </div>
  );
}
