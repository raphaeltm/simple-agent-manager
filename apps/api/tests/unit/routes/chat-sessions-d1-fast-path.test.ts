/**
 * GET /api/projects/:projectId/sessions — D1 fast path vs ProjectData DO fallback.
 *
 * The route may only answer from the D1 index when coverage proves the index
 * holds the same answer the DO would give. These tests drive the REAL route over
 * a real SQLite engine and assert which backend actually served the request, by
 * spying on the DO service.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const OWNER = 'user-owner';
const PROJECT = 'proj-alpha';

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  listSessions: vi.fn(),
  requireProjectAccess: vi.fn(),
  enrichSessionsWithCreators: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  listSessions: mocks.listSessions,
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => OWNER,
}));

// Identity enrichment — keeps the assertions about WHICH backend served the read.
vi.mock('../../../src/routes/chat-session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/routes/chat-session-ownership')>()),
  enrichSessionsWithCreators: mocks.enrichSessionsWithCreators,
}));

const { chatRoutes } = await import('../../../src/routes/chat');

describe('GET /api/projects/:projectId/sessions — D1 fast path', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let now: number;

  function setCoverage(opts: { complete?: boolean; syncedAt?: number } = {}): void {
    sqlite
      .prepare(
        `INSERT INTO session_index_coverage (project_id, synced_at, session_count, complete)
         VALUES (?, ?, ?, ?)`
      )
      .run(PROJECT, opts.syncedAt ?? now, 1, (opts.complete ?? true) ? 1 : 0);
  }

  function addIndexedSession(id: string): void {
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, topic, message_count, started_at, updated_at,
            created_by_user_id, created_at, synced_at)
         VALUES (?, ?, ?, 'active', 'From D1', 2, 100, 5000, ?, 90, ?)`
      )
      .run(id, PROJECT, OWNER, OWNER, now);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    now = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;

    mocks.requireProjectAccess.mockResolvedValue({ role: 'owner' });
    mocks.enrichSessionsWithCreators.mockImplementation(
      async (_db: unknown, sessions: unknown[]) => sessions
    );
    mocks.listSessions.mockResolvedValue({
      sessions: [{ id: 'from-do', topic: 'From the DO' }],
      total: 1,
      hasMore: false,
    });

    app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects/:projectId/sessions', chatRoutes);
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  async function listSessions(query = ''): Promise<{ status: number; body: never }> {
    const res = await app.request(
      `/api/projects/${PROJECT}/sessions${query}`,
      {},
      env as unknown as Record<string, unknown>
    );
    return { status: res.status, body: (await res.json()) as never };
  }

  it('serves from D1 and does NOT call the Durable Object when coverage is fresh and complete', async () => {
    addIndexedSession('from-d1');
    setCoverage();

    const { status, body } = await listSessions();

    expect(status).toBe(200);
    expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['from-d1']);
    // The whole point of the change: no DO round-trip on the hot path.
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it('falls back to the Durable Object when the project has no coverage row', async () => {
    addIndexedSession('from-d1');
    // No coverage written.

    const { status, body } = await listSessions();

    expect(status).toBe(200);
    expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['from-do']);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it('still returns the session list when the index prime itself fails', async () => {
    // The prime is best-effort — the caller already has an authoritative answer
    // from the DO and this only speeds up the NEXT read. It must not be able to
    // turn a working session list into a 500, whether it rejects, throws
    // synchronously while resolving the stub, or finds no ExecutionContext to
    // hang the work on (Hono THROWS on `c.executionCtx` rather than returning
    // undefined — which is exactly how this was first caught).
    addIndexedSession('from-d1');
    // No coverage → miss → DO fallback → prime attempted. This env has no
    // PROJECT_DATA binding at all, so resolving the stub blows up.

    const { status, body } = await listSessions();

    expect(status).toBe(200);
    expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['from-do']);
  });

  it('falls back to the Durable Object when coverage is incomplete', async () => {
    addIndexedSession('from-d1');
    setCoverage({ complete: false });

    const { body } = await listSessions();

    expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['from-do']);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Durable Object when coverage is stale', async () => {
    addIndexedSession('from-d1');
    setCoverage({ syncedAt: now - 24 * 60 * 60 * 1000 });

    const { body } = await listSessions();

    expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['from-do']);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it('passes scope=my through to the D1 read as a creator filter', async () => {
    addIndexedSession('mine');
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, topic, message_count, started_at, updated_at,
            created_by_user_id, created_at, synced_at)
         VALUES ('theirs', ?, ?, 'active', 'Someone else', 1, 100, 6000, 'other-user', 90, ?)`
      )
      .run(PROJECT, OWNER, now);
    setCoverage();

    const { body } = await listSessions('?scope=my');

    expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['mine']);
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it('still enriches D1-served rows with creator identity', async () => {
    addIndexedSession('from-d1');
    setCoverage();

    await listSessions();

    expect(mocks.enrichSessionsWithCreators).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ id: 'from-d1' })]),
      OWNER
    );
  });
});
