/**
 * GET /api/nodes/resource-usage through the real Hono route and a real SQLite engine.
 *
 * Resource history is seeded through the real upload path (`storeWorkspaceResourceChunk`,
 * which builds the stored per-minute rollup), so the read is tested against the rows the
 * VM agent's uploads actually produce. Only authentication and the admin-setting store are
 * replaced.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodesRoutes } from '../../../src/routes/nodes';
import {
  storeWorkspaceResourceChunk,
  type WorkspaceResourceUploadBody,
} from '../../../src/services/workspace-resource-history';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const auth = vi.hoisted(() => ({ userId: 'owner-1' }));
const settings = vi.hoisted(() => ({ windowMinutes: 60 as unknown }));

vi.mock('../../../src/middleware/auth', async (load) => ({
  ...(await load<typeof import('../../../src/middleware/auth')>()),
  getUserId: () => auth.userId,
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/services/admin-settings', async (load) => ({
  ...(await load<typeof import('../../../src/services/admin-settings')>()),
  resolveAdminSetting: vi.fn(async (_env: unknown, name: string) =>
    name === 'nodes.usageWindowMinutes' ? settings.windowMinutes : undefined
  ),
}));

const MINUTE = 60_000;
const RESERVATION = JSON.stringify({
  cpuMillis: 2_000,
  memoryMb: 4_096,
  diskMb: 10_240,
  exclusiveNode: false,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
});

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  auth.userId = 'owner-1';
  settings.windowMinutes = 60;
});

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    get: async () => null,
  } as unknown as R2Bucket;
}

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  const env = {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA_ARCHIVE_R2: makeR2(),
    BASE_DOMAIN: 'example.test',
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.route('/api/nodes', nodesRoutes);

  const now = Date.now();
  const sql = {
    user: (id: string, name: string) =>
      sqlite
        .prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`)
        .run(id, name, `${id}@x.test`),
    project: (id: string, name: string, userId: string) =>
      sqlite
        .prepare(`INSERT INTO projects (id, name, user_id) VALUES (?, ?, ?)`)
        .run(id, name, userId),
    node: (id: string, userId: string, status = 'running') =>
      sqlite
        .prepare(
          `INSERT INTO nodes (id, user_id, name, status, node_role, node_class, runtime, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'workspace', 'managed', 'vm', ?, ?)`
        )
        .run(
          id,
          userId,
          `Auto: some task ${id}`,
          status,
          '2026-11-04T00:00:00Z',
          '2026-11-04T00:00:00Z'
        ),
    workspace: (w: {
      id: string;
      userId: string;
      nodeId: string;
      projectId: string | null;
      chatSessionId?: string | null;
      name?: string;
      displayName?: string | null;
      status?: string;
      reservation?: string | null;
    }) =>
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, user_id, node_id, project_id, chat_session_id, name, display_name,
             status, resolved_reservation_json, created_at, updated_at, repository, branch, vm_size, vm_location)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'o/r', 'main', 'medium', 'fsn1')`
        )
        .run(
          w.id,
          w.userId,
          w.nodeId,
          w.projectId,
          w.chatSessionId ?? null,
          w.name ?? `ws-${w.id}`,
          w.displayName ?? null,
          w.status ?? 'running',
          w.reservation === undefined ? RESERVATION : w.reservation,
          '2026-11-04T10:00:00Z',
          '2026-11-04T10:00:00Z'
        ),
    session: (id: string, projectId: string, topic: string | null, createdBy: string) =>
      sqlite
        .prepare(
          `INSERT INTO session_summaries (id, project_id, user_id, status, topic, message_count, started_at,
             updated_at, created_by_user_id)
           VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?)`
        )
        .run(id, projectId, createdBy, topic, now, now, createdBy),
    task: (id: string, projectId: string, userId: string, chatSessionId: string, title: string) =>
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, chat_session_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`
        )
        .run(
          id,
          projectId,
          userId,
          chatSessionId,
          title,
          '2026-11-04T10:00:00Z',
          '2026-11-04T10:00:00Z'
        ),
  };
  return { sqlite, env, app, now, sql };
}

/** One 15-minute chunk through the real upload path; 2 500 ms CPU per 5 s sample is 0.5 cores. */
async function upload(
  env: Env,
  input: {
    projectId: string;
    workspaceId: string;
    sequence: number;
    start: number;
    cpuMillis?: number;
  }
) {
  const cpuMillis = input.cpuMillis ?? 2_500;
  const payload = {
    samples: Array.from({ length: 180 }, (_, i) => ({
      t: input.start + (i + 1) * 5_000,
      intervalMillis: 5_000,
      cpuMillis,
      memoryBytes: 1_000_000_000,
    })),
    toolSpans: [],
  };
  const json = JSON.stringify(payload);
  const compressed = await gzipJson(payload);
  const body: WorkspaceResourceUploadBody = {
    workspaceId: input.workspaceId,
    sourceVersion: 1,
    chunkSequence: input.sequence,
    startedAt: input.start,
    endedAt: input.start + 15 * MINUTE,
    sampleCount: payload.samples.length,
    toolSpanCount: 0,
    compressedBase64: base64(compressed),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: new TextEncoder().encode(json).byteLength,
    sha256: await sha256Hex(compressed),
    completeness: { status: 'complete' },
    summary: { cpuMeanMillis: cpuMillis, cpuPeakMillis: cpuMillis, sampleIntervalMillis: 5_000 },
  };
  await storeWorkspaceResourceChunk(env, input.projectId, body, null);
}

async function getUsage(f: ReturnType<typeof fixture>) {
  const res = await f.app.request('/api/nodes/resource-usage', { method: 'GET' }, f.env);
  if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    windowMinutes: number;
    windowStart: number;
    windowEnd: number;
    bucketMs: number;
    workspaces: Array<{
      workspaceId: string;
      nodeId: string;
      projectName: string | null;
      chatSessionId: string | null;
      title: string;
      ownerName: string | null;
      isMine: boolean;
      status: string;
      reservation: { cpuMillis: number; memoryMb: number } | null;
      series: {
        start: number[];
        cpuMillis: Array<number | null>;
        memoryBytes: Array<number | null>;
      };
      historyEndsAt: number | null;
    }>;
  };
}

function minuteFloor(t: number) {
  return t - (t % MINUTE);
}

async function seedOwnerWorkspace(f: ReturnType<typeof fixture>) {
  f.sql.user('owner-1', 'Owner One');
  f.sql.project('p1', 'SAM', 'owner-1');
  f.sql.node('node-1', 'owner-1');
  f.sql.session('chat-1', 'p1', 'Fix the OOM relocation', 'owner-1');
  f.sql.workspace({
    id: 'w1',
    userId: 'owner-1',
    nodeId: 'node-1',
    projectId: 'p1',
    chatSessionId: 'chat-1',
  });
  const recent = minuteFloor(f.now) - 40 * MINUTE;
  await upload(f.env, { projectId: 'p1', workspaceId: 'w1', sequence: 1, start: recent });
  await upload(f.env, {
    projectId: 'p1',
    workspaceId: 'w1',
    sequence: 2,
    start: recent + 15 * MINUTE,
  });
  // Outside a 60-minute window: must not be drawn.
  await upload(f.env, {
    projectId: 'p1',
    workspaceId: 'w1',
    sequence: 0,
    start: recent - 3 * 60 * MINUTE,
  });
  return { recent };
}

describe('GET /api/nodes/resource-usage', () => {
  it('returns the caller’s sessions with titles, reservations and per-minute history inside the window', async () => {
    const f = fixture();
    const { recent } = await seedOwnerWorkspace(f);

    const body = await getUsage(f);

    expect(body.windowMinutes).toBe(60);
    expect(body.bucketMs).toBe(MINUTE);
    expect(body.workspaces).toHaveLength(1);
    const [w] = body.workspaces;
    expect(w).toMatchObject({
      workspaceId: 'w1',
      nodeId: 'node-1',
      projectName: 'SAM',
      chatSessionId: 'chat-1',
      title: 'Fix the OOM relocation',
      ownerName: 'Owner One',
      isMine: true,
      status: 'running',
      reservation: { cpuMillis: 2_000, memoryMb: 4_096 },
    });
    // Two 15-minute chunks inside the window, one minute per bucket; the 3-hour-old chunk is not drawn.
    expect(w?.series.start).toHaveLength(30);
    expect(w?.series.start[0]).toBe(recent);
    expect(w?.series.start.every((start) => start >= body.windowStart - MINUTE)).toBe(true);
    expect(w?.series.cpuMillis.every((cpu) => cpu === 500)).toBe(true);
    expect(w?.series.memoryBytes.every((memory) => memory === 1_000_000_000)).toBe(true);
    expect(w?.historyEndsAt).toBe(recent + 30 * MINUTE);
  });

  it('is not captured by the /:id node route', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    const res = await f.app.request('/api/nodes/resource-usage', { method: 'GET' }, f.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspaces: [] });
  });

  it('never returns another user’s workspaces or history; that user still sees their own', async () => {
    const f = fixture();
    await seedOwnerWorkspace(f);
    f.sql.user('owner-2', 'Owner Two');
    f.sql.project('p2', 'TTV', 'owner-2');
    f.sql.node('node-2', 'owner-2');
    f.sql.workspace({ id: 'w2', userId: 'owner-2', nodeId: 'node-2', projectId: 'p2' });
    // Owner-2's workspace placed on owner-1's node, and owner-1's workspace on owner-2's node.
    f.sql.workspace({ id: 'w3', userId: 'owner-2', nodeId: 'node-1', projectId: 'p2' });
    f.sql.workspace({ id: 'w4', userId: 'owner-1', nodeId: 'node-2', projectId: 'p1' });
    await upload(f.env, {
      projectId: 'p2',
      workspaceId: 'w2',
      sequence: 1,
      start: minuteFloor(f.now) - 20 * MINUTE,
    });

    const mine = await getUsage(f);
    expect(mine.workspaces.map((w) => w.workspaceId)).toEqual(['w1']);

    // Owner control: the same fixture serves owner-2 their own workspace with its history.
    auth.userId = 'owner-2';
    const theirs = await getUsage(f);
    expect(theirs.workspaces.map((w) => w.workspaceId)).toEqual(['w2']);
    expect(theirs.workspaces[0]?.series.start.length).toBeGreaterThan(0);
  });

  it('ignores a history chunk whose project does not match the workspace', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    f.sql.project('p1', 'SAM', 'owner-1');
    f.sql.node('node-1', 'owner-1');
    f.sql.workspace({ id: 'w1', userId: 'owner-1', nodeId: 'node-1', projectId: 'p1' });
    // A row for w1 filed under another project: the pair predicate must exclude it.
    f.sql.project('p-other', 'Other', 'owner-2');
    f.sql.workspace({ id: 'w-other', userId: 'owner-2', nodeId: 'node-x', projectId: 'p-other' });
    await upload(f.env, {
      projectId: 'p-other',
      workspaceId: 'w-other',
      sequence: 1,
      start: minuteFloor(f.now) - 20 * MINUTE,
    });
    f.sqlite
      .prepare(
        `UPDATE workspace_resource_chunks SET workspace_id = 'w1' WHERE workspace_id = 'w-other'`
      )
      .run();
    // Control: a correctly filed chunk for w1 is drawn.
    await upload(f.env, {
      projectId: 'p1',
      workspaceId: 'w1',
      sequence: 1,
      start: minuteFloor(f.now) - 40 * MINUTE,
      cpuMillis: 1_000,
    });

    const body = await getUsage(f);
    const series = body.workspaces[0]?.series;
    expect(series?.start).toHaveLength(15);
    expect(series?.cpuMillis.every((cpu) => cpu === 200)).toBe(true);
  });

  it('skips a malformed rollup and keeps the good ones', async () => {
    const f = fixture();
    const { recent } = await seedOwnerWorkspace(f);
    f.sqlite
      .prepare(
        `UPDATE workspace_resource_chunks SET rollup_json = '{not json' WHERE started_at = ?`
      )
      .run(recent);

    const body = await getUsage(f);
    expect(body.workspaces[0]?.series.start).toHaveLength(15);
    expect(body.workspaces[0]?.series.start[0]).toBe(recent + 15 * MINUTE);
  });

  it('titles a session by chat topic, then task title, then workspace display name, then name', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    f.sql.project('p1', 'SAM', 'owner-1');
    f.sql.node('node-1', 'owner-1');
    f.sql.session('chat-a', 'p1', 'From the chat', 'owner-1');
    f.sql.task('task-a', 'p1', 'owner-1', 'chat-a', 'From the task A');
    f.sql.workspace({
      id: 'wa',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: 'p1',
      chatSessionId: 'chat-a',
    });
    f.sql.task('task-b', 'p1', 'owner-1', 'chat-b', 'From the task');
    f.sql.workspace({
      id: 'wb',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: 'p1',
      chatSessionId: 'chat-b',
    });
    f.sql.workspace({
      id: 'wc',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: 'p1',
      displayName: 'Display name',
    });
    f.sql.workspace({
      id: 'wd',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: null,
      name: 'plain-name',
    });
    // A session in another project with the same id must not title this workspace.
    f.sql.session('chat-e', 'p-other', 'Wrong project', 'owner-1');
    f.sql.workspace({
      id: 'we',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: 'p1',
      chatSessionId: 'chat-e',
      name: 'we-name',
    });

    const titles = Object.fromEntries(
      (await getUsage(f)).workspaces.map((w) => [w.workspaceId, w.title])
    );
    expect(titles).toEqual({
      wa: 'From the chat',
      wb: 'From the task',
      wc: 'Display name',
      wd: 'plain-name',
      we: 'we-name',
    });
  });

  it('returns a null reservation for a malformed one instead of failing the page', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    f.sql.node('node-1', 'owner-1');
    f.sql.workspace({
      id: 'w1',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: null,
      reservation: '{broken',
    });
    f.sql.workspace({ id: 'w2', userId: 'owner-1', nodeId: 'node-1', projectId: null });

    const byId = Object.fromEntries(
      (await getUsage(f)).workspaces.map((w) => [w.workspaceId, w.reservation])
    );
    expect(byId.w1).toBeNull();
    expect(byId.w2).toMatchObject({ cpuMillis: 2_000, memoryMb: 4_096 });
  });

  it('leaves out deleted workspaces and workspaces on deleted nodes', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    f.sql.node('node-1', 'owner-1');
    f.sql.node('node-gone', 'owner-1', 'deleted');
    f.sql.workspace({ id: 'live', userId: 'owner-1', nodeId: 'node-1', projectId: null });
    f.sql.workspace({
      id: 'deleted',
      userId: 'owner-1',
      nodeId: 'node-1',
      projectId: null,
      status: 'deleted',
    });
    f.sql.workspace({ id: 'orphan', userId: 'owner-1', nodeId: 'node-gone', projectId: null });

    expect((await getUsage(f)).workspaces.map((w) => w.workspaceId)).toEqual(['live']);
  });

  it('follows the nodes.usageWindowMinutes setting and falls back to 60 minutes on a bad value', async () => {
    const f = fixture();
    await seedOwnerWorkspace(f);

    settings.windowMinutes = 15;
    const narrow = await getUsage(f);
    expect(narrow.windowMinutes).toBe(15);
    expect(narrow.windowEnd - narrow.windowStart).toBe(15 * MINUTE);
    // The newer chunk ends 10 minutes ago, so only its last ~5 minutes overlap the window.
    const starts = narrow.workspaces[0]?.series.start ?? [];
    expect(starts.every((start) => start + MINUTE > narrow.windowStart)).toBe(true);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.length).toBeLessThanOrEqual(6);

    settings.windowMinutes = 'not a number';
    expect((await getUsage(f)).windowMinutes).toBe(60);
  });
});
