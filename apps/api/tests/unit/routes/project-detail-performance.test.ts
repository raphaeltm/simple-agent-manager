import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { registerProjectDetailRoute } from '../../../src/routes/projects/project-detail';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const fixtures = vi.hoisted(() => ({
  sessions: vi.fn(),
  activity: vi.fn(),
  project: {
    id: 'project-1',
    userId: 'user-1',
    name: 'Project',
    repository: 'org/repo',
    defaultBranch: 'main',
    activeSessionCount: 2,
  },
}));
vi.mock('../../../src/middleware/auth', () => ({ getUserId: () => 'user-1' }));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: async () => fixtures.project,
}));
vi.mock('../../../src/services/project-data', () => ({
  listSessions: fixtures.sessions,
  listActivityEvents: fixtures.activity,
}));
vi.mock('../../../src/services/admin-settings', () => ({ resolveAdminSetting: async () => 100 }));

let sqlite: Database.Database;
let app: Hono<{ Bindings: Env }>;
let env: Env;
beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  app = new Hono<{ Bindings: Env }>();
  registerProjectDetailRoute(app);
  fixtures.sessions
    .mockReset()
    .mockResolvedValue({ sessions: [{ id: 'session-1', status: 'active' }] });
  fixtures.activity.mockReset().mockResolvedValue({ events: [{ id: 'activity-1' }] });
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe('project detail recent data is opt-in and bounded', () => {
  it('loads the normal project page without any DO calls', async () => {
    const response = await app.request('/project-1', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'project-1',
      recentSessions: [],
      recentActivity: [],
      summary: { activeSessionCount: 2 },
    });
    expect(fixtures.sessions).not.toHaveBeenCalled();
    expect(fixtures.activity).not.toHaveBeenCalled();
  });
  it('returns recent sessions for the CLI include=recent request', async () => {
    const response = await app.request('/project-1?include=recent', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recentSessions: [{ id: 'session-1' }],
      recentActivity: [{ id: 'activity-1' }],
    });
    expect(fixtures.sessions).toHaveBeenCalledTimes(1);
    expect(fixtures.activity).toHaveBeenCalledTimes(1);
  });
  it('returns project content when the opted-in DO reads never settle', async () => {
    vi.useFakeTimers();
    fixtures.sessions.mockImplementation(() => new Promise(() => {}));
    const pending = app.request('/project-1?include=recent', {}, env);
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'project-1', recentSessions: [] });
    expect(fixtures.sessions).toHaveBeenCalledTimes(1);
  });
});
