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
import { D1_MAX_BOUND_PARAMETERS } from '../../../src/lib/d1-limits';
import { AppError } from '../../../src/middleware/error';
import { nodesRoutes } from '../../../src/routes/nodes';
import {
  storeWorkspaceResourceChunk,
  type WorkspaceResourceUploadBody,
} from '../../../src/services/workspace-resource-history';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

const auth = vi.hoisted(() => ({ userId: 'owner-1' }));
const settings = vi.hoisted(() => ({
  windowMinutes: 60 as unknown,
  maxHistoryWorkspaces: undefined as unknown,
  maxWorkspaces: undefined as unknown,
  maxChunks: undefined as unknown,
}));

vi.mock('../../../src/middleware/auth', async (load) => ({
  ...(await load<typeof import('../../../src/middleware/auth')>()),
  getUserId: () => auth.userId,
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/services/admin-settings', async (load) => ({
  ...(await load<typeof import('../../../src/services/admin-settings')>()),
  resolveAdminSetting: vi.fn(async (_env: unknown, name: string) =>
    name === 'nodes.usageWindowMinutes'
      ? settings.windowMinutes
      : name === 'nodes.usageMaxHistoryWorkspaces'
        ? settings.maxHistoryWorkspaces
        : name === 'nodes.usageMaxWorkspaces'
          ? settings.maxWorkspaces
          : name === 'nodes.usageMaxChunksPerWorkspace'
            ? settings.maxChunks
            : undefined
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
  settings.maxHistoryWorkspaces = undefined;
  settings.maxWorkspaces = undefined;
  settings.maxChunks = undefined;
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
    // Enforces D1's real bind limit, so an oversized chunk statement fails here.
    DATABASE: createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS),
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
    // Creating a project also creates its owner's membership, as `createOwnerProjectMembership` does.
    project: (id: string, name: string, userId: string) => {
      sqlite
        .prepare(`INSERT INTO projects (id, name, user_id) VALUES (?, ?, ?)`)
        .run(id, name, userId);
      sqlite
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`
        )
        .run(id, userId);
    },
    member: (projectId: string, userId: string, status: 'active' | 'removed') =>
      sqlite
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'member', ?)
           ON CONFLICT (project_id, user_id) DO UPDATE SET status = excluded.status`
        )
        .run(projectId, userId, status),
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
      updatedAt?: string;
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
          w.updatedAt ?? new Date(now).toISOString()
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
    historyOmittedCount: number;
    historyTruncatedCount: number;
    workspacesOmitted: boolean;
    workspaces: Array<{
      workspaceId: string;
      nodeId: string;
      projectId: string | null;
      projectName: string | null;
      holdsReservation: boolean;
      historyOmitted: boolean;
      historyTruncated: boolean;
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

  describe('at the outer limit', () => {
    it('reads only chunks near the window, by index range, however much history a workspace has', async () => {
      const f = fixture();
      createDeclaredIndexes(f.sqlite, [schema.workspaceResourceChunks]);
      const { recent } = await seedOwnerWorkspace(f);
      // ~90 days of 15-minute chunks behind the window, copied from a real uploaded row.
      const template = f.sqlite
        .prepare(`SELECT * FROM workspace_resource_chunks WHERE started_at = ?`)
        .get(recent) as Record<string, unknown>;
      const insert = f.sqlite.prepare(
        `INSERT INTO workspace_resource_chunks (id, project_id, workspace_id, chunk_sequence, source_version, r2_key,
           storage_format, compressed_bytes, uncompressed_bytes, sha256, started_at, ended_at, sample_count,
           completeness_json, summary_json, rollup_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, 1, ?, 'gzip', 1, 1, 'x', ?, ?, 180, '{}', '{}', ?, 0, 0)`
      );
      const old = f.sqlite.transaction(() => {
        for (let i = 0; i < 8_640; i++) {
          const start = recent - (4 * 60 + i * 15) * MINUTE;
          insert.run(
            `old-${i}`,
            'p1',
            'w1',
            1000 + i,
            `old/${i}`,
            start,
            start + 15 * MINUTE,
            template.rollup_json
          );
        }
      });
      old();

      const statements: string[] = [];
      const prepare = f.sqlite.prepare.bind(f.sqlite);
      f.sqlite.prepare = ((sql: string) => {
        statements.push(sql);
        return prepare(sql);
      }) as typeof f.sqlite.prepare;

      const body = await getUsage(f);
      expect(body.workspaces[0]?.series.start).toHaveLength(30);

      const chunkSql = statements.find((sql) => sql.includes('FROM workspace_resource_chunks'));
      expect(chunkSql).toBeDefined();
      const plan = prepare(`EXPLAIN QUERY PLAN ${chunkSql}`)
        .all('p1', 'w1', 0, 0, 48)
        .map((row) => (row as { detail: string }).detail)
        .join('\n');
      // The started_at bound is inside the index search, so old history is never read.
      expect(plan).toContain('idx_workspace_resource_chunks_project_workspace');
      expect(plan).toMatch(/started_at>\?/);
    });

    it('reads history for more workspaces than fit in one statement', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.node('node-1', 'owner-1');
      const start = minuteFloor(f.now) - 30 * MINUTE;
      for (let i = 0; i < 40; i++) {
        f.sql.workspace({ id: `w${i}`, userId: 'owner-1', nodeId: 'node-1', projectId: 'p1' });
        await upload(f.env, { projectId: 'p1', workspaceId: `w${i}`, sequence: 1, start });
      }

      const body = await getUsage(f);
      expect(body.workspaces).toHaveLength(40);
      expect(body.workspaces.every((w) => w.series.start.length === 15)).toBe(true);
      expect(body.historyOmittedCount).toBe(0);
    });

    it('caps history reads, live and recent first, and says what it left out', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.node('node-1', 'owner-1');
      const start = minuteFloor(f.now) - 30 * MINUTE;
      const iso = (minutesAgo: number) => new Date(f.now - minutesAgo * MINUTE).toISOString();
      const seed = async (id: string, status: string, updatedMinutesAgo: number) => {
        f.sql.workspace({
          id,
          userId: 'owner-1',
          nodeId: 'node-1',
          projectId: 'p1',
          status,
          updatedAt: iso(updatedMinutesAgo),
        });
        await upload(f.env, { projectId: 'p1', workspaceId: id, sequence: 1, start });
      };
      await seed('live-new', 'running', 1);
      await seed('live-old', 'running', 50);
      await seed('stopped-recent', 'stopped', 5);
      await seed('live-mid', 'running', 20);
      // Stopped long before the lookback: cannot have history in the window, so never read or counted.
      f.sql.workspace({
        id: 'stopped-ancient',
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p1',
        status: 'stopped',
        updatedAt: iso(60 * 24 * 7),
      });
      settings.maxHistoryWorkspaces = 3;

      const body = await getUsage(f);
      const byId = Object.fromEntries(body.workspaces.map((w) => [w.workspaceId, w]));
      expect(body.historyOmittedCount).toBe(1);
      expect(byId['live-new']?.series.start.length).toBe(15);
      expect(byId['live-mid']?.series.start.length).toBe(15);
      expect(byId['live-old']?.series.start.length).toBe(15);
      expect(byId['stopped-recent']).toMatchObject({ historyOmitted: true, series: { start: [] } });
      expect(byId['stopped-ancient']).toMatchObject({
        historyOmitted: false,
        series: { start: [] },
      });
    });
  });

  describe('project access', () => {
    it('hides project data once the caller is no longer an active member, and still shows their usage', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.user('lead', 'Project Lead');
      f.sql.node('node-1', 'owner-1');
      // Owner control: a project the caller still belongs to.
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.session('chat-1', 'p1', 'Kept topic', 'owner-1');
      f.sql.workspace({
        id: 'kept',
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p1',
        chatSessionId: 'chat-1',
      });
      // Attack: the caller was removed from p2, but their workspace is still on their own node.
      f.sql.project('p2', 'Secret project', 'lead');
      f.sql.member('p2', 'owner-1', 'removed');
      f.sql.session('chat-2', 'p2', 'Secret topic', 'lead');
      f.sql.task('t2', 'p2', 'lead', 'chat-2', 'Secret task title');
      f.sql.workspace({
        id: 'ws-left-01ABCD',
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p2',
        chatSessionId: 'chat-2',
        displayName: 'Secret task title',
      });
      const start = minuteFloor(f.now) - 30 * MINUTE;
      await upload(f.env, { projectId: 'p2', workspaceId: 'ws-left-01ABCD', sequence: 1, start });

      const body = await getUsage(f);
      const byId = Object.fromEntries(body.workspaces.map((w) => [w.workspaceId, w]));
      expect(byId.kept).toMatchObject({
        projectId: 'p1',
        projectName: 'SAM',
        chatSessionId: 'chat-1',
        title: 'Kept topic',
      });
      expect(byId['ws-left-01ABCD']).toMatchObject({
        projectId: null,
        projectName: null,
        chatSessionId: null,
        title: 'Workspace 01abcd',
      });
      expect(JSON.stringify(body)).not.toContain('Secret');
      // Liveness: the caller's own machine usage is still there.
      expect(byId['ws-left-01ABCD']?.series.start).toHaveLength(15);
    });
  });

  describe('caps that drop work disclose it', () => {
    it('lists at most nodes.usageMaxWorkspaces workspaces, live first, and says more exist', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.node('node-1', 'owner-1');
      const iso = (minutesAgo: number) => new Date(f.now - minutesAgo * MINUTE).toISOString();
      f.sql.workspace({
        id: 'live-old',
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p1',
        updatedAt: iso(600),
      });
      f.sql.workspace({
        id: 'stopped-new',
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p1',
        status: 'stopped',
        updatedAt: iso(1),
      });
      f.sql.workspace({
        id: 'stopped-older',
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p1',
        status: 'stopped',
        updatedAt: iso(5),
      });
      settings.maxWorkspaces = 2;

      const body = await getUsage(f);
      expect(body.workspaces.map((w) => w.workspaceId)).toEqual(['live-old', 'stopped-new']);
      expect(body.workspacesOmitted).toBe(true);

      // Control: under the cap nothing is dropped or flagged.
      settings.maxWorkspaces = 3;
      const all = await getUsage(f);
      expect(all.workspaces).toHaveLength(3);
      expect(all.workspacesOmitted).toBe(false);
    });

    it('reads at most nodes.usageMaxChunksPerWorkspace chunks per workspace, newest first, and flags the rest', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.node('node-1', 'owner-1');
      f.sql.workspace({ id: 'busy', userId: 'owner-1', nodeId: 'node-1', projectId: 'p1' });
      f.sql.workspace({ id: 'calm', userId: 'owner-1', nodeId: 'node-1', projectId: 'p1' });
      const first = minuteFloor(f.now) - 60 * MINUTE;
      for (let i = 0; i < 4; i++) {
        await upload(f.env, {
          projectId: 'p1',
          workspaceId: 'busy',
          sequence: i,
          start: first + i * 15 * MINUTE,
        });
      }
      await upload(f.env, {
        projectId: 'p1',
        workspaceId: 'calm',
        sequence: 1,
        start: first + 45 * MINUTE,
      });
      settings.maxChunks = 2;

      const body = await getUsage(f);
      const byId = Object.fromEntries(body.workspaces.map((w) => [w.workspaceId, w]));
      expect(body.historyTruncatedCount).toBe(1);
      expect(byId.busy?.historyTruncated).toBe(true);
      // The two newest chunks: 30 minutes, starting at the third chunk.
      expect(byId.busy?.series.start).toHaveLength(30);
      expect(byId.busy?.series.start[0]).toBe(first + 30 * MINUTE);
      // Control: a workspace under the cap is complete and unflagged.
      expect(byId.calm).toMatchObject({ historyTruncated: false });
      expect(byId.calm?.series.start).toHaveLength(15);
    });
  });

  describe('history ranking under the cap', () => {
    it('gives a running session on a second machine history before a busy machine fills the cap', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.node('busy-node', 'owner-1');
      f.sql.node('quiet-node', 'owner-1');
      const iso = (minutesAgo: number) => new Date(f.now - minutesAgo * MINUTE).toISOString();
      const start = minuteFloor(f.now) - 30 * MINUTE;
      for (const [id, nodeId, minutesAgo] of [
        ['busy-a', 'busy-node', 1],
        ['busy-b', 'busy-node', 2],
        ['busy-c', 'busy-node', 3],
        ['quiet-a', 'quiet-node', 30],
      ] as const) {
        f.sql.workspace({
          id,
          userId: 'owner-1',
          nodeId,
          projectId: 'p1',
          updatedAt: iso(minutesAgo),
        });
        await upload(f.env, { projectId: 'p1', workspaceId: id, sequence: 1, start });
      }
      settings.maxHistoryWorkspaces = 2;

      const body = await getUsage(f);
      const withHistory = body.workspaces
        .filter((w) => !w.historyOmitted)
        .map((w) => w.workspaceId)
        .sort();
      expect(withHistory).toEqual(['busy-a', 'quiet-a']);
      expect(body.historyOmittedCount).toBe(2);
    });

    it('breaks ties by workspace id, so identical requests read the same workspaces', async () => {
      const f = fixture();
      f.sql.user('owner-1', 'Owner One');
      f.sql.project('p1', 'SAM', 'owner-1');
      f.sql.node('node-1', 'owner-1');
      const same = new Date(f.now - MINUTE).toISOString();
      for (const id of ['w-c', 'w-a', 'w-b']) {
        f.sql.workspace({
          id,
          userId: 'owner-1',
          nodeId: 'node-1',
          projectId: 'p1',
          updatedAt: same,
        });
      }
      settings.maxHistoryWorkspaces = 1;

      const body = await getUsage(f);
      expect(body.workspaces.filter((w) => !w.historyOmitted).map((w) => w.workspaceId)).toEqual([
        'w-a',
      ]);
    });
  });

  it('marks only running, creating and recovery workspaces as holding their reservation', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    f.sql.project('p1', 'SAM', 'owner-1');
    f.sql.node('node-1', 'owner-1');
    for (const status of ['running', 'creating', 'recovery', 'stopped', 'evicted', 'error']) {
      f.sql.workspace({
        id: `w-${status}`,
        userId: 'owner-1',
        nodeId: 'node-1',
        projectId: 'p1',
        status,
      });
    }

    const body = await getUsage(f);
    const holding = body.workspaces
      .filter((w) => w.holdsReservation)
      .map((w) => w.status)
      .sort();
    expect(holding).toEqual(['creating', 'recovery', 'running']);
    expect(body.workspaces).toHaveLength(6);
  });

  it('places buckets stored at an older rollup width on the width the response reports', async () => {
    const f = fixture();
    f.sql.user('owner-1', 'Owner One');
    f.sql.project('p1', 'SAM', 'owner-1');
    f.sql.node('node-1', 'owner-1');
    f.sql.workspace({ id: 'w1', userId: 'owner-1', nodeId: 'node-1', projectId: 'p1' });
    const start = minuteFloor(f.now) - 30 * MINUTE;
    // Uploaded while the rollup width was 30 seconds...
    (
      f.env as { WORKSPACE_RESOURCE_ROLLUP_BUCKET_MS?: string }
    ).WORKSPACE_RESOURCE_ROLLUP_BUCKET_MS = '30000';
    await upload(f.env, { projectId: 'p1', workspaceId: 'w1', sequence: 1, start });
    // ...and read after it changed to one minute.
    (
      f.env as { WORKSPACE_RESOURCE_ROLLUP_BUCKET_MS?: string }
    ).WORKSPACE_RESOURCE_ROLLUP_BUCKET_MS = '60000';

    const body = await getUsage(f);
    const series = body.workspaces[0]?.series;
    expect(body.bucketMs).toBe(60_000);
    expect(series?.start).toHaveLength(15);
    expect(series?.start.every((t) => t % 60_000 === 0)).toBe(true);
    expect(series?.cpuMillis.every((v) => v === 500)).toBe(true);
  });
});
