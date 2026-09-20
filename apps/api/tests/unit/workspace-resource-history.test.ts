import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  downsamplePreservingSpikes,
  storeWorkspaceResourceChunk,
  type ResourceSamplePoint,
  type WorkspaceResourceUploadBody,
} from '../../src/services/workspace-resource-history';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function uploadBody(
  overrides: Partial<WorkspaceResourceUploadBody> = {}
): Promise<WorkspaceResourceUploadBody> {
  const compressed = Uint8Array.from([1, 2, 3, 4, 5]);
  return {
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    sessionId: 'session-1',
    taskId: null,
    sourceVersion: 1,
    chunkSequence: 0,
    startedAt: 1_000,
    endedAt: 2_000,
    sampleCount: 2,
    gapCount: 0,
    toolSpanCount: 1,
    compressedBase64: base64(compressed),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: 128,
    sha256: await sha256Hex(compressed),
    completeness: { status: 'complete' },
    summary: {
      cpuMeanMillis: 25,
      cpuPeakMillis: 40,
      memoryMeanBytes: 1024,
      memoryPeakBytes: 2048,
      memoryKernelPeakBytes: 4096,
      ioReadBytes: 10,
      ioWriteBytes: 20,
      oomCount: 0,
    },
    ...overrides,
  };
}

function makeR2() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    objects,
    puts,
    deletes,
    binding: {
      put: async (key: string, value: Uint8Array) => {
        puts.push(key);
        objects.set(key, value);
        return null;
      },
      delete: async (key: string) => {
        deletes.push(key);
        objects.delete(key);
      },
      get: async (key: string) => {
        const value = objects.get(key);
        if (!value) return null;
        return {
          arrayBuffer: async () =>
            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          body: new Blob([value]).stream(),
        };
      },
    } as unknown as R2Bucket,
  };
}

function makeEnv(sqlite: Database.Database, r2: R2Bucket): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA_ARCHIVE_R2: r2,
  } as unknown as Env;
}

describe('workspace resource history', () => {
  it('bounds detail points while preserving first, last, gaps, and spikes', () => {
    const samples: ResourceSamplePoint[] = Array.from({ length: 20 }, (_, index) => ({
      t: index,
      cpuMillis: index === 9 ? 900 : 10,
      memoryBytes: index === 14 ? 900 * 1024 * 1024 : 16 * 1024 * 1024,
      gap: index === 5,
    }));

    const result = downsamplePreservingSpikes(samples, 6);

    expect(result.downsampled).toBe(true);
    expect(result.samples).toHaveLength(6);
    expect(result.samples[0]?.t).toBe(0);
    expect(result.samples.at(-1)?.t).toBe(19);
    expect(result.samples.some((sample) => sample.gap)).toBe(true);
    expect(result.samples.some((sample) => sample.cpuMillis === 900)).toBe(true);
    expect(result.samples.some((sample) => sample.memoryBytes === 900 * 1024 * 1024)).toBe(true);
  });

  it('keeps separate bounded summaries for reused workspace sessions while indexing raw chunks in R2', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.workspaces,
      schema.workspaceResourceSummaries,
      schema.workspaceResourceChunks,
    ]);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id, agent_profile_hint)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1', 'profile-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    const first = await storeWorkspaceResourceChunk(env, 'proj-1', await uploadBody(), 'node-1');
    sqlite.prepare(`UPDATE workspaces SET chat_session_id = 'session-2' WHERE id = 'ws-1'`).run();
    const second = await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        sessionId: 'session-2',
        chunkSequence: 1,
        startedAt: 2_000,
        endedAt: 3_000,
      }),
      'node-1'
    );

    expect(first.summaryId).toContain('session:session-1');
    expect(second.summaryId).toContain('session:session-2');
    expect(first.summaryId).not.toBe(second.summaryId);
    expect(r2.puts).toHaveLength(2);

    const summaries = sqlite
      .prepare(
        `SELECT id, session_id, sample_count, latest_chunk_id
           FROM workspace_resource_summaries
          ORDER BY session_id`
      )
      .all() as Array<Record<string, unknown>>;
    expect(summaries).toEqual([
      expect.objectContaining({ id: first.summaryId, session_id: 'session-1', sample_count: 2 }),
      expect.objectContaining({ id: second.summaryId, session_id: 'session-2', sample_count: 2 }),
    ]);
    const chunks = sqlite
      .prepare(
        `SELECT id, summary_id, session_id FROM workspace_resource_chunks ORDER BY chunk_sequence`
      )
      .all() as Array<Record<string, unknown>>;
    expect(chunks).toEqual([
      expect.objectContaining({ summary_id: first.summaryId, session_id: 'session-1' }),
      expect.objectContaining({ summary_id: second.summaryId, session_id: 'session-2' }),
    ]);
  });

  it('deletes the uploaded R2 object when D1 indexing fails', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.workspaces, schema.workspaceResourceChunks]);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    await expect(
      storeWorkspaceResourceChunk(env, 'proj-1', await uploadBody(), 'node-1')
    ).rejects.toThrow(/workspace_resource_summaries/i);

    expect(r2.puts).toHaveLength(1);
    expect(r2.deletes).toEqual(r2.puts);
    expect(r2.objects.size).toBe(0);
  });
});
