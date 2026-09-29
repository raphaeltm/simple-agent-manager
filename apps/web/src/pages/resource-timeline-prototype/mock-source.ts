/**
 * PROTOTYPE ONLY — a ResourceHistorySource over the synthetic sessions.
 *
 * `proposed` models the backend this prototype argues for: every chunk listed
 * (no cap) with per-minute rollups computed at upload time, so the whole session
 * draws from the index alone. `current` models today's API: one summary per
 * chunk and only the newest 24 chunks.
 */

import type { ResourceHistorySource } from '../../components/chat/resource-timeline/resource-source';
import type {
  ResourceAggregate,
  ResourceChunkDetail,
  ResourceChunkRef,
  ResourceTimelineIndex,
  ResourceToolSpan,
} from '../../components/chat/resource-timeline/types';
import {
  CHUNK_INTERVAL_MS,
  chunkRun,
  generateRun,
  SAMPLE_INTERVAL_MS,
  scenarioById,
  type ScenarioPlan,
} from './mock-sessions';

export type BackendMode = 'proposed' | 'current';
export type LatencyProfile = 'fast' | 'realistic' | 'slow';

const CURRENT_API_CHUNK_LIMIT = 24;
const ROLLUP_MS = 60_000;

const LATENCY: Record<LatencyProfile, { index: number; chunkMin: number; chunkMax: number }> = {
  fast: { index: 40, chunkMin: 20, chunkMax: 60 },
  realistic: { index: 350, chunkMin: 180, chunkMax: 650 },
  slow: { index: 1_400, chunkMin: 1_200, chunkMax: 3_200 },
};

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0) / 4294967296;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maxOrNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length ? Math.max(...present) : null;
}

function meanOrNull(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

/** What the proposed backend would store per chunk: one aggregate per minute. */
function rollup(
  samples: readonly ResourceAggregate[],
  spans: readonly ResourceToolSpan[],
  start: number,
  end: number,
  bucketMs: number
): ResourceAggregate[] {
  const buckets: ResourceAggregate[] = [];
  for (let from = start; from < end; from += bucketMs) {
    const to = Math.min(end, from + bucketMs);
    const inside = samples.filter((sample) => sample.end > from && sample.end <= to);
    if (inside.length === 0) continue;
    buckets.push({
      start: from,
      end: to,
      cpuMeanCores: meanOrNull(inside.map((sample) => sample.cpuMeanCores)),
      cpuMaxCores: maxOrNull(inside.map((sample) => sample.cpuMaxCores)),
      memoryMeanBytes: meanOrNull(inside.map((sample) => sample.memoryMeanBytes)),
      memoryMaxBytes: maxOrNull(inside.map((sample) => sample.memoryMaxBytes)),
      workingSetMeanBytes: meanOrNull(inside.map((sample) => sample.workingSetMeanBytes)),
      workingSetMaxBytes: maxOrNull(inside.map((sample) => sample.workingSetMaxBytes)),
      ioReadBytes: inside.reduce((sum, sample) => sum + (sample.ioReadBytes ?? 0), 0),
      ioWriteBytes: inside.reduce((sum, sample) => sum + (sample.ioWriteBytes ?? 0), 0),
      oomKills: inside.reduce((sum, sample) => sum + sample.oomKills, 0),
      toolCallStarts: spans.filter((span) => span.startedAt >= from && span.startedAt < to).length,
      exact: false,
    });
  }
  return buckets;
}

/** Each run trimmed to the chunks that were actually returned for it. */
function runsCoveredBy(
  runs: ResourceTimelineIndex['runs'],
  chunks: readonly ResourceChunkRef[]
): ResourceTimelineIndex['runs'] {
  return runs.flatMap((run) => {
    const own = chunks.filter((chunk) => chunk.runId === run.id);
    if (own.length === 0) return [];
    return [
      {
        ...run,
        startedAt: Math.min(...own.map((chunk) => chunk.startedAt)),
        endedAt: Math.max(...own.map((chunk) => chunk.endedAt)),
      },
    ];
  });
}

interface BuiltScenario {
  plan: ScenarioPlan;
  refs: ResourceChunkRef[];
  details: Map<string, ResourceChunkDetail>;
  runs: ResourceTimelineIndex['runs'];
}

const built = new Map<string, BuiltScenario>();

function buildScenario(plan: ScenarioPlan, backend: BackendMode): BuiltScenario {
  const key = `${plan.id}:${backend}`;
  const cached = built.get(key);
  if (cached) return cached;

  const generated = plan.runs.map((run, index) => generateRun(run, plan, index));
  const refs: ResourceChunkRef[] = [];
  const details = new Map<string, ResourceChunkDetail>();
  for (const run of generated) {
    for (const chunk of chunkRun(run)) {
      details.set(chunk.id, chunk.detail);
      const minuteRollup = rollup(chunk.detail.samples, run.toolSpans, chunk.startedAt, chunk.endedAt, ROLLUP_MS);
      const wholeChunk = rollup(chunk.detail.samples, run.toolSpans, chunk.startedAt, chunk.endedAt, CHUNK_INTERVAL_MS);
      refs.push({
        id: chunk.id,
        runId: run.run.id,
        startedAt: chunk.startedAt,
        endedAt: chunk.endedAt,
        sampleCount: chunk.detail.samples.length,
        overview: backend === 'proposed' ? minuteRollup : wholeChunk,
        memoryHighWaterBytes: chunk.highWater,
      });
    }
  }
  const result = { plan, refs, details, runs: generated.map((run) => run.run) };
  built.set(key, result);
  return result;
}

export function createMockSource(
  scenarioId: string,
  backend: BackendMode,
  latency: LatencyProfile
): ResourceHistorySource {
  const plan = scenarioById(scenarioId);
  const timing = LATENCY[latency];
  return {
    cacheKey: ['prototype-resource-history', plan.id, backend, latency],
    async loadIndex() {
      await delay(timing.index);
      const scenario = buildScenario(plan, backend);
      const truncated = backend === 'current' && scenario.refs.length > CURRENT_API_CHUNK_LIMIT;
      const chunks = truncated ? scenario.refs.slice(-CURRENT_API_CHUNK_LIMIT) : scenario.refs;
      return {
        // Like the real adapter, the current API only knows the runs its returned chunks cover.
        runs: backend === 'proposed' ? scenario.runs : runsCoveredBy(scenario.runs, chunks),
        chunks,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        uploadIntervalMs: CHUNK_INTERVAL_MS,
        completeness: truncated ? { kind: 'truncated', omitted: null } : { kind: 'complete' },
        reservation: backend === 'proposed' ? plan.reservation : null,
      };
    },
    async loadChunk(chunkId) {
      const jitter = hash(chunkId);
      await delay(timing.chunkMin + jitter * (timing.chunkMax - timing.chunkMin));
      const detail = buildScenario(plan, backend).details.get(chunkId);
      if (!detail) throw new Error(`Unknown chunk ${chunkId}`);
      return detail;
    },
  };
}
