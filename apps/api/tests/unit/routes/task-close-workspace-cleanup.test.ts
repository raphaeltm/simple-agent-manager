import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  cleanupWorkspaceForDeletion: vi.fn(),
  recordActivityEvent: vi.fn(),
  requireProjectCapability: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-close-1',
}));
vi.mock('../../../src/middleware/project-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/project-auth')>();
  return {
    ...actual,
    requireProjectCapability: mocks.requireProjectCapability,
  };
});
vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: (...args: unknown[]) => mocks.recordActivityEvent(...args),
}));
vi.mock('../../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: (...args: unknown[]) => mocks.cleanupWorkspaceForDeletion(...args),
}));

import { crudRoutes } from '../../../src/routes/tasks/crud';

function buildDb(selectResults: unknown[][]) {
  const select = vi.fn(() => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(selectResults.shift() ?? [])),
    };
    return chain;
  });
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => Promise.resolve()),
  }));

  return { select, update, insert };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/tasks', crudRoutes);
  return app;
}

describe('POST /api/projects/:projectId/tasks/:taskId/close workspace cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-close-1' });
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.cleanupWorkspaceForDeletion.mockResolvedValue(undefined);
  });

  it('awaits immediate cleanup for the closing conversation task linked workspace', async () => {
    const task = {
      id: 'task-close-1',
      projectId: 'project-close-1',
      userId: 'user-close-1',
      status: 'in_progress',
      taskMode: 'conversation',
      workspaceId: 'workspace-close-1',
    };
    const workspace = {
      id: 'workspace-close-1',
      userId: 'user-close-1',
      projectId: 'project-close-1',
      nodeId: 'node-close-1',
      chatSessionId: 'session-close-1',
      status: 'running',
    };
    const db = buildDb([[task], [workspace]]);
    vi.mocked(drizzle).mockReturnValue(db as never);

    const waitUntil = vi.fn();
    const response = await createApp().fetch(
      new Request('https://api.test/api/projects/project-close-1/tasks/task-close-1/close', {
        method: 'POST',
      }),
      { DATABASE: {} } as Env,
      { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'completed' });

    expect(mocks.cleanupWorkspaceForDeletion).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupWorkspaceForDeletion).toHaveBeenCalledWith(expect.objectContaining({
      db,
      workspace,
      userId: 'user-close-1',
      logContext: expect.objectContaining({
        taskId: 'task-close-1',
        projectId: 'project-close-1',
        closePath: 'conversation',
      }),
    }));
    expect(db.update).toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('does not clean up a workspace when the task belongs to a different project route', async () => {
    const task = {
      id: 'task-close-cross-project',
      projectId: 'project-real',
      userId: 'user-close-1',
      status: 'in_progress',
      taskMode: 'conversation',
      workspaceId: 'workspace-real',
    };
    const db = buildDb([[task]]);
    vi.mocked(drizzle).mockReturnValue(db as never);

    const response = await createApp().fetch(
      new Request('https://api.test/api/projects/project-route/tasks/task-close-cross-project/close', {
        method: 'POST',
      }),
      { DATABASE: {} } as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    );

    expect(response.status).toBe(404);
    expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
  });
});
