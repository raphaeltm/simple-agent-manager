/**
 * Domain model for the session resource timeline.
 *
 * Storage splits a session's history into immutable 15-minute chunks. That is a
 * storage detail: nothing here exposes a chunk to the user. The UI sees one
 * continuous timeline made of *runs* (one per workspace lifetime — every wake
 * provisions a fresh workspace) separated by the gaps where the session slept.
 */

/** ACP tool-call kinds, plus `other` for anything an agent reports that we do not know. */
export type ToolKind = 'execute' | 'edit' | 'read' | 'search' | 'fetch' | 'think' | 'other';

/**
 * Resource usage over a closed time window `[start, end)`.
 *
 * One shape serves every level of detail: a raw 5-second sample is an aggregate
 * over its own sampling interval, and an overview bucket is an aggregate over a
 * minute or a whole chunk. `exact` records which one it is so the UI can say
 * whether a number is a measurement or an average.
 */
export interface ResourceAggregate {
  start: number;
  end: number;
  /** CPU in cores (1 = one core fully busy). */
  cpuMeanCores: number | null;
  cpuMaxCores: number | null;
  /** cgroup `memory.current`: everything the workspace holds, including reclaimable cache. */
  memoryMeanBytes: number | null;
  memoryMaxBytes: number | null;
  /** Non-reclaimable working set; null when the VM agent does not report it. */
  workingSetMeanBytes: number | null;
  workingSetMaxBytes: number | null;
  /** Bytes moved during the window (not rates). */
  ioReadBytes: number | null;
  ioWriteBytes: number | null;
  oomKills: number;
  /** Tool calls that started inside the window. */
  toolCallStarts: number;
  exact: boolean;
}

/** One workspace lifetime inside the session. */
export interface ResourceRun {
  /** The workspace id — stable, and what storage keys the run by. */
  id: string;
  nodeId: string | null;
  startedAt: number;
  endedAt: number;
  /** Why the collector could not observe this run (for example the container never started). */
  unsupportedReason: string | null;
}

/** A stored chunk, described well enough to draw an overview without downloading it. */
export interface ResourceChunkRef {
  id: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  /**
   * Coarse usage for this chunk. When the backend stores per-minute rollups this
   * holds one aggregate per minute; otherwise a single aggregate spans the chunk.
   */
  overview: ResourceAggregate[];
  /** Kernel-tracked memory high-water mark (`memory.peak`) — catches spikes between samples. */
  memoryHighWaterBytes: number | null;
}

export type HistoryCompleteness =
  | { kind: 'complete' }
  /** The backend returned only the newest chunks; `omitted` is null when it did not say how many. */
  | { kind: 'truncated'; omitted: number | null };

export interface ResourceReservation {
  cpuCores: number | null;
  memoryBytes: number | null;
}

/** Everything needed to draw the whole session before any chunk is downloaded. */
export interface ResourceTimelineIndex {
  runs: ResourceRun[];
  /** Ascending by `startedAt`. */
  chunks: ResourceChunkRef[];
  sampleIntervalMs: number;
  /** How often the VM uploads a chunk — data is never newer than one upload interval. */
  uploadIntervalMs: number;
  completeness: HistoryCompleteness;
  /** What the workspace reserved, when known; usage is judged against this. */
  reservation: ResourceReservation | null;
}

export interface ResourceToolSpan {
  id: string;
  kind: ToolKind;
  /** e.g. `Bash`. Null for spans recorded by VM agents that predate tool labels. */
  name: string | null;
  startedAt: number;
  endedAt: number;
  /** The call never reported completion; the end is when the collector gave up on it. */
  approximateEnd: boolean;
}

/** One downloaded chunk at full 5-second resolution. */
export interface ResourceChunkDetail {
  chunkId: string;
  samples: ResourceAggregate[];
  toolSpans: ResourceToolSpan[];
  /** Instants where the sampler fell behind and no data exists. */
  samplerGaps: Array<{ start: number; end: number }>;
}
