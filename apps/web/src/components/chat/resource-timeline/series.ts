/**
 * Level-of-detail series building.
 *
 * The chart never receives more points than it has pixels. Whatever data is
 * available for the visible window — raw 5-second samples for downloaded chunks,
 * coarse overview aggregates for the rest — is folded into one bucket per pixel
 * column, keeping both the time-weighted mean and the maximum so a short spike
 * survives any zoom level.
 */

import { type TimeAxis, toAxis, toReal } from './time-axis';
import type { ResourceAggregate } from './types';

export interface TimelineSeries {
  /** Bucket centres, in axis units. */
  x: number[];
  /** Bucket centres, wall clock. */
  t: number[];
  /** Axis milliseconds per bucket. */
  bucketMs: number;
  cpuMean: Array<number | null>;
  cpuMax: Array<number | null>;
  memoryMean: Array<number | null>;
  memoryMax: Array<number | null>;
  workingSetMean: Array<number | null>;
  workingSetMax: Array<number | null>;
  /** Bytes per second, averaged over the part of the bucket that has data. */
  ioReadRate: Array<number | null>;
  ioWriteRate: Array<number | null>;
  /** Tool calls started in the bucket, as far as the overview knows (raw samples carry none). */
  toolStarts: number[];
  /** OOM kills recorded in the bucket. */
  oomKills: number[];
  /** True when every contributing aggregate was a raw sample. */
  exact: boolean[];
}

interface Accumulator {
  covered: number;
  exact: boolean;
  cpuWeighted: number;
  cpuCovered: number;
  cpuMax: number | null;
  memoryWeighted: number;
  memoryCovered: number;
  memoryMax: number | null;
  workingSetWeighted: number;
  workingSetCovered: number;
  workingSetMax: number | null;
  ioRead: number;
  ioWrite: number;
  ioCovered: number;
  toolStarts: number;
  oomKills: number;
}

function emptyAccumulator(): Accumulator {
  return {
    covered: 0,
    exact: true,
    cpuWeighted: 0,
    cpuCovered: 0,
    cpuMax: null,
    memoryWeighted: 0,
    memoryCovered: 0,
    memoryMax: null,
    workingSetWeighted: 0,
    workingSetCovered: 0,
    workingSetMax: null,
    ioRead: 0,
    ioWrite: 0,
    ioCovered: 0,
    toolStarts: 0,
    oomKills: 0,
  };
}

function maxOf(current: number | null, next: number | null): number | null {
  if (next == null) return current;
  return current == null ? next : Math.max(current, next);
}

/** Folds the part of `aggregate` overlapping the bucket (`overlap` ms of `duration`) into `acc`. */
function accumulate(
  acc: Accumulator,
  aggregate: ResourceAggregate,
  overlap: number,
  duration: number
) {
  acc.covered += overlap;
  acc.exact &&= aggregate.exact;
  if (aggregate.cpuMeanCores != null) {
    acc.cpuWeighted += aggregate.cpuMeanCores * overlap;
    acc.cpuCovered += overlap;
  }
  acc.cpuMax = maxOf(acc.cpuMax, aggregate.cpuMaxCores);
  if (aggregate.memoryMeanBytes != null) {
    acc.memoryWeighted += aggregate.memoryMeanBytes * overlap;
    acc.memoryCovered += overlap;
  }
  acc.memoryMax = maxOf(acc.memoryMax, aggregate.memoryMaxBytes);
  if (aggregate.workingSetMeanBytes != null) {
    acc.workingSetWeighted += aggregate.workingSetMeanBytes * overlap;
    acc.workingSetCovered += overlap;
  }
  acc.workingSetMax = maxOf(acc.workingSetMax, aggregate.workingSetMaxBytes);
  const share = duration > 0 ? overlap / duration : 1;
  if (aggregate.ioReadBytes != null && aggregate.ioWriteBytes != null) {
    acc.ioRead += aggregate.ioReadBytes * share;
    acc.ioWrite += aggregate.ioWriteBytes * share;
    acc.ioCovered += overlap;
  }
  acc.toolStarts += aggregate.toolCallStarts * share;
}

/** An OOM kill is an event, not a rate: it belongs wholly to the window holding the aggregate's end. */
function endsWithin(end: number, from: number, to: number): boolean {
  return end > from && end <= to;
}

function weightedMean(weighted: number, covered: number): number | null {
  return covered > 0 ? weighted / covered : null;
}

/**
 * Builds at most `maxBuckets` points for `[viewMin, viewMax]` (axis units).
 *
 * Buckets never get finer than `minBucketMs` — below the sampling interval a
 * bucket would only repeat its neighbour. `aggregates` must be sorted by start
 * and must not overlap (chunks never do; callers pass either a chunk's raw
 * samples or its overview, never both).
 */
export function buildSeries(
  aggregates: readonly ResourceAggregate[],
  axis: TimeAxis,
  viewMin: number,
  viewMax: number,
  maxBuckets: number,
  minBucketMs: number
): TimelineSeries {
  const span = Math.max(1, viewMax - viewMin);
  const bucketMs = Math.max(minBucketMs, span / Math.max(1, maxBuckets));
  const count = Math.max(1, Math.ceil(span / bucketMs));
  const series: TimelineSeries = {
    x: [],
    t: [],
    bucketMs,
    cpuMean: [],
    cpuMax: [],
    memoryMean: [],
    memoryMax: [],
    workingSetMean: [],
    workingSetMax: [],
    ioReadRate: [],
    ioWriteRate: [],
    toolStarts: [],
    oomKills: [],
    exact: [],
  };

  const placed = aggregates.map((aggregate) => ({
    aggregate,
    from: toAxis(axis, aggregate.start),
    to: toAxis(axis, aggregate.end),
  }));
  let first = 0;

  for (let index = 0; index < count; index += 1) {
    const bucketStart = viewMin + index * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const acc = emptyAccumulator();

    while (first < placed.length && (placed[first]?.to ?? Infinity) <= bucketStart) first += 1;
    for (let cursor = first; cursor < placed.length; cursor += 1) {
      const item = placed[cursor];
      if (!item || item.from >= bucketEnd) break;
      const overlap = Math.min(item.to, bucketEnd) - Math.max(item.from, bucketStart);
      if (overlap > 0) accumulate(acc, item.aggregate, overlap, item.to - item.from);
      if (endsWithin(item.to, bucketStart, bucketEnd)) acc.oomKills += item.aggregate.oomKills;
    }

    const centre = bucketStart + bucketMs / 2;
    series.x.push(centre);
    series.t.push(toReal(axis, centre));
    const hasData = acc.covered > 0;
    series.exact.push(hasData && acc.exact);
    series.cpuMean.push(hasData ? weightedMean(acc.cpuWeighted, acc.cpuCovered) : null);
    series.cpuMax.push(hasData ? acc.cpuMax : null);
    series.memoryMean.push(hasData ? weightedMean(acc.memoryWeighted, acc.memoryCovered) : null);
    series.memoryMax.push(hasData ? acc.memoryMax : null);
    series.workingSetMean.push(
      hasData ? weightedMean(acc.workingSetWeighted, acc.workingSetCovered) : null
    );
    series.workingSetMax.push(hasData ? acc.workingSetMax : null);
    const seconds = acc.ioCovered / 1000;
    series.ioReadRate.push(seconds > 0 ? acc.ioRead / seconds : null);
    series.ioWriteRate.push(seconds > 0 ? acc.ioWrite / seconds : null);
    series.toolStarts.push(acc.toolStarts);
    series.oomKills.push(acc.oomKills);
  }

  return series;
}

export interface UsageSummary {
  /** Real milliseconds with data inside the range. */
  coveredMs: number;
  cpuMeanCores: number | null;
  cpuMaxCores: number | null;
  memoryMaxBytes: number | null;
  workingSetMaxBytes: number | null;
  ioReadBytes: number;
  ioWriteBytes: number;
  oomKills: number;
  toolCallStarts: number;
  /** Every contributing aggregate was a raw sample. */
  exact: boolean;
}

/** Totals and peaks over the part of each aggregate inside `[from, to]` (wall clock). */
export function summarizeUsage(
  aggregates: readonly ResourceAggregate[],
  from: number,
  to: number
): UsageSummary {
  const acc = emptyAccumulator();
  for (const aggregate of aggregates) {
    const overlap = Math.min(aggregate.end, to) - Math.max(aggregate.start, from);
    if (overlap > 0) accumulate(acc, aggregate, overlap, aggregate.end - aggregate.start);
    if (endsWithin(aggregate.end, from, to)) acc.oomKills += aggregate.oomKills;
  }
  return {
    coveredMs: acc.covered,
    cpuMeanCores: weightedMean(acc.cpuWeighted, acc.cpuCovered),
    cpuMaxCores: acc.cpuMax,
    memoryMaxBytes: acc.memoryMax,
    workingSetMaxBytes: acc.workingSetMax,
    ioReadBytes: acc.ioRead,
    ioWriteBytes: acc.ioWrite,
    oomKills: acc.oomKills,
    toolCallStarts: Math.round(acc.toolStarts),
    exact: acc.covered > 0 && acc.exact,
  };
}

export type PeakMetric = 'cpu' | 'memory';

export interface UsagePeak {
  metric: PeakMetric;
  /** Wall-clock centre of the aggregate that holds the peak. */
  at: number;
  value: number;
}

/**
 * The `count` highest peaks for `metric`, at least `separationMs` apart so one
 * long spike does not fill the list.
 */
export function findPeaks(
  aggregates: readonly ResourceAggregate[],
  metric: PeakMetric,
  count: number,
  separationMs: number
): UsagePeak[] {
  const candidates = aggregates
    .map((aggregate) => ({
      at: (aggregate.start + aggregate.end) / 2,
      value: metric === 'cpu' ? aggregate.cpuMaxCores : aggregate.memoryMaxBytes,
    }))
    .filter((candidate): candidate is { at: number; value: number } => candidate.value != null)
    .sort((a, b) => b.value - a.value || a.at - b.at);
  const peaks: UsagePeak[] = [];
  for (const candidate of candidates) {
    if (peaks.length >= count) break;
    if (peaks.every((peak) => Math.abs(peak.at - candidate.at) >= separationMs)) {
      peaks.push({ metric, ...candidate });
    }
  }
  return peaks;
}
