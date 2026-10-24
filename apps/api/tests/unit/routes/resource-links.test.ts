import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

const snapshots = vi.hoisted(() => vi.fn());
vi.mock('../../../src/middleware/auth', async (original) => ({
  ...(await original<typeof import('../../../src/middleware/auth')>()),
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user1',
}));
vi.mock('../../../src/middleware/project-auth', async (original) => ({
  ...(await original<typeof import('../../../src/middleware/project-auth')>()),
  requireProjectAccess: vi.fn().mockResolvedValue({ id: 'p1' }),
}));
vi.mock('../../../src/services/project-data', async (original) => ({
  ...(await original<typeof import('../../../src/services/project-data')>()),
  getResourceLinkSnapshot: snapshots,
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: vi
    .fn()
    .mockResolvedValue([
      { value: 300000 },
      { value: 100 },
      { value: 100 },
      { value: 100000 },
      { value: 50 },
      { value: 500 },
    ]),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { resourceLinkRoutes } from '../../../src/routes/resource-links';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('linked work REST reads', () => {
  it('serves all three contracts and gives matching 404s for missing/foreign ids', async () => {
    const db = new Database(':memory:');
    try {
      createSchemaTables(db, [
        schema.projects,
        schema.tasks,
        schema.projectFiles,
        schema.taskPullRequestAssociations,
      ]);
      db.exec(`INSERT INTO tasks(id,project_id,title,status) VALUES
        ('idea-own','p1','Own','draft'),('idea-foreign','p2','Foreign','draft');
        INSERT INTO projects(id,repository) VALUES ('p1','owner/repo');
        INSERT INTO project_files(id,project_id,filename,directory) VALUES
        ('file-own','p1','own.md','/'),('file-foreign','p2','other.md','/')`);
      snapshots.mockImplementation(
        async (_env: Env, _project: string, kind: string, id: string) => ({
          exists: kind !== 'session' || id === 'session-own',
          links: [],
          sessions: [],
        })
      );
      const app = new Hono<{ Bindings: Env }>();
      app.onError(handleAppError);
      app.route('/api/projects/:projectId', resourceLinkRoutes);
      const env = { DATABASE: createSqliteD1(db) } as Env;
      const read = async (path: string) => app.request(`/api/projects/p1/${path}`, {}, env);
      const idea = await read('ideas/idea-own/links');
      expect(idea.status).toBe(200);
      expect(await idea.json()).toEqual({
        sessions: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
        files: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
        pullRequests: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
        relatedIdeas: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
      });
      expect((await read('ideas/idea-foreign/links')).status).toBe(404);
      expect((await read('ideas/missing/links')).status).toBe(404);
      expect((await read('sessions/session-own/links')).status).toBe(200);
      expect((await read('sessions/missing/links')).status).toBe(404);
      expect((await read('library/file-own/links')).status).toBe(200);
      expect((await read('library/file-foreign/links')).status).toBe(404);
      expect((await read('library/missing/links')).status).toBe(404);
    } finally {
      db.close();
    }
  });
});
