import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  cleanupWorkspaceForDeletion: vi.fn(),
  cleanupTerminalTaskResources: vi.fn(),
  ensureSessionTaskBacked: vi.fn(),
  getSession: vi.fn(),
  requireProjectCapability: vi.fn(),
  stopSession: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-stop-1',
  getAuth: () => ({
    user: { id: 'user-stop-1', role: 'user' },
    session: { id: 'auth-session-1' },
  }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-data', () => ({
  createSession: vi.fn(),
  forwardWebSocket: vi.fn(),
  getMessages: vi.fn(),
  getMessageToolContent: vi.fn(),
  getSession: mocks.getSession,
  getSessionState: vi.fn(),
  linkSessionIdea: vi.fn(),
  listAcpSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listSessionIdeas: vi.fn().mockResolvedValue({ ideas: [] }),
  listSessions: vi.fn(),
  resetIdleCleanup: vi.fn(),
  stopSession: mocks.stopSession,
  unlinkSessionIdea: vi.fn(),
}));
vi.mock('../../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: (...args: unknown[]) => mocks.cleanupWorkspaceForDeletion(...args),
}));
vi.mock('../../../src/services/session-task-repair', () => ({
  ensureSessionTaskBacked: (...args: unknown[]) => mocks.ensureSessionTaskBacked(...args),
}));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: (...args: unknown[]) => mocks.cleanupTerminalTaskResources(...args),
}));

import { chatRoutes } from '../../../src/routes/chat';

function buildDb(selectResults: unknown[][]) {
  const select = vi.fn(() => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
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

  return { insert, select, update };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

describe('POST /api/projects/:projectId/sessions/:sessionId/stop cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanupWorkspaceForDeletion.mockResolvedValue(undefined);
    mocks.cleanupTerminalTaskResources.mockResolvedValue(undefined);
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-stop-1' });
    mocks.stopSession.mockResolvedValue(undefined);
  });

  it('repairs a taskless instant session before unified task cleanup', async () => {
    const db = buildDb([[{ id: 'task-repaired-1', status: 'in_progress', errorMessage: null }]]);
    mocks.ensureSessionTaskBacked.mockResolvedValue({ id: 'task-repaired-1' });
    vi.mocked(drizzle).mockReturnValue(db as never);
    mocks.getSession.mockResolvedValue({
      id: 'session-stop-1',
      workspaceId: 'workspace-stop-1',
      taskId: null,
      createdByUserId: 'user-stop-1',
      status: 'active',
    });

    const response = await createApp().fetch(
      new Request('https://api.test/api/projects/project-stop-1/sessions/session-stop-1/stop', {
        method: 'POST',
      }),
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'stopped',
      workspaceDeleted: true,
    });
    expect(mocks.ensureSessionTaskBacked).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ sessionId: 'session-stop-1' })
    );
    expect(mocks.cleanupTerminalTaskResources).toHaveBeenCalledWith(
      expect.anything(),
      'task-repaired-1',
      expect.objectContaining({ status: 'cancelled' })
    );
    expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
    expect(mocks.stopSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-stop-1',
      'session-stop-1'
    );
  });

  it('tears down task-backed session runtime resources', async () => {
    const db = buildDb([
      [
        {
          id: 'task-1',
          status: 'in_progress',
          errorMessage: null,
        },
      ],
    ]);
    vi.mocked(drizzle).mockReturnValue(db as never);
    mocks.ensureSessionTaskBacked.mockResolvedValue({ id: 'task-1' });
    mocks.getSession.mockResolvedValue({
      id: 'session-task-backed-1',
      workspaceId: 'workspace-task-backed-1',
      taskId: 'task-1',
      createdByUserId: 'user-stop-1',
      status: 'active',
    });

    const response = await createApp().fetch(
      new Request(
        'https://api.test/api/projects/project-stop-1/sessions/session-task-backed-1/stop',
        {
          method: 'POST',
        }
      ),
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'stopped',
      workspaceDeleted: true,
    });
    expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
    expect(mocks.stopSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-stop-1',
      'session-task-backed-1'
    );
    expect(mocks.cleanupTerminalTaskResources).toHaveBeenCalledWith(expect.anything(), 'task-1', {
      status: 'cancelled',
      errorMessage: 'Archived by user',
      logContext: {
        projectId: 'project-stop-1',
        sessionId: 'session-task-backed-1',
        stopPath: 'task-session',
      },
    });
  });
});
