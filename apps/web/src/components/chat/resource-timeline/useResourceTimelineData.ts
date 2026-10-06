import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { ResourceHistorySource } from './resource-source';
import { buildTimeAxis, type TimeAxis, type TimeAxisMode, toReal } from './time-axis';
import type {
  ResourceAggregate,
  ResourceChunkDetail,
  ResourceChunkRef,
  ResourceTimelineIndex,
  ResourceToolSpan,
} from './types';

/** The index grows while the session runs (one chunk per upload), so it goes stale. */
const INDEX_STALE_TIME_MS = 30_000;
/** Chunks are immutable once uploaded: never refetch, keep long enough to pan back. */
const CHUNK_GC_TIME_MS = 30 * 60_000;
/**
 * Upper bound on chunks downloaded for one view (15-minute chunks: 8 hours). Past
 * it the overview already has more than one aggregate per pixel, so detail would
 * not change what is drawn.
 */
const MAX_DETAIL_CHUNKS = 32;

export interface TimelineViewport {
  /** Visible range, axis units. */
  min: number;
  max: number;
  /** Plot width in CSS pixels — the number of buckets the chart can show. */
  widthPx: number;
}

export interface ResourceTimelineData {
  index: ResourceTimelineIndex;
  axis: TimeAxis;
  /** Best available data for the window: raw samples where downloaded, overview elsewhere. */
  aggregates: ResourceAggregate[];
  /** Whole-session overview (stable while zooming), for peaks and session totals. */
  overview: ResourceAggregate[];
  /** The whole session at the best detail loaded so far: raw samples where fetched, overview elsewhere. */
  sessionAggregates: ResourceAggregate[];
  /** Tool spans from downloaded chunks overlapping the window. */
  toolSpans: ResourceToolSpan[];
  /** Chunks the window needs that are still downloading. */
  pendingChunks: number;
  failedChunks: number;
}

/**
 * Chunks overlapping `[from, to]` plus one neighbour either side. The neighbours
 * make a small pan land on cached data, and they carry tool calls that overlap the
 * window but ended after it (the collector files a span under the chunk where it ends).
 */
function chunksAround(
  chunks: readonly ResourceChunkRef[],
  from: number,
  to: number
): ResourceChunkRef[] {
  const first = chunks.findIndex((chunk) => chunk.endedAt > from);
  if (first === -1) return chunks.slice(-1);
  let last = first;
  while (last + 1 < chunks.length && (chunks[last + 1]?.startedAt ?? Infinity) < to) last += 1;
  return chunks.slice(Math.max(0, first - 1), last + 2);
}

interface ChunkQueryState {
  details: Array<ResourceChunkDetail | undefined>;
  pending: number;
  failed: number;
}

/** Module-level so `useQueries` does not re-run it on every render; its output is structurally shared. */
function combineChunkQueries(
  results: Array<{
    data?: ResourceChunkDetail;
    isPending: boolean;
    isError: boolean;
    fetchStatus: string;
  }>
): ChunkQueryState {
  return {
    details: results.map((result) => result.data),
    pending: results.filter((result) => result.isPending && result.fetchStatus === 'fetching')
      .length,
    failed: results.filter((result) => result.isError).length,
  };
}

/** Duration of the chunk's coarsest overview aggregate — what the overview can resolve. */
function overviewResolutionMs(chunk: ResourceChunkRef): number {
  return chunk.overview.reduce(
    (widest, aggregate) => Math.max(widest, aggregate.end - aggregate.start),
    0
  );
}

export function useResourceTimelineIndex(source: ResourceHistorySource) {
  return useQuery({
    queryKey: [...source.cacheKey, 'index'],
    queryFn: () => source.loadIndex(),
    staleTime: INDEX_STALE_TIME_MS,
  });
}

export function useTimelineAxis(index: ResourceTimelineIndex | undefined, mode: TimeAxisMode) {
  return useMemo(() => buildTimeAxis(index?.runs ?? [], mode), [index?.runs, mode]);
}

/**
 * Resolves the data for one visible window. Downloads a chunk only when the
 * window is zoomed in past what that chunk's overview can show.
 */
export function useResourceTimelineData(
  source: ResourceHistorySource,
  index: ResourceTimelineIndex,
  axis: TimeAxis,
  viewport: TimelineViewport
): ResourceTimelineData {
  const from = toReal(axis, viewport.min);
  const to = toReal(axis, viewport.max);
  const msPerPx = (viewport.max - viewport.min) / Math.max(1, viewport.widthPx);

  const visibleChunks = useMemo(
    () => chunksAround(index.chunks, from, to),
    [index.chunks, from, to]
  );
  const wantDetail =
    visibleChunks.length <= MAX_DETAIL_CHUNKS &&
    visibleChunks.some((chunk) => overviewResolutionMs(chunk) > msPerPx);

  // Chunks already in the cache are used at any zoom level; only downloads are gated.
  const { details, pending, failed } = useQueries({
    queries: visibleChunks.map((chunk) => ({
      queryKey: [...source.cacheKey, 'chunk', chunk.id],
      queryFn: () => source.loadChunk(chunk.id),
      enabled: wantDetail,
      staleTime: Infinity,
      gcTime: CHUNK_GC_TIME_MS,
    })),
    combine: combineChunkQueries,
  });

  const overview = useMemo(() => index.chunks.flatMap((chunk) => chunk.overview), [index.chunks]);

  const { aggregates, toolSpans } = useMemo(() => {
    const merged: ResourceAggregate[] = [];
    const spans: ResourceToolSpan[] = [];
    visibleChunks.forEach((chunk, position) => {
      const detail = details[position];
      merged.push(...(detail ? detail.samples : chunk.overview));
      if (detail) spans.push(...detail.toolSpans);
    });
    return { aggregates: merged, toolSpans: spans };
  }, [visibleChunks, details]);

  const sessionAggregates = useMemo(() => {
    const loaded = new Map(visibleChunks.map((chunk, position) => [chunk.id, details[position]]));
    return index.chunks.flatMap((chunk) => loaded.get(chunk.id)?.samples ?? chunk.overview);
  }, [index.chunks, visibleChunks, details]);

  return {
    index,
    axis,
    aggregates,
    overview,
    sessionAggregates,
    toolSpans,
    pendingChunks: pending,
    failedChunks: failed,
  };
}
