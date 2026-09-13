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
  resolveLiveAgentSessionForChat: vi.fn(),
  cancelAgentSessionOnNode: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
  /** Ordered log of the cross-boundary calls, so ordering can be asserted. */
  calls: [] as string[],
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
vi.mock('../../../src/routes/chat-workspace-resolver', () => ({
  resolveLiveWorkspaceForSession: vi.fn(),
  resolveLiveAgentSessionForChat: (...args: unknown[]) =>
    mocks.resolveLiveAgentSessionForChat(...args),
}));
vi.mock('../../../src/services/node-agent', () => ({
  cancelAgentSessionOnNode: (...args: unknown[]) => mocks.cancelAgentSessionOnNode(...args),
  stopAgentSessionOnNode: (...args: unknown[]) => mocks.stopAgentSessionOnNode(...args),
  // Real value, not a stub: the assertion below checks the route picks the
  // BACKGROUND tier rather than the interactive 30s one.
  getNodeAgentBackgroundRequestTimeoutMs: () => 5_000,
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
    mocks.calls.length = 0;
    mocks.cleanupWorkspaceForDeletion.mockResolvedValue(undefined);
    mocks.cleanupTerminalTaskResources.mockImplementation(async () => {
      mocks.calls.push('cleanupTerminalTaskResources');
    });
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-stop-1' });
    mocks.stopSession.mockResolvedValue(undefined);
    // Default: the dominant UI path archives an ALREADY-SLEEPING session, whose
    // workspace is long gone, so the resolver throws by design.
    mocks.resolveLiveAgentSessionForChat.mockRejectedValue(
      new Error('No active workspace found for this session')
    );
    mocks.cancelAgentSessionOnNode.mockImplementation(async () => {
      mocks.calls.push('cancelAgentSessionOnNode');
      return { success: true, status: 200 };
    });
    mocks.stopAgentSessionOnNode.mockImplementation(async () => {
      mocks.calls.push('stopAgentSessionOnNode');
      return {};
    });
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
      destructiveSessionEnd: true,
      logContext: {
        projectId: 'project-stop-1',
        sessionId: 'session-task-backed-1',
        stopPath: 'task-session',
      },
    });
  });

  /**
   * Archiving used to be silent from the VM's point of view: the control plane
   * cancelled the task row and deleted the workspace while the agent kept
   * running — and kept spending tokens — until teardown reaped it.
   */
  describe('agent stop signal', () => {
    function seedLiveSession() {
      const db = buildDb([[{ id: 'task-live-1', status: 'in_progress', errorMessage: null }]]);
      vi.mocked(drizzle).mockReturnValue(db as never);
      mocks.ensureSessionTaskBacked.mockResolvedValue({ id: 'task-live-1' });
      mocks.getSession.mockResolvedValue({
        id: 'session-live-1',
        workspaceId: 'workspace-live-1',
        taskId: 'task-live-1',
        createdByUserId: 'user-stop-1',
        status: 'active',
      });
      mocks.resolveLiveAgentSessionForChat.mockResolvedValue({
        workspace: {
          id: 'workspace-live-1',
          nodeId: 'node-live-1',
          nodeStatus: 'running',
          nodeRuntime: 'vm',
        },
        agentSession: { id: 'acp-live-1' },
      });
      return db;
    }

    function stopRequest(sessionId: string) {
      return new Request(
        `https://api.test/api/projects/project-stop-1/sessions/${sessionId}/stop`,
        { method: 'POST' }
      );
    }

    it('signals the agent BEFORE tearing the workspace down', async () => {
      seedLiveSession();

      const response = await createApp().fetch(stopRequest('session-live-1'), {
        DATABASE: {},
      } as Env);

      expect(response.status).toBe(200);
      // Ordering is the point: once the workspace row is gone there is no node
      // left to resolve, so a signal issued after teardown can never land.
      expect(mocks.calls).toEqual([
        'cancelAgentSessionOnNode',
        'stopAgentSessionOnNode',
        'cleanupTerminalTaskResources',
      ]);
      // Both calls, not just the first: a wrong id passed only to the stop half
      // would otherwise go unnoticed. The timeout must be the BACKGROUND tier —
      // nothing here is awaited for a decision, so inheriting the interactive 30s
      // budget would add up to a minute of latency to a foreground archive
      // against an unreachable node.
      const expectedArgs = [
        'node-live-1',
        'workspace-live-1',
        'acp-live-1',
        expect.anything(),
        'user-stop-1',
        { requestTimeoutMs: expect.any(Number) },
      ];
      expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledWith(...expectedArgs);
      expect(mocks.stopAgentSessionOnNode).toHaveBeenCalledWith(...expectedArgs);

      const cancelTimeout = mocks.cancelAgentSessionOnNode.mock.calls[0]?.[5]?.requestTimeoutMs;
      expect(cancelTimeout).toBeLessThan(30_000);
    });

    it('still archives when there is no live workspace to signal', async () => {
      // The dominant UI path: Archive is only offered once the session is
      // already sleeping, so the resolver throws a 404 by design.
      const db = buildDb([[{ id: 'task-asleep-1', status: 'in_progress', errorMessage: null }]]);
      vi.mocked(drizzle).mockReturnValue(db as never);
      mocks.ensureSessionTaskBacked.mockResolvedValue({ id: 'task-asleep-1' });
      mocks.getSession.mockResolvedValue({
        id: 'session-asleep-1',
        workspaceId: null,
        taskId: 'task-asleep-1',
        createdByUserId: 'user-stop-1',
        status: 'sleeping',
      });

      const response = await createApp().fetch(stopRequest('session-asleep-1'), {
        DATABASE: {},
      } as Env);

      expect(response.status).toBe(200);
      expect(mocks.cancelAgentSessionOnNode).not.toHaveBeenCalled();
      // Absence assertion paired with a positive one (.claude/rules/62 §5):
      // "nothing was signalled" must not also be satisfiable by "archive broke".
      expect(mocks.cleanupTerminalTaskResources).toHaveBeenCalledWith(
        expect.anything(),
        'task-asleep-1',
        expect.objectContaining({ status: 'cancelled', destructiveSessionEnd: true })
      );
    });

    it('archives even when the agent refuses the stop signal', async () => {
      seedLiveSession();
      mocks.cancelAgentSessionOnNode.mockRejectedValue(new Error('node unreachable'));

      const response = await createApp().fetch(stopRequest('session-live-1'), {
        DATABASE: {},
      } as Env);

      expect(response.status).toBe(200);
      expect(mocks.calls).toEqual(['cleanupTerminalTaskResources']);
      expect(mocks.stopSession).toHaveBeenCalled();
    });

    /**
     * Guards the written rejection in the task file: `/stop` is the destructive
     * Archive path, so it must keep discarding the seven-day restore state.
     * Flipping this would leak the snapshot + R2 objects and, for an already
     * `completed` task, take `cleanupTerminalTaskResources`' early-return sleep
     * branch and skip teardown entirely.
     */
    it('keeps destructiveSessionEnd set for the archive path', async () => {
      seedLiveSession();

      await createApp().fetch(stopRequest('session-live-1'), { DATABASE: {} } as Env);

      expect(mocks.cleanupTerminalTaskResources).toHaveBeenCalledWith(
        expect.anything(),
        'task-live-1',
        expect.objectContaining({ destructiveSessionEnd: true })
      );
    });
  });
});
