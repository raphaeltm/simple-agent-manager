import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import type { AuthContext } from '../../src/middleware/auth';
import { projectResourceHistoryRoutes } from '../../src/routes/projects/workspace-resource-history';
import { workspaceResourceHistoryCallbackRoute } from '../../src/routes/projects/workspace-resource-history-callback';
import { verifyCallbackToken } from '../../src/services/jwt';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/jwt')>()),
  verifyCallbackToken: vi.fn(),
}));

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

function authContext(): AuthContext {
  return {
    user: {
      id: 'member-1',
      email: 'member-1@example.test',
      name: 'Resource history owner',
      avatarUrl: null,
      role: 'user',
      status: 'active',
    },
    session: {
      id: 'browser-session-1',
      token: 'browser-token',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    },
  };
}

function makeR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    binding: {
      put: async (key: string, value: Uint8Array) => {
        objects.set(key, value);
        return null;
      },
      delete: async (key: string) => objects.delete(key),
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

describe('workspace resource history HTTP vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let r2: ReturnType<typeof makeR2>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });

    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.projects,
      schema.projectMembers,
      schema.workspaces,
      schema.workspaceResourceSummaries,
      schema.workspaceResourceChunks,
    ]);
    sqlite
      .prepare(`INSERT INTO projects (id, user_id, name) VALUES ('proj-1', 'member-1', 'Project')`)
      .run();
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES ('proj-1', 'member-1', 'owner', 'active')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();

    r2 = makeR2();
    env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_DATA_ARCHIVE_R2: r2.binding,
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', authContext());
      await next();
    });
    app.onError(handleAppError);
    app.route('/api/projects', workspaceResourceHistoryCallbackRoute);
    app.route('/api/projects', projectResourceHistoryRoutes);
  });

  afterEach(() => sqlite.close());

  it('uploads and reads working-set summaries and raw samples through real routes', async () => {
    const payload = {
      samples: [
        { t: 1_000, memoryBytes: 1024, memoryWorkingSetBytes: 512 },
        { t: 1_500, memoryBytes: 4096, memoryWorkingSetBytes: 1024 },
        { t: 2_000, memoryBytes: 2048, memoryWorkingSetBytes: 768 },
      ],
      toolSpans: [],
      gaps: [],
    };
    const compressed = await gzipJson(payload);
    const body = {
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
      taskId: null,
      sourceVersion: 1,
      chunkSequence: 0,
      startedAt: 1_000,
      endedAt: 2_000,
      sampleCount: 3,
      gapCount: 0,
      toolSpanCount: 0,
      compressedBase64: base64(compressed),
      compressedBytes: compressed.byteLength,
      uncompressedBytes: JSON.stringify(payload).length,
      sha256: await sha256Hex(compressed),
      completeness: { status: 'complete' },
      summary: {
        memoryMeanBytes: 2389,
        memoryPeakBytes: 4096,
        memoryKernelPeakBytes: 8192,
        memoryWorkingSetMeanBytes: 768,
        memoryWorkingSetPeakBytes: 1024,
        memoryWorkingSetSampleCount: 3,
      },
    };

    const upload = await app.fetch(
      new Request('https://api.test/api/projects/proj-1/workspace-resource-history', {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env
    );
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { chunkId: string };
    expect(r2.objects.size).toBe(1);

    const read = await app.fetch(
      new Request(
        `https://api.test/api/projects/proj-1/sessions/session-1/resource-history?chunkId=${encodeURIComponent(uploaded.chunkId)}`
      ),
      env
    );
    expect(read.status).toBe(200);
    const history = (await read.json()) as {
      summary: Record<string, unknown>;
      detail: { samples: Array<Record<string, unknown>> };
    };
    expect(history.summary).toMatchObject({
      memoryPeakBytes: 4096,
      memoryKernelPeakBytes: 8192,
      memoryWorkingSetMeanBytes: 768,
      memoryWorkingSetPeakBytes: 1024,
    });
    expect(history.detail.samples.map((sample) => sample.memoryBytes)).toEqual([1024, 4096, 2048]);
    expect(history.detail.samples.map((sample) => sample.memoryWorkingSetBytes)).toEqual([
      512, 1024, 768,
    ]);
  });
});
