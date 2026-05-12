import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { chatRoutes } from '../../../src/routes/chat';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  requireOwnedProject: vi.fn(),
  cancelAgentSessionOnNode: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: mocks.drizzle,
}));

vi.mock('@simple-agent-manager/shared', () => ({
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT: 3000,
  DEFAULT_CHAT_COMPACT_MODE: true,
  DEFAULT_WORKSPACE_PROFILE: 'full',
  isTaskExecutionStep: () => true,
  isTaskMode: (v: unknown) => v === 'task' || v === 'conversation',
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      avatarUrl: null,
      role: 'user',
      status: 'active',
    },
    session: {
      id: 'session-1',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    },
  }),
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));

vi.mock('../../../src/services/project-data', () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  forwardWebSocket: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  resetIdleCleanup: vi.fn(),
  listAcpSessions: vi.fn(),
  stopSession: vi.fn(),
  linkSessionIdea: vi.fn(),
  unlinkSessionIdea: vi.fn(),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn(async () => undefined),
}));

vi.mock('../../../src/schemas', () => ({
  CreateChatSessionSchema: {},
  LinkTaskToChatSchema: {},
  SendChatMessageSchema: {},
  parseOptionalBody: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  cancelAgentSessionOnNode: mocks.cancelAgentSessionOnNode,
}));

describe('POST /sessions/:sessionId/cancel', () => {
  let app: Hono<{ Bindings: Env }>;

  /** Helper to build a drizzle mock that returns workspace + agent session rows. */
  function setupDrizzle(opts: {
    workspace?: { id: string; nodeId: string | null; nodeStatus: string | null } | null;
    agentSession?: { id: string } | null;
  }) {
    let callCount = 0;
    const selectMock = vi.fn().mockImplementation(() => {
      callCount++;
      const currentCall = callCount;
      return {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(
                currentCall === 1 ? (opts.workspace ? [opts.workspace] : []) : []
              ),
            }),
          }),
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              currentCall === 2 ? (opts.agentSession ? [opts.agentSession] : []) : []
            ),
          }),
        }),
      };
    });
    mocks.drizzle.mockReturnValue({ select: selectMock });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOwnedProject.mockResolvedValue({ id: 'proj-1', userId: 'user-1' });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects/:projectId/sessions', chatRoutes);
  });

  it('cancels a running prompt successfully', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: true, status: 200 });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/cancel',
      { method: 'POST' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('cancelled');
    expect(body.message).toBe('Prompt cancel signal sent');
    expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1', 'ws-1', 'agent-sess-1',
      expect.anything(), 'user-1',
    );
  });

  it('returns idle status when no prompt is in flight (409)', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status: 409 });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/cancel',
      { method: 'POST' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('idle');
    expect(body.message).toBe('No prompt in flight to cancel');
  });

  it('returns 404 when no active workspace is found', async () => {
    setupDrizzle({ workspace: null, agentSession: null });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/cancel',
      { method: 'POST' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(404);
  });

  it('returns 409 when node is not running', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'destroyed' },
      agentSession: null,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/cancel',
      { method: 'POST' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(409);
  });

  it('returns 404 when no running agent session is found', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: null,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/cancel',
      { method: 'POST' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(404);
  });
});
