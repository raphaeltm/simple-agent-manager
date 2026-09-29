import { describe, expect, it } from 'vitest';

import { buildSeries, findPeaks, summarizeUsage } from '../../../../src/components/chat/resource-timeline/series';
import { buildTimeAxis } from '../../../../src/components/chat/resource-timeline/time-axis';
import type { ResourceAggregate, ResourceRun } from '../../../../src/components/chat/resource-timeline/types';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const MB = 1024 ** 2;
const T0 = Date.UTC(2026, 8, 28, 19, 0, 0);

function aggregate(start: number, end: number, overrides: Partial<ResourceAggregate> = {}): ResourceAggregate {
  return {
    start,
    end,
    cpuMeanCores: 0.1,
    cpuMaxCores: 0.1,
    memoryMeanBytes: 1000 * MB,
    memoryMaxBytes: 1000 * MB,
    workingSetMeanBytes: null,
    workingSetMaxBytes: null,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    oomKills: 0,
    toolCallStarts: 0,
    exact: false,
    ...overrides,
  };
}

/** Raw 5-second samples of steady load, as a downloaded chunk would give them. */
function samples(from: number, count: number, cores = 0.1): ResourceAggregate[] {
  return Array.from({ length: count }, (_, i) =>
    aggregate(from + i * 5 * SECOND, from + (i + 1) * 5 * SECOND, { cpuMeanCores: cores, cpuMaxCores: cores, exact: true })
  );
}

function run(startedAt: number, endedAt: number): ResourceRun {
  return { id: `run-${startedAt}`, nodeId: null, startedAt, endedAt, unsupportedReason: null };
}

describe('buildSeries', () => {
  const hour = buildTimeAxis([run(T0, T0 + HOUR)], 'active');

  it('keeps a single-sample spike visible when many samples share a bucket', () => {
    const data = samples(T0, 720);
    data[300] = { ...(data[300] as ResourceAggregate), cpuMeanCores: 3.9, cpuMaxCores: 3.9 };

    const series = buildSeries(data, hour, hour.min, hour.max, 60, 5 * SECOND);

    expect(series.x).toHaveLength(60);
    const peaks = series.cpuMax.filter((value) => value === 3.9);
    expect(peaks).toHaveLength(1);
    const spikeBucket = series.cpuMax.indexOf(3.9);
    expect(series.cpuMean[spikeBucket]).toBeCloseTo((11 * 0.1 + 3.9) / 12, 6);
    expect(series.cpuMean[0]).toBeCloseTo(0.1, 6);
    expect(series.exact.every(Boolean)).toBe(true);
  });

  it('time-weights coarse aggregates that only partly overlap a bucket', () => {
    const data = [
      aggregate(T0, T0 + MINUTE, { cpuMeanCores: 1, cpuMaxCores: 1 }),
      aggregate(T0 + MINUTE, T0 + 2 * MINUTE, { cpuMeanCores: 3, cpuMaxCores: 5 }),
    ];
    const axis = buildTimeAxis([run(T0, T0 + 2 * MINUTE)], 'active');

    // One bucket straddling the boundary: half of each minute.
    const series = buildSeries(data, axis, axis.min + 30 * SECOND, axis.min + 90 * SECOND, 1, 5 * SECOND);

    expect(series.cpuMean[0]).toBeCloseTo(2, 6);
    expect(series.cpuMax[0]).toBe(5);
    expect(series.exact[0]).toBe(false);
  });

  it('leaves buckets with no data empty so the line breaks across a sleep', () => {
    const axis = buildTimeAxis([run(T0, T0 + HOUR), run(T0 + 10 * HOUR, T0 + 11 * HOUR)], 'clock');
    const data = [...samples(T0, 720), ...samples(T0 + 10 * HOUR, 720)];

    const series = buildSeries(data, axis, axis.min, axis.max, 110, 5 * SECOND);

    const asleep = series.t.map((t, i) => ({ t, value: series.cpuMean[i] })).filter(({ t }) => t > T0 + 2 * HOUR && t < T0 + 9 * HOUR);
    expect(asleep.length).toBeGreaterThan(0);
    expect(asleep.every(({ value }) => value === null)).toBe(true);
    expect(series.cpuMean[0]).not.toBeNull();
  });

  it('reports disk traffic as a rate over the time that has data', () => {
    const data = [aggregate(T0, T0 + 5 * SECOND, { ioWriteBytes: 5 * MB, ioReadBytes: 10 * MB, exact: true })];
    const axis = buildTimeAxis([run(T0, T0 + 5 * SECOND)], 'active');

    const series = buildSeries(data, axis, axis.min, axis.max, 1, 5 * SECOND);

    expect(series.ioWriteRate[0]).toBeCloseTo(MB, 3);
    expect(series.ioReadRate[0]).toBeCloseTo(2 * MB, 3);
  });

  it('counts an OOM kill once even when its aggregate spans many buckets', () => {
    const data = [aggregate(T0, T0 + 15 * MINUTE, { oomKills: 1 })];
    const axis = buildTimeAxis([run(T0, T0 + 15 * MINUTE)], 'active');

    const series = buildSeries(data, axis, axis.min, axis.max, 15, 5 * SECOND);

    expect(series.oomKills.reduce((sum, kills) => sum + kills, 0)).toBe(1);
    expect(series.cpuMean.every((value) => value === 0.1)).toBe(true);
  });

  it('never makes buckets finer than the sampling interval', () => {
    const series = buildSeries(samples(T0, 12), hour, hour.min, hour.min + MINUTE, 400, 5 * SECOND);
    expect(series.bucketMs).toBe(5 * SECOND);
    expect(series.x).toHaveLength(12);
  });
});

describe('summarizeUsage', () => {
  it('totals bytes, takes peaks and counts events inside the window only', () => {
    const data = [
      aggregate(T0, T0 + MINUTE, { cpuMaxCores: 2, ioWriteBytes: 60 * MB, oomKills: 1, toolCallStarts: 4 }),
      aggregate(T0 + MINUTE, T0 + 2 * MINUTE, { cpuMaxCores: 4, ioWriteBytes: 60 * MB, oomKills: 1 }),
    ];

    const firstMinute = summarizeUsage(data, T0, T0 + MINUTE);
    expect(firstMinute.cpuMaxCores).toBe(2);
    expect(firstMinute.ioWriteBytes).toBeCloseTo(60 * MB, 0);
    expect(firstMinute.oomKills).toBe(1);
    expect(firstMinute.toolCallStarts).toBe(4);

    const halfOfSecond = summarizeUsage(data, T0 + MINUTE, T0 + 90 * SECOND);
    expect(halfOfSecond.ioWriteBytes).toBeCloseTo(30 * MB, 0);
    expect(halfOfSecond.oomKills).toBe(0);
  });
});

describe('findPeaks', () => {
  it('returns the highest peaks, at least the separation apart, highest first', () => {
    const data = [
      aggregate(T0, T0 + MINUTE, { cpuMaxCores: 3 }),
      aggregate(T0 + MINUTE, T0 + 2 * MINUTE, { cpuMaxCores: 3.5 }),
      aggregate(T0 + HOUR, T0 + HOUR + MINUTE, { cpuMaxCores: 2 }),
    ];

    const peaks = findPeaks(data, 'cpu', 3, 20 * MINUTE);

    expect(peaks.map((peak) => peak.value)).toEqual([3.5, 2]);
  });
});
