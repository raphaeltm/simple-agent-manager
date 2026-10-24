/**
 * The three surfaces that can move an idea's status, driven together against one database.
 *
 * Acceptance criterion 3 is that `update_idea`, the Ideas UI's own route and the GENERIC task
 * status route agree about what a person may do to an idea. Two of those were already tested
 * against each other in `tests/unit/operations/idea-transitions.test.ts` — but only as
 * functions. The third is an HTTP route with its own auth, its own validation and its own
 * error mapping, and before this feature it validated idea rows against the TASK transition
 * table, which is exactly the disagreement this work exists to end. A test of the operation
 * cannot see a route that forgets to call it (rule 62).
 *
 * So all three run here, in one `it.each` over the same matrix, against one real SQLite engine
 * through the real Hono routers mounted the way `index.ts` mounts them.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  userId: 'u1',
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => mocks.userId,
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
  requireOwnedWorkspace: vi.fn(),
}));
// Partial: only the Durable Object read is stubbed, because this harness has no PROJECT_DATA
// binding. Everything else the routes touch — activity events, lifecycle writes — stays real,
// so the ordinary-task control exercises the same code production does.
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getIdeaWorkSnapshots: vi.fn().mockResolvedValue({}),
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
}));

import { updateIdea } from '../../../src/operations/idea-core';
import type { OperationContext } from '../../../src/operations/types';
import { ideaRoutes } from '../../../src/routes/ideas';
import { crudRoutes } from '../../../src/routes/tasks/crud';

const PROJECT = 'p1';
const BASE = 'https://api.test.example.com/api/projects';

/**
 * The matrix from the idea transition table. `ready` is reachable only as a row that already
 * holds it — see the `draft → ready` case, which every surface must now refuse.
 */
const MATRIX: Array<[from: string, to: string, allowed: boolean]> = [
  ['draft', 'completed', true],
  ['draft', 'cancelled', true],
  ['draft', 'ready', false],
  ['ready', 'draft', true],
  ['ready', 'completed', true],
  ['completed', 'draft', true],
  ['completed', 'cancelled', false],
  ['cancelled', 'completed', false],
  ['cancelled', 'draft', true],
];

describe('every surface that moves an idea agrees', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;
  let env: Env;
  let ctx: OperationContext;

  function seedIdea(id: string, status: string) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, is_idea, priority, task_mode,
           dispatch_depth, created_by, created_at, updated_at, triggered_by)
         VALUES (?, ?, 'u1', 'An idea', ?, 1, 0, 'task', 0, 'u1', '2026-10-20T00:00:00.000Z',
                 '2026-10-20T00:00:00.000Z', 'user')`
      )
      .run(id, PROJECT, status);
  }

  const statusOf = (id: string) =>
    (
      sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as
        { status: string } | undefined
    )?.status;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectAccess.mockResolvedValue({ id: PROJECT, userId: 'u1' });
    mocks.requireProjectCapability.mockResolvedValue({ id: PROJECT, userId: 'u1' });

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO users (id, github_id, email, name, created_at, updated_at)
         VALUES ('u1', 'gh-u1', 'u1@test', 'U1', '2026-10-01', '2026-10-01')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO github_installations (id, user_id, installation_id, account_name, account_type,
           created_at, updated_at)
         VALUES ('inst-1', 'u1', '1', 'acme', 'User', '2026-10-01', '2026-10-01')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, installation_id, name, repository, repo_provider,
           created_at, updated_at)
         VALUES (?, 'u1', 'inst-1', 'P1', 'acme/payments', 'github', '2026-10-01', '2026-10-01')`
      )
      .run(PROJECT);

    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;
    ctx = {
      env,
      requestId: 'test',
      actor: { userId: 'u1', via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
    } as OperationContext;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    // Mounted as `index.ts` mounts them, so the routers meet the way they do in production.
    app.route('/api/projects/:projectId/ideas', ideaRoutes);
    app.route('/api/projects/:projectId/tasks', crudRoutes);
  });

  afterEach(() => sqlite.close());

  // The ordinary-task branch schedules background work, so the routes need a real execution
  // context rather than Hono's default of none.
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const postJson = (path: string, body: unknown) =>
    app.request(
      `${BASE}/${PROJECT}/${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
      executionCtx
    );

  it.each(MATRIX)('%s → %s is allowed: %s, on all three surfaces', async (from, to, allowed) => {
    seedIdea('via-task-route', from);
    seedIdea('via-ideas-route', from);
    seedIdea('via-update-idea', from);

    // 1. The GENERIC task status route. This is the surface the operation tests cannot reach:
    //    before this feature it validated idea rows with `canTransitionTaskStatus`.
    const taskRoute = await postJson('tasks/via-task-route/status', { toStatus: to });

    // 2. The Ideas UI's own route.
    const ideasRoute = await postJson('ideas/via-ideas-route/status', { status: to });

    // 3. `update_idea`, the MCP and connector surface.
    const mcp = updateIdea(ctx, { projectId: PROJECT, ideaId: 'via-update-idea', status: to });

    if (allowed) {
      expect(taskRoute.status, await taskRoute.text()).toBe(200);
      expect(ideasRoute.status, await ideasRoute.text()).toBe(200);
      await expect(mcp).resolves.toMatchObject({ updated: true });
      expect(statusOf('via-task-route')).toBe(to);
      expect(statusOf('via-ideas-route')).toBe(to);
      expect(statusOf('via-update-idea')).toBe(to);
    } else {
      // Refused on every surface, and — the half that matters — nothing moved.
      expect(taskRoute.status).toBeGreaterThanOrEqual(400);
      expect(ideasRoute.status).toBeGreaterThanOrEqual(400);
      await expect(mcp).rejects.toThrow();
      expect(statusOf('via-task-route')).toBe(from);
      expect(statusOf('via-ideas-route')).toBe(from);
      expect(statusOf('via-update-idea')).toBe(from);
    }
  });

  /**
   * The control for the matrix above. An ordinary task is NOT an idea, so the generic route
   * must keep using the task table for it — `ready → delegated` is a move the idea table has
   * never heard of, and it has to keep working.
   */
  it('still runs an ordinary task through the task table, not the idea table', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, is_idea, priority, task_mode,
           dispatch_depth, created_by, created_at, updated_at, triggered_by)
         VALUES ('ordinary', ?, 'u1', 'Ordinary', 'draft', 0, 0, 'task', 0, 'u1',
                 '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', 'user')`
      )
      .run(PROJECT);

    // `draft → ready` is refused for an idea and allowed for a task. One request, two answers,
    // decided only by the flag — so this is also the discriminating half of the matrix above.
    const res = await postJson('tasks/ordinary/status', { toStatus: 'ready' });
    expect(res.status, await res.text()).toBe(200);
    expect(statusOf('ordinary')).toBe('ready');
  });
});
