/**
 * Session–idea linking through the real `chatRoutes` mount (`routes/chat-ideas.ts`), with the
 * task lookups running against a real SQLite engine so the project-scope predicate is exercised.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  getIdeasForSession: vi.fn(),
  linkSessionIdea: vi.fn(),
  unlinkSessionIdea: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/middleware/auth')>()),
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));

vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getIdeasForSession: mocks.getIdeasForSession,
  linkSessionIdea: mocks.linkSessionIdea,
  unlinkSessionIdea: mocks.unlinkSessionIdea,
}));

const { chatRoutes } = await import('../../../src/routes/chat');

const SESSIONS = '/api/projects/project-1/sessions';

function makeEnv(): Env {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.tasks]);
  const insert = sqlite.prepare(
    'INSERT INTO tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)'
  );
  insert.run('idea-1', 'project-1', 'Tighten proxy', 'draft');
  insert.run('idea-2', 'project-1', 'Split observability', 'ready');
  insert.run('foreign-idea', 'project-2', 'Another project', 'draft');
  return { DATABASE: createSqliteD1(sqlite) } as Env;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

function link(env: Env, body: unknown) {
  return makeApp().request(
    `${SESSIONS}/session-1/ideas`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireProjectAccess.mockResolvedValue({ id: 'project-1' });
  mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
  mocks.linkSessionIdea.mockResolvedValue(undefined);
  mocks.unlinkSessionIdea.mockResolvedValue(undefined);
});

describe('session–idea routes mounted under chatRoutes', () => {
  it('lists linked ideas with their task title and status', async () => {
    mocks.getIdeasForSession.mockResolvedValue([
      { taskId: 'idea-1', context: 'from review', createdAt: 10 },
      { taskId: 'idea-gone', context: null, createdAt: 20 },
    ]);

    const res = await makeApp().request(`${SESSIONS}/session-1/ideas`, {}, makeEnv());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ideas: [
        {
          taskId: 'idea-1',
          title: 'Tighten proxy',
          status: 'draft',
          context: 'from review',
          linkedAt: 10,
        },
        { taskId: 'idea-gone', title: null, status: null, context: null, linkedAt: 20 },
      ],
      count: 2,
    });
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'user-1'
    );
    expect(mocks.getIdeasForSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'session-1'
    );
  });

  it('links an idea from the same project', async () => {
    const env = makeEnv();

    const res = await link(env, { taskId: ' idea-2 ', context: '  why it matters  ' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ linked: true });
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'user-1',
      'task:write'
    );
    expect(mocks.linkSessionIdea).toHaveBeenCalledWith(
      env,
      'project-1',
      'session-1',
      'idea-2',
      'why it matters'
    );
  });

  it("refuses to link another project's idea by id", async () => {
    const res = await link(makeEnv(), { taskId: 'foreign-idea' });

    expect(res.status).toBe(404);
    expect(mocks.linkSessionIdea).not.toHaveBeenCalled();
  });

  it('rejects a link request without a taskId', async () => {
    const res = await link(makeEnv(), { context: 'no task' });

    expect(res.status).toBe(400);
    expect(mocks.linkSessionIdea).not.toHaveBeenCalled();
  });

  it('unlinks an idea', async () => {
    const env = makeEnv();

    const res = await makeApp().request(
      `${SESSIONS}/session-1/ideas/idea-1`,
      { method: 'DELETE' },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: true });
    expect(mocks.unlinkSessionIdea).toHaveBeenCalledWith(env, 'project-1', 'session-1', 'idea-1');
  });
});
