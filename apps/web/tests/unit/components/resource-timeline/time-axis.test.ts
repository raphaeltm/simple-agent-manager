import { describe, expect, it } from 'vitest';

import {
  activeMsInView,
  axisTicks,
  buildTimeAxis,
  sleepAt,
  sleepBreakWidthMs,
  toAxis,
  toReal,
} from '../../../../src/components/chat/resource-timeline/time-axis';
import type { ResourceRun } from '../../../../src/components/chat/resource-timeline/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date(2026, 8, 28, 19, 0, 0).getTime();

function run(id: string, startedAt: number, endedAt: number): ResourceRun {
  return { id, nodeId: null, startedAt, endedAt, unsupportedReason: null, reservation: null };
}

/** An hour of work, a nine-hour night, another hour of work. */
const NIGHT = [run('a', T0, T0 + HOUR), run('b', T0 + 10 * HOUR, T0 + 11 * HOUR)];

describe('buildTimeAxis', () => {
  it('maps run time one-to-one and compresses the sleep between runs in active mode', () => {
    const axis = buildTimeAxis(NIGHT, 'active');

    expect(axis.spans.map((span) => span.kind)).toEqual(['active', 'sleep', 'active']);
    expect(axis.activeMs).toBe(2 * HOUR);
    const sleepWidth = (axis.spans[1]?.axisEnd ?? 0) - (axis.spans[1]?.axisStart ?? 0);
    expect(sleepWidth).toBeGreaterThan(0);
    expect(sleepWidth).toBeLessThan(9 * HOUR / 10);
    expect(axis.max - axis.min).toBe(2 * HOUR + sleepWidth);
    expect(toAxis(axis, T0 + 30 * MINUTE)).toBe(axis.min + 30 * MINUTE);
  });

  it('keeps real proportions in clock mode', () => {
    const axis = buildTimeAxis(NIGHT, 'clock');

    expect(axis.max - axis.min).toBe(11 * HOUR);
    expect(toAxis(axis, T0 + 5 * HOUR)).toBe(axis.min + 5 * HOUR);
  });

  it.each([
    ['inside the first run', T0 + 15 * MINUTE],
    ['inside the compressed sleep', T0 + 5 * HOUR],
    ['inside the second run', T0 + 10.5 * HOUR],
  ])('round-trips wall-clock time %s to within a millisecond', (_label, t) => {
    const axis = buildTimeAxis(NIGHT, 'active');
    expect(Math.abs(toReal(axis, toAxis(axis, t)) - t)).toBeLessThan(1);
  });

  it('never draws a short pause wider than it really was', () => {
    // Ten active hours make the break unit (90 s) wider than this 30 s handoff between runs.
    const axis = buildTimeAxis([run('a', T0, T0 + 5 * HOUR), run('b', T0 + 5 * HOUR + 30_000, T0 + 10 * HOUR)], 'active');
    const sleep = axis.spans[1];
    expect(sleepBreakWidthMs(axis.activeMs, 2 * MINUTE)).toBeGreaterThan(30_000);
    expect(sleep?.kind).toBe('sleep');
    expect((sleep?.axisEnd ?? 0) - (sleep?.axisStart ?? 0)).toBe(30_000);
  });

  it('draws a night wider than a coffee break, both compressed', () => {
    const activeMs = 10 * HOUR;
    const night = sleepBreakWidthMs(activeMs, 9 * HOUR);
    const coffee = sleepBreakWidthMs(activeMs, 20 * MINUTE);
    expect(night).toBeGreaterThan(coffee);
    expect(night).toBeLessThan(9 * HOUR);
    expect(coffee).toBeLessThan(20 * MINUTE);
  });

  it('merges overlapping runs into one active span', () => {
    const axis = buildTimeAxis([run('a', T0, T0 + HOUR), run('b', T0 + 30 * MINUTE, T0 + 2 * HOUR)], 'active');
    expect(axis.spans).toHaveLength(1);
    expect(axis.activeMs).toBe(2 * HOUR);
  });
});

describe('sleepAt and activeMsInView', () => {
  const axis = buildTimeAxis(NIGHT, 'active');

  it('finds the sleep under an axis position and nothing inside a run', () => {
    const sleep = axis.spans[1];
    const middle = ((sleep?.axisStart ?? 0) + (sleep?.axisEnd ?? 0)) / 2;
    expect(sleepAt(axis, middle)?.realEnd).toBe(T0 + 10 * HOUR);
    expect(sleepAt(axis, axis.min + 10 * MINUTE)).toBeNull();
  });

  it('counts only run time inside the view', () => {
    expect(activeMsInView(axis, axis.min, axis.max)).toBe(2 * HOUR);
    expect(activeMsInView(axis, axis.min, axis.min + 30 * MINUTE)).toBe(30 * MINUTE);
  });
});

describe('axisTicks', () => {
  it('aligns ticks to round local times and never puts one inside a compressed sleep', () => {
    const axis = buildTimeAxis(NIGHT, 'active');
    const ticks = axisTicks(axis, axis.min, axis.max, 15 * MINUTE);

    expect(ticks.length).toBeGreaterThanOrEqual(8);
    for (const tick of ticks) {
      const date = new Date(tick.t);
      expect(date.getMinutes() % 15).toBe(0);
      expect(date.getSeconds()).toBe(0);
      expect(tick.t <= T0 + HOUR || tick.t >= T0 + 10 * HOUR).toBe(true);
    }
  });

  it('drops a tick that would crowd its neighbour across a break', () => {
    // Ticks at the end of one run and the start of the next sit a compressed break apart.
    const axis = buildTimeAxis([run('a', T0, T0 + HOUR), run('b', T0 + 3 * HOUR, T0 + 4 * HOUR)], 'active');
    const ticks = axisTicks(axis, axis.min, axis.max, HOUR);
    const gaps = ticks.slice(1).map((tick, i) => tick.x - (ticks[i]?.x ?? 0));

    expect(ticks.map((tick) => tick.t)).not.toContain(T0 + 3 * HOUR);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.75 * HOUR);
  });
});
