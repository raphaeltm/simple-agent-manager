import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { workspaceResourceHistoryCallbackRoute } from '../../src/routes/projects/workspace-resource-history-callback';
import { verifyCallbackToken } from '../../src/services/jwt';
import { getWorkspaceResourceHistory } from '../../src/services/workspace-resource-history';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/jwt')>()),
  verifyCallbackToken: vi.fn(),
}));

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
        body: new Blob([value]).stream(),
      };
    },
  } as unknown as R2Bucket;
}

describe('workspace resource history callback integration', () => {
  beforeEach(() => {
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });
  });

  it('stores and reads labeled tool spans through the real callback service path', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.workspaces,
      schema.workspaceResourceSummaries,
      schema.workspaceResourceChunks,
    ]);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();
    const env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_DATA_ARCHIVE_R2: makeR2(),
    } as unknown as Env;
    const payload = {
      samples: [{ t: 1_000, cpuMillis: 25, memoryBytes: 1024 }],
      toolSpans: [{ id: 'hashed-tool-id', kind: 'execute', toolName: 'Bash', startedAt: 1_000 }],
      gaps: [],
    };
    const compressed = await gzipJson(payload);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/projects', workspaceResourceHistoryCallbackRoute);

    const response = await app.request(
      '/api/projects/proj-1/workspace-resource-history',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          nodeId: 'node-1',
          sessionId: 'session-1',
          taskId: null,
          sourceVersion: 1,
          chunkSequence: 0,
          startedAt: 1_000,
          endedAt: 2_000,
          sampleCount: 1,
          gapCount: 0,
          toolSpanCount: 1,
          compressedBase64: base64(compressed),
          compressedBytes: compressed.byteLength,
          uncompressedBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
          sha256: await sha256Hex(compressed),
          completeness: { status: 'complete' },
          summary: { cpuPeakMillis: 25, memoryPeakBytes: 1024 },
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as { chunkId: string };
    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'proj-1',
      sessionId: 'session-1',
      detailChunkId: result.chunkId,
    });
    expect(history.detail?.toolSpans).toEqual([
      expect.objectContaining({ kind: 'execute', toolName: 'Bash', startedAt: 1_000 }),
    ]);
  });
});
