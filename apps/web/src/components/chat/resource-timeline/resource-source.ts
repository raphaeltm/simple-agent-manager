/**
 * Where timeline data comes from.
 *
 * The timeline asks for two things: an index that describes the whole session
 * cheaply, and individual chunks at full resolution. Chunks are immutable once
 * uploaded, so a chunk is fetched at most once per page lifetime and every later
 * zoom or pan over it is served from the query cache.
 */

import {
  getSessionResourceTimeline,
  getSessionResourceTimelineChunk,
  type ResourceTimelineChunkEntry,
  type ResourceTimelineChunkResponse,
  type ResourceTimelineIndexResponse,
  type ResourceTimelineRollup,
  type ResourceTimelineRunEntry,
  type WorkspaceResourceSample,
  type WorkspaceResourceToolSpan,
} from '../../../lib/api';
import {
  type ResourceAggregate,
  type ResourceChunkDetail,
  type ResourceChunkRef,
  type ResourceReservation,
  type ResourceRun,
  type ResourceTimelineIndex,
  type ResourceToolSpan,
  TOOL_KINDS,
  type ToolKind,
} from './types';

export interface ResourceHistorySource {
  /** Separates cache entries between sources; must change whenever the source's data does. */
  readonly cacheKey: readonly unknown[];
  loadIndex(): Promise<ResourceTimelineIndex>;
  loadChunk(chunkId: string): Promise<ResourceChunkDetail>;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_UPLOAD_INTERVAL_MS = 15 * 60_000;

const KNOWN_TOOL_KINDS: ReadonlySet<string> = new Set(TOOL_KINDS);

function toolKind(raw: string | undefined): ToolKind {
  return raw && KNOWN_TOOL_KINDS.has(raw) ? (raw as ToolKind) : 'other';
}

function numberField(record: unknown, key: string): number | null {
  if (typeof record !== 'object' || record === null) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: unknown, key: string): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** A raw cgroup sample as an aggregate over its own sampling interval. */
export function sampleToAggregate(sample: WorkspaceResourceSample): ResourceAggregate {
  const intervalMs = sample.intervalMillis ?? 0;
  const measured = intervalMs > 0 && !sample.unsupported;
  const cores = measured && sample.cpuMillis != null ? sample.cpuMillis / intervalMs : null;
  const memory = sample.unsupported ? null : (sample.memoryBytes ?? null);
  const workingSet = sample.unsupported ? null : (sample.memoryWorkingSetBytes ?? null);
  return {
    start: sample.t - (intervalMs || DEFAULT_SAMPLE_INTERVAL_MS),
    end: sample.t,
    cpuMeanCores: cores,
    cpuMaxCores: cores,
    memoryMeanBytes: memory,
    memoryMaxBytes: memory,
    workingSetMeanBytes: workingSet,
    workingSetMaxBytes: workingSet,
    ioReadBytes: measured ? (sample.ioReadBytes ?? 0) : null,
    ioWriteBytes: measured ? (sample.ioWriteBytes ?? 0) : null,
    oomKills: (sample.oom ?? 0) + (sample.oomKill ?? 0),
    toolCallStarts: 0,
    exact: true,
  };
}

/**
 * Counts each tool call against the sample whose interval saw it start, so raw
 * samples and overview aggregates report tool activity the same way. Calls that
 * started before the chunk's first sample are counted on that first sample.
 */
export function withToolStarts(
  samples: readonly ResourceAggregate[],
  spans: readonly ResourceToolSpan[]
): ResourceAggregate[] {
  const counted = samples.map((sample) => ({ ...sample, toolCallStarts: 0 }));
  for (const span of spans) {
    const target =
      counted.find((sample) => span.startedAt >= sample.start && span.startedAt < sample.end) ??
      (span.startedAt < (counted[0]?.start ?? -Infinity) ? counted[0] : undefined);
    if (target) target.toolCallStarts += 1;
  }
  return counted;
}

function toolSpanFromApi(span: WorkspaceResourceToolSpan): ResourceToolSpan {
  return {
    id: span.id,
    kind: toolKind(span.kind),
    name: stringField(span, 'toolName'),
    startedAt: span.startedAt,
    endedAt: span.endedAt ?? span.startedAt,
    approximateEnd: Boolean(span.approximate),
  };
}

/** Older chunks carry no rollup: their stored summary becomes one aggregate spanning the chunk. */
function summaryOverview(chunk: ResourceTimelineChunkEntry): ResourceAggregate {
  const summary = chunk.summary;
  const intervalMs = numberField(summary, 'sampleIntervalMillis') ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const cpuMean = numberField(summary, 'cpuMeanMillis');
  const cpuPeak = numberField(summary, 'cpuPeakMillis');
  return {
    start: chunk.startedAt,
    end: chunk.endedAt,
    cpuMeanCores: cpuMean == null ? null : cpuMean / intervalMs,
    cpuMaxCores: cpuPeak == null ? null : cpuPeak / intervalMs,
    memoryMeanBytes: numberField(summary, 'memoryMeanBytes'),
    memoryMaxBytes: numberField(summary, 'memoryPeakBytes'),
    workingSetMeanBytes: numberField(summary, 'memoryWorkingSetMeanBytes'),
    workingSetMaxBytes: numberField(summary, 'memoryWorkingSetPeakBytes'),
    ioReadBytes: numberField(summary, 'ioReadBytes'),
    ioWriteBytes: numberField(summary, 'ioWriteBytes'),
    oomKills: numberField(summary, 'oomCount') ?? 0,
    toolCallStarts: chunk.toolSpanCount,
    exact: false,
  };
}

export function rollupOverview(rollup: ResourceTimelineRollup): ResourceAggregate[] {
  return rollup.start.map((start, i) => ({
    start,
    end: rollup.end[i] ?? start + rollup.bucketMs,
    cpuMeanCores: rollup.cpuMeanCores[i] ?? null,
    cpuMaxCores: rollup.cpuMaxCores[i] ?? null,
    memoryMeanBytes: rollup.memoryMeanBytes[i] ?? null,
    memoryMaxBytes: rollup.memoryMaxBytes[i] ?? null,
    workingSetMeanBytes: rollup.workingSetMeanBytes[i] ?? null,
    workingSetMaxBytes: rollup.workingSetMaxBytes[i] ?? null,
    ioReadBytes: rollup.ioReadBytes[i] ?? null,
    ioWriteBytes: rollup.ioWriteBytes[i] ?? null,
    oomKills: rollup.oomKills[i] ?? 0,
    toolCallStarts: rollup.toolCallStarts[i] ?? 0,
    exact: false,
  }));
}

function reservationFromApi(run: ResourceTimelineRunEntry): ResourceReservation | null {
  if (!run.reservation) return null;
  return {
    cpuCores: run.reservation.cpuMillis > 0 ? run.reservation.cpuMillis / 1000 : null,
    memoryBytes: run.reservation.memoryMb > 0 ? run.reservation.memoryMb * 1024 * 1024 : null,
  };
}

function runsFromApi(response: ResourceTimelineIndexResponse): ResourceRun[] {
  return response.runs
    .map((run) => ({
      id: run.workspaceId,
      nodeId: run.nodeId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      unsupportedReason:
        response.chunks
          .filter((chunk) => chunk.workspaceId === run.workspaceId)
          .map((chunk) => stringField(chunk.completeness, 'unsupported'))
          .find((reason) => reason != null) ?? null,
      reservation: reservationFromApi(run),
    }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function indexFromApi(response: ResourceTimelineIndexResponse): ResourceTimelineIndex {
  const chunks: ResourceChunkRef[] = [...response.chunks]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((chunk) => ({
      id: chunk.id,
      runId: chunk.workspaceId,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      sampleCount: chunk.sampleCount,
      overview:
        chunk.rollup && chunk.rollup.start.length > 0
          ? rollupOverview(chunk.rollup)
          : [summaryOverview(chunk)],
      memoryHighWaterBytes: numberField(chunk.summary, 'memoryKernelPeakBytes'),
    }));
  return {
    runs: runsFromApi(response),
    chunks,
    sampleIntervalMs:
      numberField(response.chunks[0]?.summary, 'sampleIntervalMillis') ??
      DEFAULT_SAMPLE_INTERVAL_MS,
    uploadIntervalMs: DEFAULT_UPLOAD_INTERVAL_MS,
    completeness:
      response.omittedChunkCount > 0
        ? { kind: 'truncated', omitted: response.omittedChunkCount }
        : { kind: 'complete' },
    collection: response.collection,
  };
}

/**
 * When the server thinned a chunk (`downsampled`), the kept samples are far apart
 * but each still spans only its own 5-second interval. Stretch each back to the
 * previous kept sample so the line does not break between them — except across a
 * sampler gap, which must stay visible.
 */
function coverThinnedSamples(
  samples: ResourceAggregate[],
  raw: readonly WorkspaceResourceSample[]
): ResourceAggregate[] {
  return samples.map((sample, i) => {
    const previous = samples[i - 1];
    if (!previous || raw[i]?.gap || previous.end >= sample.start) return sample;
    // One kept sample now stands for a wider window: a reading, not a full-resolution measurement of it.
    return { ...sample, start: previous.end, exact: false };
  });
}

export function chunkDetailFromApi(
  chunkId: string,
  detail: ResourceTimelineChunkResponse
): ResourceChunkDetail {
  const toolSpans = detail.toolSpans.map(toolSpanFromApi);
  const raw = [...detail.samples].sort((a, b) => a.t - b.t);
  const samples = raw.map(sampleToAggregate);
  return {
    chunkId,
    samples: withToolStarts(
      detail.downsampled ? coverThinnedSamples(samples, raw) : samples,
      toolSpans
    ),
    toolSpans,
    samplerGaps: detail.gaps
      .map((gap) => ({ start: numberField(gap, 'startedAt'), end: numberField(gap, 'endedAt') }))
      .filter((gap): gap is { start: number; end: number } => gap.start != null && gap.end != null),
  };
}

/** Reads a session's whole resource timeline. */
export function apiResourceHistorySource(
  projectId: string,
  sessionId: string
): ResourceHistorySource {
  return {
    cacheKey: ['session-resource-timeline', projectId, sessionId],
    async loadIndex() {
      return indexFromApi(await getSessionResourceTimeline(projectId, sessionId));
    },
    async loadChunk(chunkId) {
      const response = await getSessionResourceTimelineChunk(projectId, sessionId, chunkId);
      if (response.chunkId !== chunkId) {
        throw new Error(`Resource history chunk ${chunkId} was not returned`);
      }
      return chunkDetailFromApi(chunkId, response);
    },
  };
}
