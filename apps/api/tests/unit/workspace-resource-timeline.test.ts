import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  storeWorkspaceResourceChunk,
  type WorkspaceResourceUploadBody,
} from '../../src/services/workspace-resource-history';
import {
  computeWorkspaceResourceRollup,
  parseWorkspaceResourceRollup,
} from '../../src/services/workspace-resource-rollup';
import {
  getSessionResourceTimeline,
  getSessionResourceTimelineChunk,
} from '../../src/services/workspace-resource-timeline';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const MINUTE = 60_000;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % (15 * MINUTE));
const CONFIG = { bucketMs: MINUTE, maxBuckets: 60 };
const RESERVATION = {
  cpuMillis: 2_000,
  memoryMb: 4_096,
  diskMb: 40_960,
  exclusiveNode: false,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function makeR2(): R2Bucket {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key: string, value: Uint8Array) => {
      objects.set(key, value);
      return null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    get: async (key: string) => {
      const value = objects.get(key);
      if (!value) return null;
      return {
        arrayBuffer: async () =>
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      };
    },
  } as unknown as R2Bucket;
}

/** Twelve 5-second samples per minute across a 15-minute chunk. */
function chunkPayload(start: number, cpuMillis = 2_500) {
  const samples = Array.from({ length: 180 }, (_, index) => ({
    t: start + (index + 1) * 5_000,
    intervalMillis: 5_000,
    cpuMillis,
    memoryBytes: 1_000_000 + index,
    ioReadBytes: 10,
    ioWriteBytes: 20,
  }));
  return {
    samples,
    toolSpans: [{ id: 'span-1', kind: 'execute', toolName: 'Bash', startedAt: start + 90_000 }],
  };
}

async function upload(
  env: Env,
  input: {
    projectId: string;
    workspaceId: string;
    sessionId: string;
    sequence: number;
    start: number;
  }
) {
  const payload = chunkPayload(input.start);
  const json = JSON.stringify(payload);
  const compressed = await gzipJson(payload);
  const body: WorkspaceResourceUploadBody = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sourceVersion: 1,
    chunkSequence: input.sequence,
    startedAt: input.start,
    endedAt: input.start + 15 * MINUTE,
    sampleCount: payload.samples.length,
    toolSpanCount: 1,
    compressedBase64: base64(compressed),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: new TextEncoder().encode(json).byteLength,
    sha256: await sha256Hex(compressed),
    completeness: { status: 'complete' },
    summary: { cpuMeanMillis: 2_500, cpuPeakMillis: 2_500, sampleIntervalMillis: 5_000 },
  };
  return storeWorkspaceResourceChunk(env, input.projectId, body, null);
}

function setup(envOverrides: Record<string, string> = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.nodes,
    schema.workspaces,
    schema.workspaceResourceSummaries,
    schema.workspaceResourceChunks,
  ]);
  const env = {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA_ARCHIVE_R2: makeR2(),
    ...envOverrides,
  } as unknown as Env;
  const addNode = (id: string, runtime: string) =>
    sqlite.prepare(`INSERT INTO nodes (id, runtime) VALUES (?, ?)`).run(id, runtime);
  const addWorkspace = (
    id: string,
    projectId: string,
    nodeId: string,
    sessionId: string | null,
    reservation: string | null = null,
    createdAt = '2026-09-29T00:00:00Z'
  ) =>
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id, resolved_reservation_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, projectId, nodeId, sessionId, reservation, createdAt);
  return { sqlite, env, addNode, addWorkspace };
}

describe('computeWorkspaceResourceRollup', () => {
  it('buckets samples per minute with CPU in cores, memory mean/max and summed I/O', () => {
    const rollup = computeWorkspaceResourceRollup(
      chunkPayload(T0),
      { startedAt: T0, endedAt: T0 + 15 * MINUTE },
      CONFIG
    );

    expect(rollup.bucketMs).toBe(MINUTE);
    expect(rollup.start).toHaveLength(15);
    expect(rollup.start[0]).toBe(T0);
    expect(rollup.end.at(-1)).toBe(T0 + 15 * MINUTE);
    // 2 500 ms of CPU in a 5 000 ms interval is half a core.
    expect(rollup.cpuMeanCores[0]).toBeCloseTo(0.5);
    expect(rollup.cpuMaxCores[0]).toBeCloseTo(0.5);
    expect(rollup.memoryMaxBytes[0]).toBeGreaterThanOrEqual(rollup.memoryMeanBytes[0] ?? Infinity);
    // A sample stamped T0+60s closes the first minute, so every minute holds exactly twelve.
    expect(rollup.samples).toEqual(Array.from({ length: 15 }, () => 12));
    expect(rollup.ioReadBytes.reduce<number>((a, b) => a + (b ?? 0), 0)).toBe(1_800);
    expect(rollup.toolCallStarts[1]).toBe(1);
    expect(rollup.workingSetMeanBytes.every((value) => value === null)).toBe(true);
  });

  it('skips gap and unsupported samples, reads working set and memory.peak, and counts OOM kills', () => {
    const rollup = computeWorkspaceResourceRollup(
      {
        samples: [
          {
            t: T0 + 5_000,
            intervalMillis: 5_000,
            cpuMillis: 5_000,
            memoryBytes: 100,
            memoryWorkingSetBytes: 60,
          },
          { t: T0 + 10_000, gap: true, cpuMillis: 99_999, memoryBytes: 99_999 },
          { t: T0 + 15_000, unsupported: 'no cgroup', memoryBytes: 99_999 },
          {
            t: T0 + 20_000,
            intervalMillis: 5_000,
            cpuMillis: 0,
            memoryBytes: 300,
            memoryPeakBytes: 900,
            memoryWorkingSetBytes: 80,
            oom: 1,
            oomKill: 1,
          },
        ],
      },
      { startedAt: T0, endedAt: T0 + MINUTE },
      CONFIG
    );

    expect(rollup.samples).toEqual([2]);
    expect(rollup.cpuMeanCores[0]).toBeCloseTo(0.5);
    expect(rollup.cpuMaxCores[0]).toBeCloseTo(1);
    expect(rollup.memoryMeanBytes).toEqual([200]);
    expect(rollup.memoryMaxBytes).toEqual([900]);
    expect(rollup.workingSetMeanBytes).toEqual([70]);
    expect(rollup.workingSetMaxBytes).toEqual([80]);
    expect(rollup.oomKills).toEqual([2]);
  });

  it('widens the bucket so a long or malformed window stays within the configured bucket count', () => {
    const day = 24 * 60 * MINUTE;
    const samples = Array.from({ length: 2_000 }, (_, index) => ({
      t: T0 + index * 43_000,
      intervalMillis: 5_000,
      cpuMillis: 100,
    }));
    const rollup = computeWorkspaceResourceRollup(
      { samples: [...samples, { t: T0 + 50 * day, intervalMillis: 5_000, cpuMillis: 1 }] },
      { startedAt: T0, endedAt: T0 + day },
      { bucketMs: MINUTE, maxBuckets: 10 }
    );

    expect(rollup.start.length).toBeLessThanOrEqual(11);
    expect(rollup.bucketMs % MINUTE).toBe(0);
    expect(rollup.end.at(-1)).toBeLessThanOrEqual(T0 + day);
  });

  it('round-trips through JSON and rejects malformed stored rollups', () => {
    const rollup = computeWorkspaceResourceRollup(
      chunkPayload(T0),
      { startedAt: T0, endedAt: T0 + 15 * MINUTE },
      CONFIG
    );
    expect(parseWorkspaceResourceRollup(JSON.stringify(rollup))).toEqual(rollup);
    expect(parseWorkspaceResourceRollup(null)).toBeNull();
    expect(parseWorkspaceResourceRollup('{not json')).toBeNull();
    expect(parseWorkspaceResourceRollup(JSON.stringify({ ...rollup, v: 99 }))).toBeNull();
    expect(
      parseWorkspaceResourceRollup(JSON.stringify({ ...rollup, cpuMeanCores: [1] }))
    ).toBeNull();
    expect(
      parseWorkspaceResourceRollup(
        JSON.stringify({ ...rollup, samples: rollup.samples.map(() => 'x') })
      )
    ).toBeNull();
  });
});

describe('session resource timeline', () => {
  it('stores a rollup on upload and serves every chunk of a multi-wake session in order', async () => {
    const { env, addNode, addWorkspace } = setup();
    addNode('node-a', 'vm');
    addNode('node-b', 'vm');
    addWorkspace('ws-wake-1', 'proj-1', 'node-a', null, JSON.stringify(RESERVATION));
    addWorkspace('ws-wake-2', 'proj-1', 'node-b', 'sess-1', null);
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-wake-1',
      sessionId: 'sess-1',
      sequence: 0,
      start: T0,
    });
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-wake-1',
      sessionId: 'sess-1',
      sequence: 1,
      start: T0 + 15 * MINUTE,
    });
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-wake-2',
      sessionId: 'sess-1',
      sequence: 0,
      start: T0 + 10 * 60 * MINUTE,
    });

    const timeline = await getSessionResourceTimeline(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(timeline.collection).toBe('collected');
    expect(timeline.chunks.map((chunk) => chunk.startedAt)).toEqual([
      T0,
      T0 + 15 * MINUTE,
      T0 + 10 * 60 * MINUTE,
    ]);
    expect(timeline.totalChunkCount).toBe(3);
    expect(timeline.omittedChunkCount).toBe(0);
    expect(timeline.chunks.every((chunk) => chunk.rollup?.start.length === 15)).toBe(true);
    expect(timeline.runs.map((run) => [run.workspaceId, run.startedAt, run.endedAt])).toEqual([
      ['ws-wake-1', T0, T0 + 30 * MINUTE],
      ['ws-wake-2', T0 + 10 * 60 * MINUTE, T0 + 10 * 60 * MINUTE + 15 * MINUTE],
    ]);
    expect(timeline.runs[0]?.reservation).toEqual({ cpuMillis: 2_000, memoryMb: 4_096 });
    expect(timeline.runs[1]?.reservation).toBeNull();
    expect(timeline.runtime).toBe('vm');
  });

  it('excludes another project and another session (attack) while serving the owner (control)', async () => {
    const { sqlite, env, addNode, addWorkspace } = setup();
    addNode('node-a', 'vm');
    addWorkspace('ws-owner', 'proj-1', 'node-a', 'sess-1');
    addWorkspace('ws-foreign', 'proj-2', 'node-a', 'sess-1');
    addWorkspace('ws-other-session', 'proj-1', 'node-a', 'sess-2');
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-owner',
      sessionId: 'sess-1',
      sequence: 0,
      start: T0,
    });
    await upload(env, {
      projectId: 'proj-2',
      workspaceId: 'ws-foreign',
      sessionId: 'sess-1',
      sequence: 0,
      start: T0,
    });
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-other-session',
      sessionId: 'sess-2',
      sequence: 0,
      start: T0,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_resource_chunks').get()).toEqual({
      n: 3,
    });

    const timeline = await getSessionResourceTimeline(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(timeline.chunks.map((chunk) => chunk.workspaceId)).toEqual(['ws-owner']);
    expect(timeline.runs.map((run) => run.workspaceId)).toEqual(['ws-owner']);
  });

  it('keeps the newest chunks past the cap and discloses how many older ones were left out', async () => {
    const { env, addNode, addWorkspace } = setup({ WORKSPACE_RESOURCE_TIMELINE_MAX_CHUNKS: '2' });
    addNode('node-a', 'vm');
    addWorkspace('ws-1', 'proj-1', 'node-a', 'sess-1');
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await upload(env, {
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        sequence,
        start: T0 + sequence * 15 * MINUTE,
      });
    }

    const timeline = await getSessionResourceTimeline(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(timeline.maxChunks).toBe(2);
    expect(timeline.totalChunkCount).toBe(3);
    expect(timeline.omittedChunkCount).toBe(1);
    expect(timeline.chunks.map((chunk) => chunk.startedAt)).toEqual([
      T0 + 15 * MINUTE,
      T0 + 30 * MINUTE,
    ]);
  });

  it('tolerates a malformed rollup and a malformed reservation without failing the index', async () => {
    const { sqlite, env, addNode, addWorkspace } = setup();
    addNode('node-a', 'vm');
    addWorkspace('ws-1', 'proj-1', 'node-a', 'sess-1', '{"source":"nope"}');
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      sequence: 0,
      start: T0,
    });
    await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      sequence: 1,
      start: T0 + 15 * MINUTE,
    });
    sqlite
      .prepare(
        `UPDATE workspace_resource_chunks SET rollup_json = '{broken' WHERE chunk_sequence = 0`
      )
      .run();

    const timeline = await getSessionResourceTimeline(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(timeline.chunks).toHaveLength(2);
    expect(timeline.chunks[0]?.rollup).toBeNull();
    expect(timeline.chunks[0]?.summary).toMatchObject({ cpuMeanMillis: 2_500 });
    expect(timeline.chunks[1]?.rollup).not.toBeNull();
    expect(timeline.runs[0]?.reservation).toBeNull();
  });

  it('explains an empty timeline: Instant sessions are unsupported, VM sessions are pending', async () => {
    const { env, addNode, addWorkspace } = setup();
    addNode('node-container', 'cf-container');
    addNode('node-vm', 'vm');
    addWorkspace('ws-instant', 'proj-1', 'node-container', 'sess-instant');
    addWorkspace('ws-vm', 'proj-1', 'node-vm', 'sess-vm');
    // Same session id in another project must not decide this project's answer.
    addWorkspace('ws-foreign', 'proj-2', 'node-container', 'sess-vm', null, '2026-09-30T00:00:00Z');

    const instant = await getSessionResourceTimeline(env, {
      projectId: 'proj-1',
      sessionId: 'sess-instant',
    });
    const vm = await getSessionResourceTimeline(env, { projectId: 'proj-1', sessionId: 'sess-vm' });
    const unknown = await getSessionResourceTimeline(env, {
      projectId: 'proj-1',
      sessionId: 'sess-none',
    });

    expect(instant).toMatchObject({
      collection: 'unsupported',
      runtime: 'cf-container',
      chunks: [],
    });
    expect(vm).toMatchObject({ collection: 'pending', runtime: 'vm', chunks: [] });
    expect(unknown).toMatchObject({ collection: 'pending', runtime: null });
  });

  it('reads a chunk only through its own project and session', async () => {
    const { env, addNode, addWorkspace } = setup();
    addNode('node-a', 'vm');
    addWorkspace('ws-1', 'proj-1', 'node-a', 'sess-1');
    const { chunkId } = await upload(env, {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      sequence: 0,
      start: T0,
    });

    const owner = await getSessionResourceTimelineChunk(env, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      chunkId,
    });
    expect(owner.chunkId).toBe(chunkId);
    expect(owner.samples).toHaveLength(180);
    expect(owner.toolSpans[0]).toMatchObject({ toolName: 'Bash' });

    await expect(
      getSessionResourceTimelineChunk(env, { projectId: 'proj-1', sessionId: 'sess-2', chunkId })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      getSessionResourceTimelineChunk(env, { projectId: 'proj-2', sessionId: 'sess-1', chunkId })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
