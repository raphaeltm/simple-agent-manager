import { describe, expect, it } from 'vitest';

import {
  chunkDetailFromApi,
  indexFromApi,
  sampleToAggregate,
  withToolStarts,
} from '../../../../src/components/chat/resource-timeline/resource-source';
import type { ResourceToolSpan } from '../../../../src/components/chat/resource-timeline/types';
import type {
  ResourceTimelineChunkEntry,
  ResourceTimelineIndexResponse,
  ResourceTimelineRollup,
  ResourceTimelineRunEntry,
} from '../../../../src/lib/api';

const T0 = Date.UTC(2026, 8, 28, 19, 0, 0);
const MINUTE = 60_000;

function chunk(
  id: string,
  workspaceId: string,
  startedAt: number,
  overrides: Partial<ResourceTimelineChunkEntry> = {}
): ResourceTimelineChunkEntry {
  return {
    id,
    workspaceId,
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
      memoryWorkingSetMeanBytes: 6e8,
      memoryWorkingSetPeakBytes: 9e8,
      ioReadBytes: 10,
      ioWriteBytes: 20,
      oomCount: 0,
    },
    rollup: null,
    ...overrides,
  };
}

function run(
  workspaceId: string,
  startedAt: number,
  endedAt: number,
  reservation: ResourceTimelineRunEntry['reservation'] = null
): ResourceTimelineRunEntry {
  return {
    workspaceId,
    nodeId: `node-of-${workspaceId}`,
    runtime: 'vm',
    startedAt,
    endedAt,
    reservation,
  };
}

function response(
  chunks: ResourceTimelineChunkEntry[],
  runs: ResourceTimelineRunEntry[],
  overrides: Partial<ResourceTimelineIndexResponse> = {}
): ResourceTimelineIndexResponse {
  return {
    sessionId: 'session-1',
    runs,
    chunks,
    totalChunkCount: chunks.length,
    omittedChunkCount: 0,
    maxChunks: 1000,
    collection: chunks.length ? 'collected' : 'pending',
    runtime: 'vm',
    ...overrides,
  };
}

function rollup(start: number, minutes: number): ResourceTimelineRollup {
  const buckets = Array.from({ length: minutes }, (_, i) => i);
  return {
    v: 1,
    bucketMs: MINUTE,
    start: buckets.map((i) => start + i * MINUTE),
    end: buckets.map((i) => start + (i + 1) * MINUTE),
    samples: buckets.map(() => 12),
    cpuMeanCores: buckets.map((i) => i / 10),
    cpuMaxCores: buckets.map((i) => i / 5),
    memoryMeanBytes: buckets.map(() => 1e9),
    memoryMaxBytes: buckets.map(() => 1.5e9),
    workingSetMeanBytes: buckets.map(() => null),
    workingSetMaxBytes: buckets.map(() => null),
    ioReadBytes: buckets.map(() => 100),
    ioWriteBytes: buckets.map(() => 200),
    oomKills: buckets.map((i) => (i === 2 ? 1 : 0)),
    toolCallStarts: buckets.map((i) => i),
  };
}

describe('sampleToAggregate', () => {
  it('turns CPU milliseconds per interval into cores and keeps disk bytes', () => {
    const aggregate = sampleToAggregate({
      t: T0,
      intervalMillis: 5000,
      cpuMillis: 2500,
      memoryBytes: 1e9,
      ioReadBytes: 7,
      ioWriteBytes: 9,
    });

    expect(aggregate).toMatchObject({
      start: T0 - 5000,
      end: T0,
      cpuMeanCores: 0.5,
      cpuMaxCores: 0.5,
      ioReadBytes: 7,
      ioWriteBytes: 9,
      exact: true,
    });
  });

  it('has no CPU or disk reading for the first sample of a run, which has no interval yet', () => {
    const aggregate = sampleToAggregate({ t: T0, memoryBytes: 1e9 });

    expect(aggregate.cpuMeanCores).toBeNull();
    expect(aggregate.ioReadBytes).toBeNull();
    expect(aggregate.memoryMeanBytes).toBe(1e9);
  });

  it('drops the memory reading of a sample the collector could not observe', () => {
    const aggregate = sampleToAggregate({
      t: T0,
      intervalMillis: 5000,
      memoryBytes: 0,
      unsupported: 'no running devcontainer found',
    });
    expect(aggregate.memoryMeanBytes).toBeNull();
    expect(aggregate.cpuMeanCores).toBeNull();
  });
});

describe('withToolStarts', () => {
  const samples = [0, 1, 2].map((i) =>
    sampleToAggregate({ t: T0 + (i + 1) * 5000, intervalMillis: 5000, cpuMillis: 0 })
  );
  const span = (startedAt: number): ResourceToolSpan => ({
    id: `s${startedAt}`,
    kind: 'read',
    name: 'Read',
    startedAt,
    endedAt: startedAt + 10,
    approximateEnd: false,
  });

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
  it('orders chunks oldest first and carries each run with its own reservation', () => {
    const index = indexFromApi(
      response(
        [
          chunk('c3', 'ws-2', T0 + 60 * MINUTE),
          chunk('c2', 'ws-1', T0 + 15 * MINUTE),
          chunk('c1', 'ws-1', T0),
        ],
        [
          run('ws-2', T0 + 60 * MINUTE, T0 + 75 * MINUTE, { cpuMillis: 4000, memoryMb: 8192 }),
          run('ws-1', T0, T0 + 30 * MINUTE, { cpuMillis: 2000, memoryMb: 4096 }),
        ]
      )
    );

    expect(index.chunks.map((ref) => ref.id)).toEqual(['c1', 'c2', 'c3']);
    expect(index.runs).toEqual([
      {
        id: 'ws-1',
        nodeId: 'node-of-ws-1',
        startedAt: T0,
        endedAt: T0 + 30 * MINUTE,
        unsupportedReason: null,
        reservation: { cpuCores: 2, memoryBytes: 4096 * 1024 ** 2 },
      },
      {
        id: 'ws-2',
        nodeId: 'node-of-ws-2',
        startedAt: T0 + 60 * MINUTE,
        endedAt: T0 + 75 * MINUTE,
        unsupportedReason: null,
        reservation: { cpuCores: 4, memoryBytes: 8192 * 1024 ** 2 },
      },
    ]);
    expect(index.collection).toBe('collected');
  });

  it('draws a chunk from its per-minute rollup when the server stored one', () => {
    const index = indexFromApi(
      response(
        [chunk('c1', 'ws-1', T0, { rollup: rollup(T0, 15) })],
        [run('ws-1', T0, T0 + 15 * MINUTE)]
      )
    );
    const overview = index.chunks[0]?.overview ?? [];

    expect(overview).toHaveLength(15);
    expect(overview[3]).toMatchObject({
      start: T0 + 3 * MINUTE,
      end: T0 + 4 * MINUTE,
      cpuMeanCores: 0.3,
      cpuMaxCores: 0.6,
      memoryMaxBytes: 1.5e9,
      toolCallStarts: 3,
      exact: false,
    });
    expect(overview[2]?.oomKills).toBe(1);
  });

  it('falls back to the chunk summary, in cores and with the working set, for chunks without a rollup', () => {
    const index = indexFromApi(
      response([chunk('c1', 'ws-1', T0)], [run('ws-1', T0, T0 + 15 * MINUTE)])
    );
    const [overview] = index.chunks[0]?.overview ?? [];

    expect(index.chunks[0]?.overview).toHaveLength(1);
    expect(overview).toMatchObject({
      cpuMeanCores: 0.5,
      cpuMaxCores: 3,
      memoryMaxBytes: 2e9,
      workingSetMeanBytes: 6e8,
      workingSetMaxBytes: 9e8,
      toolCallStarts: 12,
      exact: false,
    });
    expect(index.chunks[0]?.memoryHighWaterBytes).toBe(2.2e9);
  });

  it('discloses how many older chunks the server left out, and reports complete otherwise', () => {
    const chunks = [chunk('c1', 'ws-1', T0)];
    const runs = [run('ws-1', T0, T0 + 15 * MINUTE)];
    expect(indexFromApi(response(chunks, runs, { omittedChunkCount: 42 })).completeness).toEqual({
      kind: 'truncated',
      omitted: 42,
    });
    expect(indexFromApi(response(chunks, runs)).completeness).toEqual({ kind: 'complete' });
  });

  it('passes through whether an empty session records history at all', () => {
    expect(
      indexFromApi(response([], [], { collection: 'unsupported', runtime: 'cf-container' }))
        .collection
    ).toBe('unsupported');
    expect(indexFromApi(response([], [])).collection).toBe('pending');
  });

  it('carries the reason a run could not be observed, and treats a missing reservation as unknown', () => {
    const index = indexFromApi(
      response(
        [
          chunk('c1', 'ws-1', T0, {
            completeness: { status: 'partial', unsupported: 'no running devcontainer found' },
          }),
        ],
        [run('ws-1', T0, T0 + 15 * MINUTE)]
      )
    );
    expect(index.runs[0]?.unsupportedReason).toBe('no running devcontainer found');
    expect(index.runs[0]?.reservation).toBeNull();
  });
});

describe('chunkDetailFromApi', () => {
  it('maps tool labels when present and falls back for spans from older agents', () => {
    // VM agents that predate tool labels report every span as `acp_tool_call` with no name.
    const labelled = {
      id: 'b',
      kind: 'execute',
      startedAt: T0 + 3000,
      endedAt: T0 + 4000,
      toolName: 'Bash',
    };
    const detail = chunkDetailFromApi('c1', {
      chunkId: 'c1',
      samples: [{ t: T0 + 5000, intervalMillis: 5000, cpuMillis: 5000 }],
      toolSpans: [
        { id: 'a', kind: 'acp_tool_call', startedAt: T0 + 1000, endedAt: T0 + 2000 },
        labelled,
      ],
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

describe('chunkDetailFromApi with server-thinned samples', () => {
  const detail = (downsampled: boolean) =>
    chunkDetailFromApi('c1', {
      chunkId: 'c1',
      samples: [
        { t: T0 + 5_000, intervalMillis: 5000, cpuMillis: 5000 },
        { t: T0 + 30_000, intervalMillis: 5000, cpuMillis: 5000 },
        { t: T0 + 90_000, intervalMillis: 5000, cpuMillis: 5000, gap: true },
      ],
      toolSpans: [],
      gaps: [],
      originalSampleCount: 18,
      downsampled,
      downsampleLimit: 3,
    });

  it('stretches each kept sample back to the previous one, but never across a sampler gap', () => {
    const samples = detail(true).samples;
    expect(samples.map((sample) => [sample.start - T0, sample.end - T0])).toEqual([
      [0, 5_000],
      [5_000, 30_000],
      [85_000, 90_000],
    ]);
    expect(samples.map((sample) => sample.exact)).toEqual([true, false, true]);
  });

  it('leaves full-resolution samples on their own intervals', () => {
    expect(detail(false).samples.map((sample) => sample.start - T0)).toEqual([0, 25_000, 85_000]);
  });
});
