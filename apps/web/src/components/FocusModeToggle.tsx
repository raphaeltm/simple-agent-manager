import { IconButton, SegmentedControl } from '@simple-agent-manager/ui';
import { Maximize2, Minimize2, Sparkles } from 'lucide-react';

import {
  FOCUS_MODE_ORDER,
  type FocusMode,
  focusModeLabel,
  nextFocusMode,
} from '../lib/focus-mode';

/**
 * Focus Mode control for the desktop nav sidebar.
 *
 * - `segmented`: a SAM Glass segmented control (Default / Focus / Zen) shown when
 *   the sidebar is wide enough to fit labels (default mode). The F key cycles.
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
      <IconButton
        label={`Focus Mode: ${focusModeLabel(mode)}. Activate to switch to ${focusModeLabel(nextFocusMode(mode))}`}
        icon={<NextIcon size={17} strokeWidth={1.75} />}
        onClick={onCycle}
        showTooltip={false}
        title={`Focus Mode: ${focusModeLabel(mode)} (F to cycle)`}
        className="mx-auto"
      />
    );
  }

  return (
    <SegmentedControl
      label="Focus Mode"
      value={mode}
      onChange={onSelect}
      options={FOCUS_MODE_ORDER.map((m) => ({
        value: m,
        label: focusModeLabel(m),
        title: `${focusModeLabel(m)} (F to cycle)`,
      }))}
    />
  );
}
