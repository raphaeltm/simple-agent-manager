import { describe, expect, it } from 'vitest';

import { buildTimeAxis, toReal } from '../../../../src/components/chat/resource-timeline/time-axis';
import { clampRange, MIN_VIEW_SPAN_MS, resolveView } from '../../../../src/components/chat/resource-timeline/timeline-view';
import type { ResourceRun } from '../../../../src/components/chat/resource-timeline/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 8, 28, 19, 0, 0);

function run(startedAt: number, endedAt: number): ResourceRun {
  return { id: `run-${startedAt}`, nodeId: null, startedAt, endedAt, unsupportedReason: null, reservation: null };
}

const RUNS = [run(T0, T0 + HOUR), run(T0 + 10 * HOUR, T0 + 11 * HOUR)];

describe('resolveView', () => {
  const axis = buildTimeAxis(RUNS, 'active');

  it('shows the whole axis for "all"', () => {
    expect(resolveView({ kind: 'all' }, axis)).toEqual({ min: axis.min, max: axis.max });
  });

  it('pins "latest" to the end of the session, so it follows new data', () => {
    const view = resolveView({ kind: 'latest', spanMs: 15 * MINUTE }, axis);
    expect(view).toEqual({ min: axis.max - 15 * MINUTE, max: axis.max });

    const grown = buildTimeAxis([...RUNS.slice(0, 1), run(T0 + 10 * HOUR, T0 + 12 * HOUR)], 'active');
    expect(resolveView({ kind: 'latest', spanMs: 15 * MINUTE }, grown).max).toBe(grown.max);
  });

  it('keeps a chosen range on the same wall-clock times when the axis mode changes', () => {
    const intent = { kind: 'range' as const, from: T0 + 10 * HOUR + 5 * MINUTE, to: T0 + 10 * HOUR + 20 * MINUTE };
    for (const mode of ['active', 'clock'] as const) {
      const modeAxis = buildTimeAxis(RUNS, mode);
      const view = resolveView(intent, modeAxis);
      expect(toReal(modeAxis, view.min)).toBeCloseTo(intent.from, 3);
      expect(toReal(modeAxis, view.max)).toBeCloseTo(intent.to, 3);
    }
  });
});

describe('clampRange', () => {
  const axis = buildTimeAxis(RUNS, 'active');

  it('slides a window that runs past the end back inside without changing its width', () => {
    expect(clampRange(axis.max - 10 * MINUTE, axis.max + 20 * MINUTE, axis)).toEqual({
      min: axis.max - 30 * MINUTE,
      max: axis.max,
    });
  });

  it('never zooms in past the minimum span', () => {
    const view = clampRange(axis.min + MINUTE, axis.min + MINUTE + 1_000, axis);
    expect(view.max - view.min).toBe(MIN_VIEW_SPAN_MS);
  });

  it('never zooms out past the whole session', () => {
    expect(clampRange(axis.min - HOUR, axis.max + HOUR, axis)).toEqual({ min: axis.min, max: axis.max });
  });
});
