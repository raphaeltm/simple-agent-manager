import { request } from './client';

/** One raw 5-second cgroup sample, as the VM agent records it. */
export interface WorkspaceResourceSample {
  t: number;
  intervalMillis?: number;
  cpuMillis?: number;
  memoryBytes?: number;
  memoryPeakBytes?: number;
  /** Non-reclaimable working set; absent on VM agents that predate it. */
  memoryWorkingSetBytes?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  oom?: number;
  oomKill?: number;
  pidsCurrent?: number;
  counterReset?: boolean;
  unsupported?: string;
  gap?: boolean;
}

export interface WorkspaceResourceToolSpan {
  id: string;
  /** ACP tool-call kind (`execute`, `edit`, ...); `acp_tool_call` on VM agents that predate tool labels. */
  kind: string;
  toolName?: string;
  startedAt: number;
  endedAt?: number;
  concurrency?: number;
  approximate?: boolean;
}

/** Columnar per-minute rollup stored for each chunk; every array has one entry per bucket. */
export interface ResourceTimelineRollup {
  v: 1;
  bucketMs: number;
  start: number[];
  end: number[];
  samples: number[];
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

export interface ResourceTimelineChunkEntry {
  id: string;
  workspaceId: string;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  gapCount: number;
  toolSpanCount: number;
  summary: unknown;
  completeness: unknown;
  /** Null for chunks uploaded before rollups existed; draw them from `summary`. */
  rollup: ResourceTimelineRollup | null;
}

export interface ResourceTimelineRunEntry {
  workspaceId: string;
  nodeId: string | null;
  runtime: string | null;
  startedAt: number;
  endedAt: number;
  reservation: { cpuMillis: number; memoryMb: number } | null;
}

export interface ResourceTimelineIndexResponse {
  sessionId: string;
  runs: ResourceTimelineRunEntry[];
  /** Ascending by `startedAt`. */
  chunks: ResourceTimelineChunkEntry[];
  totalChunkCount: number;
  omittedChunkCount: number;
  maxChunks: number;
  collection: 'collected' | 'pending' | 'unsupported' | 'expired';
  runtime: string | null;
}

export interface ResourceTimelineChunkResponse {
  chunkId: string;
  samples: WorkspaceResourceSample[];
  toolSpans: WorkspaceResourceToolSpan[];
  gaps: Array<Record<string, unknown>>;
  originalSampleCount: number;
  downsampled: boolean;
  downsampleLimit: number;
}

export async function getSessionResourceTimeline(
  projectId: string,
  sessionId: string
): Promise<ResourceTimelineIndexResponse> {
  return request<ResourceTimelineIndexResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/resource-timeline`
  );
}

export async function getSessionResourceTimelineChunk(
  projectId: string,
  sessionId: string,
  chunkId: string
): Promise<ResourceTimelineChunkResponse> {
  return request<ResourceTimelineChunkResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/resource-timeline/chunks/${encodeURIComponent(chunkId)}`
  );
}
