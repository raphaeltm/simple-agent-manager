/**
 * `GET /api/projects/:projectId/tasks/:taskId/receipt` through the real `tasksRoutes` mount and
 * the production error handler, on a real SQL engine. Session auth is replaced by a fixed viewer
 * (the receipt has no auth of its own: it relies on `requireAuth` + `requireApproved` and the
 * operation's membership check). Proves the mount, the 404 mapping for foreign and missing
 * tasks with identical bodies, the outsider refusal, and `Cache-Control: no-store`.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({ id: 'owner' }));
vi.mock('../../../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
    getUserId: () => viewer.id,
  };
});
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getRunReceiptFacts: vi.fn(async () => null),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { tasksRoutes } from '../../../src/routes/tasks';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('GET /api/projects/:projectId/tasks/:taskId/receipt', () => {
  let sqlite: Database.Database;
  let env: Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects/:projectId/tasks', tasksRoutes);

  beforeEach(() => {
    viewer.id = 'owner';
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app'), ('foreign', 'Other', 'acme/other');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('foreign','outsider','owner','active');
      INSERT INTO tasks (id, project_id, user_id, created_by, title, status, created_at, updated_at) VALUES
        ('task-own', 'p', 'owner', 'owner', 'Own run', 'completed', '2026-11-15T10:00:00.000Z', '2026-11-15T10:00:00.000Z'),
        ('task-foreign', 'foreign', 'outsider', 'outsider', 'Foreign run', 'completed', '2026-11-15T10:00:00.000Z', '2026-11-15T10:00:00.000Z');
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  const get = (projectId: string, taskId: string) =>
    app.request(`/api/projects/${projectId}/tasks/${taskId}/receipt`, {}, env);

  it('returns the owner’s receipt, uncached', async () => {
    const response = await get('p', 'task-own');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as { taskId: string; title: string; tokens: unknown };
    expect(body).toMatchObject({
      taskId: 'task-own',
      title: 'Own run',
      tokens: { state: 'not_reported' },
    });
  });

  it('answers a foreign task and a missing task with the same 404', async () => {
    const foreign = await get('p', 'task-foreign');
    const missing = await get('p', 'task-missing');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it('refuses a caller who is not a member of the project', async () => {
    viewer.id = 'outsider';
    const response = await get('p', 'task-own');
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(await response.json())).not.toContain('Own run');
  });
});
