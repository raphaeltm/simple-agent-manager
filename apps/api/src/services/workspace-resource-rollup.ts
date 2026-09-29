/**
 * Per-minute rollup of one resource-history chunk.
 *
 * Computed once on upload from the already-decoded chunk payload and stored in
 * `workspace_resource_chunks.rollup_json`, so the session timeline can draw a
 * whole multi-day session from D1 without downloading every R2 chunk. The
 * layout is columnar (one array per metric) to keep a 15-minute chunk's rollup
 * around a kilobyte.
 */
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import type { ResourceSamplePoint, ResourceToolSpan } from './workspace-resource-history';

export const WORKSPACE_RESOURCE_ROLLUP_VERSION = 1;
const DEFAULT_ROLLUP_BUCKET_MS = 60_000;
const DEFAULT_ROLLUP_MAX_BUCKETS = 60;

/** Columnar rollup. Every array has one entry per bucket, ascending by `start`. */
export interface WorkspaceResourceRollup {
  v: typeof WORKSPACE_RESOURCE_ROLLUP_VERSION;
  bucketMs: number;
  start: number[];
  end: number[];
  /** Measured samples in the bucket (gaps and unsupported samples excluded). */
  samples: number[];
  /** CPU in cores (1 = one core fully busy). */
  cpuMeanCores: Array<number | null>;
  cpuMaxCores: Array<number | null>;
  memoryMeanBytes: Array<number | null>;
  memoryMaxBytes: Array<number | null>;
  workingSetMeanBytes: Array<number | null>;
  workingSetMaxBytes: Array<number | null>;
  ioReadBytes: Array<number | null>;
  ioWriteBytes: Array<number | null>;
  oomKills: number[];
  toolCallStarts: number[];
}

export interface RollupConfig {
  bucketMs: number;
  maxBuckets: number;
}

export function getRollupConfig(env: Env): RollupConfig {
  return {
    bucketMs: parsePositiveInt(env.WORKSPACE_RESOURCE_ROLLUP_BUCKET_MS, DEFAULT_ROLLUP_BUCKET_MS),
    maxBuckets: parsePositiveInt(
      env.WORKSPACE_RESOURCE_ROLLUP_MAX_BUCKETS,
      DEFAULT_ROLLUP_MAX_BUCKETS
    ),
  };
}

interface Accumulator {
  start: number;
  samples: number;
  cpuSum: number;
  cpuCount: number;
  cpuMax: number | null;
  memorySum: number;
  memoryCount: number;
  memoryMax: number | null;
  workingSetSum: number;
  workingSetCount: number;
  workingSetMax: number | null;
  ioRead: number | null;
  ioWrite: number | null;
  oomKills: number;
  toolCallStarts: number;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function emptyAccumulator(start: number): Accumulator {
  return {
    start,
    samples: 0,
    cpuSum: 0,
    cpuCount: 0,
    cpuMax: null,
    memorySum: 0,
    memoryCount: 0,
    memoryMax: null,
    workingSetSum: 0,
    workingSetCount: 0,
    workingSetMax: null,
    ioRead: null,
    ioWrite: null,
    oomKills: 0,
    toolCallStarts: 0,
  };
}

function max(current: number | null, value: number): number {
  return current == null ? value : Math.max(current, value);
}

/**
 * Bucket width: the configured width, widened in whole multiples until the
 * chunk's span fits in `maxBuckets`. A normal 15-minute chunk keeps one-minute
 * buckets; a malformed or unusually long one cannot produce an unbounded rollup.
 */
function bucketWidth(spanMs: number, config: RollupConfig): number {
  const needed = Math.ceil(Math.max(spanMs, 1) / config.maxBuckets);
  return Math.max(1, Math.ceil(needed / config.bucketMs)) * config.bucketMs;
}

export function computeWorkspaceResourceRollup(
  payload: { samples?: ResourceSamplePoint[]; toolSpans?: ResourceToolSpan[] },
  window: { startedAt: number; endedAt: number },
  config: RollupConfig
): WorkspaceResourceRollup {
  const width = bucketWidth(window.endedAt - window.startedAt, config);
  const buckets = new Map<number, Accumulator>();
  const bucketFor = (t: number): Accumulator => {
    // Clamp into the chunk window so a stray timestamp cannot add buckets beyond the bound.
    const clamped = Math.min(Math.max(t, window.startedAt), window.endedAt);
    const key = Math.floor(clamped / width) * width;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = emptyAccumulator(key);
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const sample of payload.samples ?? []) {
    if (sample.gap || sample.unsupported) continue;
    // A sample's timestamp closes the interval it measures, (t - interval, t]; a
    // sample stamped exactly on a minute boundary belongs to the minute it ends.
    const bucket = bucketFor(sample.t - 1);
    bucket.samples += 1;

    const intervalMs = finiteNonNegative(sample.intervalMillis);
    const cpuMillis = finiteNonNegative(sample.cpuMillis);
    if (intervalMs && cpuMillis != null) {
      const cores = cpuMillis / intervalMs;
      bucket.cpuSum += cores;
      bucket.cpuCount += 1;
      bucket.cpuMax = max(bucket.cpuMax, cores);
    }

    const memory = finiteNonNegative(sample.memoryBytes);
    if (memory != null) {
      bucket.memorySum += memory;
      bucket.memoryCount += 1;
      bucket.memoryMax = max(bucket.memoryMax, memory);
    }
    // The kernel's memory.peak catches spikes between two samples.
    const memoryPeak = finiteNonNegative(sample.memoryPeakBytes);
    if (memoryPeak != null) bucket.memoryMax = max(bucket.memoryMax, memoryPeak);

    const workingSet = finiteNonNegative(sample.memoryWorkingSetBytes);
    if (workingSet != null) {
      bucket.workingSetSum += workingSet;
      bucket.workingSetCount += 1;
      bucket.workingSetMax = max(bucket.workingSetMax, workingSet);
    }

    // I/O counters are per-sample deltas, so the bucket total is their sum.
    const ioRead = finiteNonNegative(sample.ioReadBytes);
    if (ioRead != null) bucket.ioRead = (bucket.ioRead ?? 0) + ioRead;
    const ioWrite = finiteNonNegative(sample.ioWriteBytes);
    if (ioWrite != null) bucket.ioWrite = (bucket.ioWrite ?? 0) + ioWrite;

    // Same accounting as the collector's chunk summary: oom + oom_kill deltas.
    bucket.oomKills +=
      (finiteNonNegative(sample.oom) ?? 0) + (finiteNonNegative(sample.oomKill) ?? 0);
  }

  for (const span of payload.toolSpans ?? []) {
    bucketFor(span.startedAt).toolCallStarts += 1;
  }

  const ordered = [...buckets.values()].sort((a, b) => a.start - b.start);
  const mean = (sum: number, count: number) => (count > 0 ? sum / count : null);
  return {
    v: WORKSPACE_RESOURCE_ROLLUP_VERSION,
    bucketMs: width,
    start: ordered.map((b) => Math.max(b.start, window.startedAt)),
    end: ordered.map((b) => Math.min(b.start + width, window.endedAt)),
    samples: ordered.map((b) => b.samples),
    cpuMeanCores: ordered.map((b) => mean(b.cpuSum, b.cpuCount)),
    cpuMaxCores: ordered.map((b) => b.cpuMax),
    memoryMeanBytes: ordered.map((b) => {
      const value = mean(b.memorySum, b.memoryCount);
      return value == null ? null : Math.round(value);
    }),
    memoryMaxBytes: ordered.map((b) => b.memoryMax),
    workingSetMeanBytes: ordered.map((b) => {
      const value = mean(b.workingSetSum, b.workingSetCount);
      return value == null ? null : Math.round(value);
    }),
    workingSetMaxBytes: ordered.map((b) => b.workingSetMax),
    ioReadBytes: ordered.map((b) => b.ioRead),
    ioWriteBytes: ordered.map((b) => b.ioWrite),
    oomKills: ordered.map((b) => b.oomKills),
    toolCallStarts: ordered.map((b) => b.toolCallStarts),
  };
}

const ROLLUP_COLUMNS = [
  'start',
  'end',
  'samples',
  'cpuMeanCores',
  'cpuMaxCores',
  'memoryMeanBytes',
  'memoryMaxBytes',
  'workingSetMeanBytes',
  'workingSetMaxBytes',
  'ioReadBytes',
  'ioWriteBytes',
  'oomKills',
  'toolCallStarts',
] as const;

/**
 * Parses a stored rollup, or returns null when it is absent or malformed. A
 * malformed rollup must never break the timeline: the caller falls back to the
 * chunk summary.
 */
export function parseWorkspaceResourceRollup(raw: string | null): WorkspaceResourceRollup | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== WORKSPACE_RESOURCE_ROLLUP_VERSION) return null;
  if (typeof record.bucketMs !== 'number' || !(record.bucketMs > 0)) return null;
  const starts = record.start;
  if (!Array.isArray(starts)) return null;
  for (const column of ROLLUP_COLUMNS) {
    const entries = record[column];
    if (!Array.isArray(entries) || entries.length !== starts.length) return null;
    if (
      !entries.every(
        (entry) => entry === null || (typeof entry === 'number' && Number.isFinite(entry))
      )
    ) {
      return null;
    }
  }
  return value as WorkspaceResourceRollup;
}
