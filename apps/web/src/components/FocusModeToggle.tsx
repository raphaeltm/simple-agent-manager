import { ArrowLeftRight, Maximize2, Minimize2, Sparkles } from 'lucide-react';

import {
  FOCUS_MODE_ORDER,
  type FocusMode,
  focusModeLabel,
  nextFocusMode,
} from '../lib/focus-mode';

/**
 * Focus Mode control for the desktop nav sidebar.
 *
 * - `segmented`: a three-button group (Default / Focus / Zen) shown when the
 *   sidebar is wide enough to fit labels (default mode).
 * - `cycle`: a single compact icon button shown in the 56px focus rail, where
 *   the segmented group would not fit. Clicking it advances to the next mode.
 *
 * The shared mode state lives in AppShellContext; this component only renders
 * controls and forwards intent via `onSelect` / `onCycle`.
 */

const MODE_ICON: Record<FocusMode, typeof Maximize2> = {
  default: Maximize2,
  focus: Minimize2,
  zen: Sparkles,
};

export function FocusModeToggle({
  mode,
  onSelect,
  onCycle,
  variant,
}: {
  mode: FocusMode;
  onSelect: (mode: FocusMode) => void;
  onCycle: () => void;
  variant: 'segmented' | 'cycle';
}) {
  if (variant === 'cycle') {
    const NextIcon = MODE_ICON[nextFocusMode(mode)];
    return (
      <button
        type="button"
        onClick={onCycle}
        aria-label={`Focus Mode: ${focusModeLabel(mode)}. Activate to switch to ${focusModeLabel(nextFocusMode(mode))}`}
        title={`Focus Mode: ${focusModeLabel(mode)} (F to cycle)`}
        className="mx-auto flex h-8 w-8 items-center justify-center rounded-sm bg-transparent border border-border-default text-fg-muted cursor-pointer hover:bg-[var(--sam-chrome-accent-hover-subtle)] hover:text-fg-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sam-color-focus-ring)]"
      >
        <NextIcon size={15} />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <div
        role="group"
        aria-label="Focus Mode"
        className="flex flex-1 items-center gap-0.5 rounded-sm bg-[var(--sam-color-bg-inset,#0d1816)] p-0.5"
      >
        {FOCUS_MODE_ORDER.map((m) => {
          const Icon = MODE_ICON[m];
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onSelect(m)}
              aria-pressed={active}
              title={focusModeLabel(m)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-[3px] py-1 text-[11px] font-medium cursor-pointer border-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sam-color-focus-ring)] ${
                active
                  ? 'bg-[var(--sam-chrome-accent-active-subtle)] text-accent'
                  : 'bg-transparent text-fg-muted hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)]'
              }`}
            >
              <Icon size={13} />
              <span>{focusModeLabel(m)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onCycle}
        aria-label="Cycle Focus Mode"
        title="Cycle Focus Mode (F)"
        className="flex items-center gap-1 rounded-sm bg-transparent border border-border-default px-1.5 py-1 text-fg-muted cursor-pointer hover:bg-[var(--sam-chrome-accent-hover-subtle)] hover:text-fg-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sam-color-focus-ring)]"
      >
        <ArrowLeftRight size={13} />
        <kbd className="font-mono text-[10px]">F</kbd>
      </button>
    </div>
  );
}
