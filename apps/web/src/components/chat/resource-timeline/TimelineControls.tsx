import { AlertTriangle, ChevronsRight, Loader2, X } from 'lucide-react';

import { formatBytes, formatCores, formatDayTime, formatElapsed } from './format';
import type { Readout } from './readout';
import type { UsagePeak } from './series';
import type { TimeAxisMode } from './time-axis';

const PRESET_SPANS_MS = [
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '3h', ms: 3 * 60 * 60_000 },
];

/** Tapping a peak shows this much time around it. */
export const PEAK_CONTEXT_MS = 10 * 60_000;

const chip =
  'rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring';
const chipIdle = `${chip} border-border-default text-fg-muted hover:bg-surface-hover hover:text-fg-primary`;
const chipActive = `${chip} border-accent bg-accent/15 text-fg-primary`;

export function ReadoutBar({
  readout,
  pendingChunks,
  failedChunks,
  onClear,
}: Readonly<{ readout: Readout; pendingChunks: number; failedChunks: number; onClear: () => void }>) {
  return (
    <div className="flex min-h-[44px] items-start justify-between gap-2 rounded-lg border border-border-default bg-inset px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold tabular-nums text-fg-primary">{readout.time}</div>
        <div className="break-words text-xs text-fg-muted">{readout.context}</div>
        {readout.oomKills > 0 && (
          <div className="mt-1 flex items-center gap-1 text-xs font-medium text-danger-fg">
            <AlertTriangle size={12} aria-hidden="true" />
            {readout.oomKills} out-of-memory kill{readout.oomKills === 1 ? '' : 's'}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {pendingChunks > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-fg-muted" role="status">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            detail
          </span>
        )}
        {failedChunks > 0 && pendingChunks === 0 && (
          <span className="text-[11px] text-warning-fg" role="status">
            detail unavailable
          </span>
        )}
        {readout.mode === 'cursor' && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear the selected instant"
            className="rounded p-1 text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function RangeControls({
  fullSpanMs,
  viewSpanMs,
  followingLatest,
  axisMode,
  hasSleeps,
  onAll,
  onSpan,
  onLatest,
  onAxisMode,
}: Readonly<{
  fullSpanMs: number;
  viewSpanMs: number;
  followingLatest: boolean;
  axisMode: TimeAxisMode;
  hasSleeps: boolean;
  onAll: () => void;
  onSpan: (spanMs: number) => void;
  onLatest: () => void;
  onAxisMode: (mode: TimeAxisMode) => void;
}>) {
  const showingAll = viewSpanMs >= fullSpanMs * 0.999;
  const presets = PRESET_SPANS_MS.filter((preset) => preset.ms < fullSpanMs * 0.9);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <button type="button" className={showingAll ? chipActive : chipIdle} onClick={onAll} aria-pressed={showingAll}>
        All
      </button>
      {presets.map((preset) => {
        const active = !showingAll && Math.abs(viewSpanMs - preset.ms) < preset.ms * 0.02;
        return (
          <button
            key={preset.label}
            type="button"
            className={active ? chipActive : chipIdle}
            aria-pressed={active}
            onClick={() => onSpan(preset.ms)}
          >
            {preset.label}
          </button>
        );
      })}
      <button
        type="button"
        className={`${followingLatest && !showingAll ? chipActive : chipIdle} flex items-center gap-0.5`}
        onClick={onLatest}
        aria-pressed={followingLatest && !showingAll}
        title="Follow the most recent data"
      >
        Latest
        <ChevronsRight size={12} aria-hidden="true" />
      </button>
      {hasSleeps && (
        <div className="ml-auto flex rounded-full border border-border-default p-0.5 text-[11px]" role="group" aria-label="Time axis">
          {(['active', 'clock'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={axisMode === mode}
              onClick={() => onAxisMode(mode)}
              className={`rounded-full px-2 py-0.5 ${axisMode === mode ? 'bg-accent/20 text-fg-primary' : 'text-fg-muted'}`}
            >
              {mode === 'active' ? 'Active time' : 'Clock time'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PeakList({
  peaks,
  runLabel,
  onSelect,
}: Readonly<{ peaks: UsagePeak[]; runLabel: (t: number) => string; onSelect: (peak: UsagePeak) => void }>) {
  if (peaks.length === 0) return null;
  return (
    <section className="mt-4" aria-label="Busiest moments">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Busiest moments</h3>
      <ul className="mt-1.5 divide-y divide-border-default rounded-lg border border-border-default">
        {peaks.map((peak) => (
          <li key={`${peak.metric}-${peak.at}`}>
            <button
              type="button"
              onClick={() => onSelect(peak)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-hover"
            >
              <span className="min-w-0">
                <span className="block text-sm tabular-nums text-fg-primary">
                  {peak.metric === 'cpu' ? formatCores(peak.value) : `${formatBytes(peak.value)} memory`}
                </span>
                <span className="block break-words text-xs text-fg-muted">
                  {formatDayTime(peak.at)} · {runLabel(peak.at)}
                </span>
              </span>
              <span className="shrink-0 text-xs text-accent">Zoom to ±{formatElapsed(PEAK_CONTEXT_MS / 2)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
