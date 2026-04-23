import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { chatRoutes } from '../../../src/routes/chat';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  requireOwnedProject: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  listAcpSessions: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: mocks.drizzle,
}));

vi.mock('@simple-agent-manager/shared', () => ({
  DEFAULT_WORKSPACE_PROFILE: 'full',
  isTaskExecutionStep: () => true,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));

vi.mock('../../../src/services/project-data', () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  forwardWebSocket: vi.fn(),
  getSession: mocks.getSession,
  getMessages: mocks.getMessages,
  resetIdleCleanup: vi.fn(),
  listAcpSessions: mocks.listAcpSessions,
  stopSession: vi.fn(),
  linkSessionIdea: vi.fn(),
  unlinkSessionIdea: vi.fn(),
}));

vi.mock('../../../src/schemas', () => ({
  CreateChatSessionSchema: {},
  LinkTaskToChatSchema: {},
  SendChatMessageSchema: {},
  parseOptionalBody: vi.fn(),
}));

describe('chatRoutes agent session routing', () => {
  let app: Hono<{ Bindings: Env }>;
  let orderBySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    orderBySpy = vi.fn(() => ({
      limit: vi.fn().mockResolvedValue([]),
    }));

    const queryBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      orderBy: orderBySpy,
    };

    mocks.drizzle.mockReturnValue({
      select: vi.fn().mockReturnValue(queryBuilder),
    });

    mocks.requireOwnedProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
    });

    mocks.getSession.mockResolvedValue({
      id: 'chat-1',
      workspaceId: 'ws-1',
      taskId: null,
      topic: 'Investigate routing',
      status: 'active',
      messageCount: 2,
      startedAt: 1,
      endedAt: null,
      createdAt: 1,
    });

    mocks.getMessages.mockResolvedValue({
      messages: [
        {
          id: 'msg-1',
          sessionId: 'chat-1',
          role: 'assistant',
          content: 'Persisted output',
          toolMetadata: null,
          createdAt: 1,
          sequence: 1,
        },
      ],
      hasMore: false,
    });

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

  it('resolves agentSessionId from the ACP session linked to the chat session', async () => {
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [
        {
          id: 'acp-chat-1',
          chatSessionId: 'chat-1',
          status: 'completed',
        },
      ],
      total: 1,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.session.agentSessionId).toBe('acp-chat-1');
    expect(mocks.listAcpSessions).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      { chatSessionId: 'chat-1', limit: 1 },
    );
    expect(orderBySpy).not.toHaveBeenCalled();
  });

  it('returns a null agentSessionId when no ACP session is linked to the chat session', async () => {
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [],
      total: 0,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.session.agentSessionId).toBeNull();
  });
});
