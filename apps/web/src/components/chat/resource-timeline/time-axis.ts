/**
 * The timeline's x axis.
 *
 * A session is a sequence of runs separated by sleeps. Drawn on a plain clock axis,
 * a session that worked for an hour, slept overnight and worked another hour is two
 * slivers either side of a void. In `active` mode each sleep longer than the break
 * width is compressed to that width and drawn as an explicit, labelled break, so
 * the time that has data gets the pixels. `clock` mode keeps real proportions.
 *
 * Positions on the axis are "axis milliseconds": inside a run one axis millisecond
 * is one real millisecond, so durations read off the axis stay true.
 */

import type { ResourceRun } from './types';

export type TimeAxisMode = 'active' | 'clock';

export interface AxisSpan {
  kind: 'active' | 'sleep';
  realStart: number;
  realEnd: number;
  axisStart: number;
  axisEnd: number;
}

export interface TimeAxis {
  mode: TimeAxisMode;
  /** Contiguous and ascending; together they cover `[min, max]`. */
  spans: AxisSpan[];
  min: number;
  max: number;
  /** Real milliseconds covered by runs (the session's active time). */
  activeMs: number;
}

/** A compressed sleep takes this fraction of the session's active time… */
const SLEEP_BREAK_FRACTION = 0.025;
/** …bounded so it stays visible on short sessions and modest on long ones. */
const SLEEP_BREAK_MIN_MS = 15_000;
const SLEEP_BREAK_MAX_MS = 10 * 60_000;

/** Merges overlapping or touching runs into disjoint active intervals. */
function activeIntervals(runs: readonly ResourceRun[]): Array<[number, number]> {
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const merged: Array<[number, number]> = [];
  for (const run of sorted) {
    const last = merged.at(-1);
    if (last && run.startedAt <= last[1]) {
      last[1] = Math.max(last[1], run.endedAt);
    } else {
      merged.push([run.startedAt, Math.max(run.startedAt, run.endedAt)]);
    }
  }
  return merged;
}

export function sleepBreakWidthMs(activeMs: number): number {
  return Math.min(SLEEP_BREAK_MAX_MS, Math.max(SLEEP_BREAK_MIN_MS, activeMs * SLEEP_BREAK_FRACTION));
}

export function buildTimeAxis(runs: readonly ResourceRun[], mode: TimeAxisMode): TimeAxis {
  const intervals = activeIntervals(runs);
  const activeMs = intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
  const breakWidth = sleepBreakWidthMs(activeMs);
  const spans: AxisSpan[] = [];
  let cursor = intervals[0]?.[0] ?? 0;

  for (const [start, end] of intervals) {
    const previous = spans.at(-1);
    if (previous) {
      const sleepMs = start - previous.realEnd;
      const width = mode === 'active' ? Math.min(sleepMs, breakWidth) : sleepMs;
      spans.push({
        kind: 'sleep',
        realStart: previous.realEnd,
        realEnd: start,
        axisStart: cursor,
        axisEnd: cursor + width,
      });
      cursor += width;
    }
    spans.push({ kind: 'active', realStart: start, realEnd: end, axisStart: cursor, axisEnd: cursor + (end - start) });
    cursor += end - start;
  }

  return { mode, spans, min: spans[0]?.axisStart ?? 0, max: cursor, activeMs };
}

/** Index of the span containing `value`, searched by `startKey`; clamps to the ends. */
function spanIndex(axis: TimeAxis, value: number, startKey: 'realStart' | 'axisStart'): number {
  let lo = 0;
  let hi = axis.spans.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const span = axis.spans[mid];
    if (span && span[startKey] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function scaleOf(span: AxisSpan): number {
  const real = span.realEnd - span.realStart;
  return real > 0 ? (span.axisEnd - span.axisStart) / real : 1;
}

/** Real (wall-clock) time → axis position. Outside the session the axis runs at clock speed. */
export function toAxis(axis: TimeAxis, t: number): number {
  const span = axis.spans[spanIndex(axis, t, 'realStart')];
  if (!span) return t;
  if (t <= span.realStart) return span.axisStart - (span.realStart - t);
  if (t >= span.realEnd) return span.axisEnd + (t - span.realEnd);
  return span.axisStart + (t - span.realStart) * scaleOf(span);
}

/** Axis position → real (wall-clock) time. */
export function toReal(axis: TimeAxis, x: number): number {
  const span = axis.spans[spanIndex(axis, x, 'axisStart')];
  if (!span) return x;
  if (x <= span.axisStart) return span.realStart - (span.axisStart - x);
  if (x >= span.axisEnd) return span.realEnd + (x - span.axisEnd);
  const scale = scaleOf(span);
  return span.realStart + (scale > 0 ? (x - span.axisStart) / scale : 0);
}

/** The sleep containing the axis position, if the position falls inside one. */
export function sleepAt(axis: TimeAxis, x: number): AxisSpan | null {
  const span = axis.spans[spanIndex(axis, x, 'axisStart')];
  return span?.kind === 'sleep' && x >= span.axisStart && x < span.axisEnd ? span : null;
}

/** Axis spans (compressed breaks included) that are sleeps. */
export function sleeps(axis: TimeAxis): AxisSpan[] {
  return axis.spans.filter((span) => span.kind === 'sleep');
}

const TICK_STEPS_MS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000,
  3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000,
];

/** The finest tick step that keeps labels at least `minSpacingPx` apart. */
export function tickStepMs(msPerPx: number, minSpacingPx: number): number {
  const wanted = msPerPx * minSpacingPx;
  return TICK_STEPS_MS.find((step) => step >= wanted) ?? TICK_STEPS_MS.at(-1) ?? wanted;
}

/**
 * Tick positions (axis units) for the visible window, aligned to round wall-clock
 * times in the viewer's zone. Compressed sleeps get no ticks: their scale differs
 * from the runs around them, so a tick inside one would lie about the spacing.
 */
export function axisTicks(
  axis: TimeAxis,
  viewMin: number,
  viewMax: number,
  stepMs: number
): Array<{ x: number; t: number }> {
  const zoneOffsetMs = new Date(toReal(axis, viewMin)).getTimezoneOffset() * 60_000;
  const ticks: Array<{ x: number; t: number }> = [];
  for (const span of axis.spans) {
    if (span.axisEnd < viewMin || span.axisStart > viewMax) continue;
    if (span.kind === 'sleep' && scaleOf(span) !== 1) continue;
    const from = Math.max(span.realStart, toReal(axis, viewMin));
    const to = Math.min(span.realEnd, toReal(axis, viewMax));
    const first = Math.ceil((from - zoneOffsetMs) / stepMs) * stepMs + zoneOffsetMs;
    for (let t = first; t <= to; t += stepMs) {
      const x = toAxis(axis, t);
      const last = ticks.at(-1);
      if (!last || x > last.x) ticks.push({ x, t });
    }
  }
  return ticks;
}
