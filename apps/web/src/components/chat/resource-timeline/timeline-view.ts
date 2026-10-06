import { useCallback, useMemo, useState } from 'react';

import { type TimeAxis, toAxis, toReal } from './time-axis';

/**
 * Which part of the session is on screen.
 *
 * `all` and `latest` are kept as intents rather than frozen ranges, so while the
 * session keeps uploading data "All" still shows everything and "Latest" keeps
 * following the newest samples. A chosen range is stored in wall-clock time, so
 * switching between active-time and clock-time axes keeps the same moment on screen.
 */
export type ViewIntent =
  | { kind: 'all' }
  | { kind: 'latest'; spanMs: number }
  | { kind: 'range'; from: number; to: number };

/** Visible window in axis units. */
export interface ViewRange {
  min: number;
  max: number;
}

/** Narrowest window: a dozen 5-second samples. */
export const MIN_VIEW_SPAN_MS = 60_000;

function fullSpan(axis: TimeAxis): number {
  return Math.max(MIN_VIEW_SPAN_MS, axis.max - axis.min);
}

/** Keeps a window inside the session without changing its width (unless it is too wide). */
export function clampRange(min: number, max: number, axis: TimeAxis): ViewRange {
  const full = fullSpan(axis);
  const span = Math.min(full, Math.max(MIN_VIEW_SPAN_MS, max - min));
  const start = Math.min(Math.max(min, axis.min), axis.min + full - span);
  return { min: start, max: start + span };
}

export function resolveView(intent: ViewIntent, axis: TimeAxis): ViewRange {
  const full = fullSpan(axis);
  switch (intent.kind) {
    case 'all':
      return { min: axis.min, max: axis.min + full };
    case 'latest': {
      const span = Math.min(full, Math.max(MIN_VIEW_SPAN_MS, intent.spanMs));
      return { min: axis.min + full - span, max: axis.min + full };
    }
    case 'range':
      return clampRange(toAxis(axis, intent.from), toAxis(axis, intent.to), axis);
  }
}

/** The intent a freshly chosen range should be stored as. */
function intentFor(range: ViewRange, axis: TimeAxis): ViewIntent {
  const full = fullSpan(axis);
  const span = range.max - range.min;
  const epsilon = full * 1e-6;
  if (span >= full - epsilon) return { kind: 'all' };
  if (range.max >= axis.min + full - epsilon) return { kind: 'latest', spanMs: span };
  return { kind: 'range', from: toReal(axis, range.min), to: toReal(axis, range.max) };
}

export interface TimelineViewControls {
  view: ViewRange;
  intent: ViewIntent;
  setRange: (min: number, max: number) => void;
  /** Zooms by `factor` (<1 zooms in) keeping the axis position `anchor` fixed on screen. */
  zoom: (factor: number, anchor: number) => void;
  /** Shows `spanMs` of the session centred on `centre` (axis units). */
  showSpan: (spanMs: number, centre: number) => void;
  showLatest: (spanMs: number) => void;
  showAll: () => void;
}

export function useTimelineView(axis: TimeAxis): TimelineViewControls {
  const [intent, setIntent] = useState<ViewIntent>({ kind: 'all' });
  const view = useMemo(() => resolveView(intent, axis), [intent, axis]);

  const setRange = useCallback(
    (min: number, max: number) => setIntent(intentFor(clampRange(min, max, axis), axis)),
    [axis]
  );
  const zoom = useCallback(
    (factor: number, anchor: number) =>
      setRange(anchor - (anchor - view.min) * factor, anchor + (view.max - anchor) * factor),
    [setRange, view]
  );
  const showSpan = useCallback(
    (spanMs: number, centre: number) => setRange(centre - spanMs / 2, centre + spanMs / 2),
    [setRange]
  );
  const showLatest = useCallback((spanMs: number) => setIntent({ kind: 'latest', spanMs }), []);
  const showAll = useCallback(() => setIntent({ kind: 'all' }), []);

  return { view, intent, setRange, zoom, showSpan, showLatest, showAll };
}
