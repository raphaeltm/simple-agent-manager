import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  currentUserId: 'admin-user',
  currentDb: null as unknown,
  listActivityEvents: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => mocks.currentDb,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => mocks.currentUserId,
}));

vi.mock('../../../src/services/project-data', () => ({
  listActivityEvents: mocks.listActivityEvents,
}));

const { activityRoutes } = await import('../../../src/routes/activity');

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'owner-user',
    name: 'Shared project',
    description: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  } as schema.Project;
}

function makeMember(overrides: Partial<schema.ProjectMember> = {}): schema.ProjectMember {
  return {
    projectId: 'proj-1',
    userId: 'admin-user',
    role: 'admin',
    status: 'active',
    invitedBy: 'owner-user',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeDb(dataByTable: Map<unknown, unknown[]>) {
  let currentTable: unknown = null;
  const chain = {
    from: (table: unknown) => {
      currentTable = table;
      return chain;
    },
    where: () => chain,
    limit: () => Promise.resolve(dataByTable.get(currentTable) ?? []),
  };
  return {
    select: () => chain,
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/activity', activityRoutes);
  return app;
}

describe('shared project route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = 'admin-user';
    mocks.listActivityEvents.mockResolvedValue({ events: [], nextCursor: null });
  });

  it('allows an active admin member to read project activity', async () => {
    mocks.currentDb = makeDb(
      new Map([
        [schema.projects, [makeProject()]],
        [schema.projectMembers, [makeMember()]],
      ])
    );

    const response = await buildApp().request('/api/projects/proj-1/activity', {}, {
      DATABASE: {},
    } as Env);

    expect(response.status).toBe(200);
    expect(mocks.listActivityEvents).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      null,
      50,
      null,
      null
    );
  });

  it('rejects non-members before reading project activity', async () => {
    mocks.currentDb = makeDb(
      new Map([
        [schema.projects, [makeProject()]],
        [schema.projectMembers, []],
      ])
    );

    const response = await buildApp().request('/api/projects/proj-1/activity', {}, {
      DATABASE: {},
    } as Env);

    expect(response.status).toBe(404);
    expect(mocks.listActivityEvents).not.toHaveBeenCalled();
  });
});
