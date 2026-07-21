import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  getOwnedWorkspace: vi.fn(),
  getOwnedNode: vi.fn(),
  resumeVmAgentContainer: vi.fn(),
  updateSet: vi.fn(),
  session: {
    id: 'agent-session-1',
    workspaceId: 'workspace-1',
    userId: 'user-1',
    status: 'error',
    label: 'Instant',
    agentType: 'codex',
    agentProfileId: null,
    skillId: null,
    worktreePath: null,
    stoppedAt: null,
    suspendedAt: null,
    errorMessage: 'Runtime unavailable',
    lastPrompt: null,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  },
}));

vi.mock('../../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: vi.fn().mockResolvedValue({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'Test User',
          role: 'user',
          status: 'active',
        },
        session: { id: 'auth-session-1', expiresAt: new Date('2030-01-01T00:00:00Z') },
      }),
    },
  }),
}));

vi.mock('../../../src/routes/workspaces/_helpers', () => ({
  assertNodeOperational: vi.fn(),
  getOwnedWorkspace: mocks.getOwnedWorkspace,
  getOwnedNode: mocks.getOwnedNode,
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vi.fn(),
  resumeAgentSessionOnNode: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
  suspendAgentSessionOnNode: vi.fn(),
}));

vi.mock('../../../src/services/vm-agent-container', () => ({
  resumeVmAgentContainer: mocks.resumeVmAgentContainer,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          fields && 'value' in fields
            ? { get: () => Promise.resolve(undefined) }
            : { limit: () => Promise.resolve([mocks.session]) },
      }),
    }),
    update: () => ({
      set: (values: unknown) => {
        mocks.updateSet(values);
        return { where: () => Promise.resolve() };
      },
    }),
  }),
}));

async function createTestApp() {
  const { agentSessionRoutes } = await import('../../../src/routes/workspaces/agent-sessions');
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/workspaces', agentSessionRoutes);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.statusCode as 409);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
  });
  return app;
}

describe('agent session Instant recovery route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.status = 'error';
    mocks.session.errorMessage = 'Runtime unavailable';
    mocks.getOwnedWorkspace.mockResolvedValue({
      id: 'workspace-1',
      userId: 'user-1',
      nodeId: 'node-1',
    });
    mocks.getOwnedNode.mockResolvedValue({
      id: 'node-1',
      userId: 'user-1',
      runtime: 'cf-container',
      status: 'error',
    });
    mocks.resumeVmAgentContainer.mockResolvedValue({
      ok: true,
      status: 'running',
      degraded: false,
    });
  });

  it('marks the session running only after the container reports recovery', async () => {
    let resolveRecovery!: (value: unknown) => void;
    mocks.resumeVmAgentContainer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecovery = resolve;
        })
    );
    const app = await createTestApp();

    const responsePromise = app.request(
      '/api/workspaces/workspace-1/agent-sessions/agent-session-1/resume',
      { method: 'POST' },
      { DATABASE: {} } as Env
    );
    await vi.waitFor(() =>
      expect(mocks.resumeVmAgentContainer).toHaveBeenCalledWith(
        expect.objectContaining({ DATABASE: {} }),
        'node-1'
      )
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();

    resolveRecovery({ ok: true, status: 'running', degraded: false });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        errorMessage: null,
      })
    );
    expect(await response.json()).toEqual(expect.objectContaining({ status: 'running' }));
  });

  it('returns a stable degraded error without falsely marking the session running', async () => {
    mocks.resumeVmAgentContainer.mockResolvedValueOnce({
      ok: false,
      status: 'degraded',
      degraded: true,
      code: 'SNAPSHOT_RESTORE_FAILED',
      message:
        'The Instant session could not restore its saved state. Start a new session to continue.',
    });
    const app = await createTestApp();

    const response = await app.request(
      '/api/workspaces/workspace-1/agent-sessions/agent-session-1/resume',
      { method: 'POST' },
      { DATABASE: {} } as Env
    );

    const body = await response.json();
    expect(body).toEqual({
      error: 'SNAPSHOT_RESTORE_FAILED',
      message:
        'The Instant session could not restore its saved state. Start a new session to continue.',
    });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('preserves an explicit stop as terminal', async () => {
    mocks.resumeVmAgentContainer.mockResolvedValueOnce({
      ok: false,
      status: 'stopped',
      degraded: false,
      code: 'RUNTIME_STOPPED',
      message: 'This Instant session was stopped and cannot be resumed.',
    });
    const app = await createTestApp();

    const response = await app.request(
      '/api/workspaces/workspace-1/agent-sessions/agent-session-1/resume',
      { method: 'POST' },
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(410);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
