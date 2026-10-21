/**
 * GET/PATCH /api/projects/:projectId/agent-profiles/picker through the real Hono route
 * and a real SQLite engine. Auth and project membership are stubbed; the window comes
 * from the `chat.profileUsageWindowDays` admin setting.
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
  resolveAdminSetting: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => mocks.userId,
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: vi.fn(),
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: mocks.resolveAdminSetting,
}));

import { agentProfileRoutes } from '../../../src/routes/agent-profiles';

const BASE = 'https://api.test.example.com/api/projects';
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe('agent profile picker routes', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = 'u1';
    mocks.resolveAdminSetting.mockResolvedValue(14);
    mocks.requireProjectAccess.mockImplementation(async (_db, projectId: string) => {
      if (projectId === 'p1') return { id: 'p1', userId: 'u1' };
      throw Object.assign(new Error('Project not found'), { statusCode: 404, error: 'NOT_FOUND' });
    });

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const insertProfile = sqlite.prepare(
      `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, created_at, updated_at)
       VALUES (?, 'p1', 'u1', ?, 'claude-code', 'auto', 0, ?, ?)`
    );
    insertProfile.run('prof-a', 'Opus', daysAgo(50), daysAgo(50));
    insertProfile.run('prof-b', 'Sol', daysAgo(50), daysAgo(50));
    const insertTask = sqlite.prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, triggered_by, dispatch_depth, agent_profile_hint, created_at)
       VALUES (?, 'p1', 'u1', 'chat', 'completed', 'user', 0, ?, ?)`
    );
    insertTask.run('t1', 'prof-a', daysAgo(2));
    insertTask.run('t2', 'prof-b', daysAgo(20)); // inside 30 days but outside the 14-day setting

    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
  });

  afterEach(() => sqlite.close());

  it('returns the caller’s usage within the admin-configured window, not a profile lookup', async () => {
    const res = await app.request(`${BASE}/p1/agent-profiles/picker`, { method: 'GET' }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: Array<{ profileId: string; chatCount: number }>;
      hiddenProfileIds: string[];
      usageWindowDays: number;
    };
    expect(body.usageWindowDays).toBe(14);
    expect(body.usage.map((entry) => [entry.profileId, entry.chatCount])).toEqual([['prof-a', 1]]);
    expect(body.hiddenProfileIds).toEqual([]);
    expect(mocks.resolveAdminSetting).toHaveBeenCalledWith(env, 'chat.profileUsageWindowDays');
    expect(res.headers.get('cache-control')).toContain('private');
  });

  it('rejects non-members on both methods without touching data', async () => {
    const getRes = await app.request(`${BASE}/p9/agent-profiles/picker`, { method: 'GET' }, env);
    const patchRes = await app.request(
      `${BASE}/p9/agent-profiles/picker`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide: ['prof-a'] }),
      },
      env
    );

    expect(getRes.status).toBe(404);
    expect(patchRes.status).toBe(404);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_picker_hidden').get()).toEqual({
      n: 0,
    });
  });

  it('hides and shows a profile for the caller and returns the new hidden set', async () => {
    const hideRes = await app.request(
      `${BASE}/p1/agent-profiles/picker`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide: ['prof-a', 'prof-b'] }),
      },
      env
    );
    expect(hideRes.status).toBe(200);
    expect(
      ((await hideRes.json()) as { hiddenProfileIds: string[] }).hiddenProfileIds.sort()
    ).toEqual(['prof-a', 'prof-b']);

    const showRes = await app.request(
      `${BASE}/p1/agent-profiles/picker`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unhide: ['prof-b'] }),
      },
      env
    );
    expect(await showRes.json()).toEqual({ hiddenProfileIds: ['prof-a'] });

    const stateRes = await app.request(`${BASE}/p1/agent-profiles/picker`, { method: 'GET' }, env);
    expect(((await stateRes.json()) as { hiddenProfileIds: string[] }).hiddenProfileIds).toEqual([
      'prof-a',
    ]);
  });

  it('rejects malformed bodies before writing', async () => {
    const res = await app.request(
      `${BASE}/p1/agent-profiles/picker`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide: 'prof-a' }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_picker_hidden').get()).toEqual({
      n: 0,
    });
  });
});
