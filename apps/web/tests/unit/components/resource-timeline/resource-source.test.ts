import { describe, expect, it } from 'vitest';

import {
  chunkDetailFromApi,
  indexFromApi,
  sampleToAggregate,
  withToolStarts,
} from '../../../../src/components/chat/resource-timeline/resource-source';
import type { ResourceToolSpan } from '../../../../src/components/chat/resource-timeline/types';
import type {
  WorkspaceResourceChunk,
  WorkspaceResourceHistoryResponse,
  WorkspaceResourceSummary,
} from '../../../../src/lib/api';

const T0 = Date.UTC(2026, 8, 28, 19, 0, 0);
const MINUTE = 60_000;

function chunk(id: string, workspaceId: string, startedAt: number, overrides: Partial<WorkspaceResourceChunk> = {}): WorkspaceResourceChunk {
  return {
    id,
    workspaceId,
    sessionId: 'session-1',
    taskId: null,
    nodeId: `node-of-${workspaceId}`,
    chunkSequence: 1,
    sourceVersion: 1,
    storageFormat: 'resource-history-gzip-json-v1',
    compressedBytes: 1000,
    uncompressedBytes: 9000,
    sha256: 'abc',
    startedAt,
    endedAt: startedAt + 15 * MINUTE,
    sampleCount: 180,
    gapCount: 0,
    toolSpanCount: 12,
    completeness: { status: 'complete', unsupported: '' },
    summary: {
      sampleIntervalMillis: 5000,
      cpuMeanMillis: 2500,
      cpuPeakMillis: 15000,
      memoryMeanBytes: 1e9,
      memoryPeakBytes: 2e9,
      memoryKernelPeakBytes: 2.2e9,
      ioReadBytes: 10,
      ioWriteBytes: 20,
      oomCount: 0,
    },
    expiresAt: startedAt + 90 * 24 * 60 * MINUTE,
    ...overrides,
  };
}

function response(chunks: WorkspaceResourceChunk[], firstChunkId: string | null): WorkspaceResourceHistoryResponse {
  const summary = { firstChunkId, summary: { sampleIntervalMillis: 5000 } } as unknown as WorkspaceResourceSummary;
  return { summary, chunks };
}

describe('sampleToAggregate', () => {
  it('turns CPU milliseconds per interval into cores and keeps disk bytes', () => {
    const aggregate = sampleToAggregate({ t: T0, intervalMillis: 5000, cpuMillis: 2500, memoryBytes: 1e9, ioReadBytes: 7, ioWriteBytes: 9 });

    expect(aggregate).toMatchObject({ start: T0 - 5000, end: T0, cpuMeanCores: 0.5, cpuMaxCores: 0.5, ioReadBytes: 7, ioWriteBytes: 9, exact: true });
  });

  it('has no CPU or disk reading for the first sample of a run, which has no interval yet', () => {
    const aggregate = sampleToAggregate({ t: T0, memoryBytes: 1e9 });

    expect(aggregate.cpuMeanCores).toBeNull();
    expect(aggregate.ioReadBytes).toBeNull();
    expect(aggregate.memoryMeanBytes).toBe(1e9);
  });

  it('drops the memory reading of a sample the collector could not observe', () => {
    const aggregate = sampleToAggregate({ t: T0, intervalMillis: 5000, memoryBytes: 0, unsupported: 'no running devcontainer found' });
    expect(aggregate.memoryMeanBytes).toBeNull();
    expect(aggregate.cpuMeanCores).toBeNull();
  });
});

describe('withToolStarts', () => {
  const samples = [0, 1, 2].map((i) => sampleToAggregate({ t: T0 + (i + 1) * 5000, intervalMillis: 5000, cpuMillis: 0 }));
  const span = (startedAt: number): ResourceToolSpan => ({ id: `s${startedAt}`, kind: 'read', name: 'Read', startedAt, endedAt: startedAt + 10, approximateEnd: false });

  it('counts each call on the sample whose interval saw it start', () => {
    const counted = withToolStarts(samples, [span(T0 + 1000), span(T0 + 6000), span(T0 + 7000)]);
    expect(counted.map((sample) => sample.toolCallStarts)).toEqual([1, 2, 0]);
  });

  it('counts a call that started before the chunk on its first sample', () => {
    const counted = withToolStarts(samples, [span(T0 - 60_000)]);
    expect(counted.map((sample) => sample.toolCallStarts)).toEqual([1, 0, 0]);
  });
});

describe('indexFromApi', () => {
  it('orders chunks oldest first and groups them into one run per workspace', () => {
    const index = indexFromApi(
      response([chunk('c3', 'ws-2', T0 + 60 * MINUTE), chunk('c2', 'ws-1', T0 + 15 * MINUTE), chunk('c1', 'ws-1', T0)], 'c3')
    );

    expect(index.chunks.map((ref) => ref.id)).toEqual(['c1', 'c2', 'c3']);
    expect(index.runs).toEqual([
      { id: 'ws-1', nodeId: 'node-of-ws-1', startedAt: T0, endedAt: T0 + 30 * MINUTE, unsupportedReason: null },
      { id: 'ws-2', nodeId: 'node-of-ws-2', startedAt: T0 + 60 * MINUTE, endedAt: T0 + 75 * MINUTE, unsupportedReason: null },
    ]);
  });

  it('reads the per-chunk summary as one coarse aggregate in cores', () => {
    const index = indexFromApi(response([chunk('c1', 'ws-1', T0)], 'c1'));
    const [overview] = index.chunks[0]?.overview ?? [];

    expect(overview).toMatchObject({ cpuMeanCores: 0.5, cpuMaxCores: 3, memoryMaxBytes: 2e9, toolCallStarts: 12, exact: false });
    expect(index.chunks[0]?.memoryHighWaterBytes).toBe(2.2e9);
  });

  it('reports truncated history when the newest workspace lost its own first chunk from the page', () => {
    const truncated = indexFromApi(response([chunk('c9', 'ws-1', T0)], 'c1'));
    const complete = indexFromApi(response([chunk('c1', 'ws-1', T0)], 'c1'));

    expect(truncated.completeness).toEqual({ kind: 'truncated', omitted: null });
    expect(complete.completeness).toEqual({ kind: 'complete' });
  });

  it('carries the reason a run could not be observed', () => {
    const index = indexFromApi(
      response([chunk('c1', 'ws-1', T0, { completeness: { status: 'partial', unsupported: 'no running devcontainer found' } })], 'c1')
    );
    expect(index.runs[0]?.unsupportedReason).toBe('no running devcontainer found');
  });
});

describe('chunkDetailFromApi', () => {
  it('maps tool labels when present and falls back for spans from older agents', () => {
    // Newer VM agents add `toolName`; the web type predates it, which is why the adapter reads it defensively.
    const labelled = { id: 'b', kind: 'execute', startedAt: T0 + 3000, endedAt: T0 + 4000, toolName: 'Bash' };
    const detail = chunkDetailFromApi('c1', {
      chunkId: 'c1',
      samples: [{ t: T0 + 5000, intervalMillis: 5000, cpuMillis: 5000 }],
      toolSpans: [{ id: 'a', kind: 'acp_tool_call', startedAt: T0 + 1000, endedAt: T0 + 2000 }, labelled],
      gaps: [{ startedAt: T0, endedAt: T0 + 40_000, reason: 'sampler_delay' }],
      originalSampleCount: 1,
      downsampled: false,
      downsampleLimit: 720,
    });

    expect(detail.toolSpans.map((span) => [span.kind, span.name])).toEqual([
      ['other', null],
      ['execute', 'Bash'],
    ]);
    expect(detail.samples[0]?.toolCallStarts).toBe(2);
    expect(detail.samplerGaps).toEqual([{ start: T0, end: T0 + 40_000 }]);
  });
});
