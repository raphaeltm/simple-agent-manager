import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatRoutes } from '../../../src/routes/chat';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  requireOwnedProject: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  listAcpSessions: vi.fn(),
  persistError: vi.fn(async () => undefined),
  userRole: 'user',
}));

function makeTaskQuery(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn(),
  };
}

function makeProfileQuery(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makePersistedMessage(
  id: string,
  role: string,
  content: string,
  createdAt: number,
  sequence: number,
) {
  return {
    id,
    sessionId: 'chat-1',
    role,
    content,
    toolMetadata: null,
    createdAt,
    sequence,
  };
}

function createChatRoutesTestApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

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
  requireAuth: () => vi.fn((c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      avatarUrl: null,
      role: mocks.userRole,
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
  getSession: mocks.getSession,
  getMessages: mocks.getMessages,
  resetIdleCleanup: vi.fn(),
  listAcpSessions: mocks.listAcpSessions,
  stopSession: vi.fn(),
  linkSessionIdea: vi.fn(),
  unlinkSessionIdea: vi.fn(),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: mocks.persistError,
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
    mocks.userRole = 'user';

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
      messages: [makePersistedMessage('msg-1', 'assistant', 'Persisted output', 1, 1)],
      hasMore: false,
    });

    app = createChatRoutesTestApp();
  });

  async function requestTaskEmbed(input: {
    taskMode: 'task' | 'conversation';
    storedHint: string;
    profileRows: Array<{ id: string; name: string }>;
  }) {
    mocks.listAcpSessions.mockResolvedValue({ sessions: [], total: 0 });
    mocks.drizzle.mockReturnValue({
      select: vi
        .fn()
        .mockReturnValueOnce(makeTaskQuery([{
          id: 'task-1',
          status: 'in_progress',
          executionStep: 'agent_session',
          errorMessage: null,
          outputBranch: 'sam/feature-x',
          outputPrUrl: null,
          outputSummary: null,
          finalizedAt: null,
          taskMode: input.taskMode,
          agentProfileHint: input.storedHint,
        }]))
        .mockReturnValueOnce(makeProfileQuery(input.profileRows)),
    });

    mocks.getSession.mockResolvedValue({
      id: 'chat-1',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      topic: 'Test task embed',
      status: 'active',
      messageCount: 1,
      startedAt: 1,
      endedAt: null,
      createdAt: 1,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET' },
      { DATABASE: {} as D1Database } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.session.task).toBeDefined();
    return body.session.task;
  }

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
      { DATABASE: {} as D1Database },
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

  it('returns agentType from ACP session in the response', async () => {
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [
        {
          id: 'acp-chat-1',
          chatSessionId: 'chat-1',
          status: 'running',
          agentType: 'claude-code',
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
    expect(body.session.agentType).toBe('claude-code');
  });

  it('caps session detail message loads to the configured chat session limit', async () => {
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [],
      total: 0,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1?limit=50000',
      { method: 'GET' },
      {
        DATABASE: {} as D1Database,
        CHAT_SESSION_MESSAGE_LIMIT: '500',
      } as Env,
    );

    expect(response.status).toBe(200);
    expect(mocks.getMessages).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'chat-1',
      500,
      null,
      undefined,
      true,
    );
  });

  it('uses the default chat session limit (3000) when no limit is requested', async () => {
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
    expect(mocks.getMessages).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'chat-1',
      3000,
      null,
      undefined,
      true,
    );
  });

  it('does not record a load failure when ProjectData retries internally and returns session detail', async () => {
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [],
      total: 0,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET' },
      {
        DATABASE: {} as D1Database,
        OBSERVABILITY_DATABASE: {} as D1Database,
      } as Env,
    );

    expect(response.status).toBe(200);
    expect(mocks.persistError).not.toHaveBeenCalled();
  });

  it('returns a structured diagnostic response when session lookup fails', async () => {
    const loadError = new Error('Durable Object reset because its code was updated.');
    mocks.getSession.mockRejectedValue(loadError);

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET', headers: { 'User-Agent': 'vitest' } },
      {
        DATABASE: {} as D1Database,
        OBSERVABILITY_DATABASE: {} as D1Database,
      } as Env,
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: 'CHAT_SESSION_LOAD_FAILED',
      message: 'Failed to load chat session',
      requestId: expect.any(String),
      phase: 'get_session',
    });
    expect(body.details).toBeUndefined();
    expect(mocks.persistError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'api',
        level: 'error',
        message: 'chat.session_detail_load_failed',
        stack: expect.stringContaining('Durable Object reset because its code was updated.'),
        userId: 'user-1',
        userAgent: 'vitest',
        context: expect.objectContaining({
          requestId: body.requestId,
          route: 'GET /api/projects/:projectId/sessions/:sessionId',
          phase: 'get_session',
          projectId: 'proj-1',
          sessionId: 'chat-1',
          userId: 'user-1',
          errorName: 'Error',
          errorMessage: 'Durable Object reset because its code was updated.',
        }),
      }),
    );
  });

  it('returns safe diagnostics for regular users when message lookup fails', async () => {
    mocks.getMessages.mockRejectedValue(new Error('Malformed tool metadata'));

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET' },
      {
        DATABASE: {} as D1Database,
        OBSERVABILITY_DATABASE: {} as D1Database,
      } as Env,
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: 'CHAT_SESSION_LOAD_FAILED',
      message: 'Failed to load chat session',
      requestId: expect.any(String),
      phase: 'get_messages',
    });
    expect(body.details).toBeUndefined();
  });

  it('includes sanitized diagnostic details for admins when message lookup fails', async () => {
    mocks.userRole = 'admin';
    mocks.getMessages.mockRejectedValue(new Error('Malformed tool metadata'));

    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1',
      { method: 'GET' },
      {
        DATABASE: {} as D1Database,
        OBSERVABILITY_DATABASE: {} as D1Database,
      } as Env,
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'CHAT_SESSION_LOAD_FAILED',
      message: 'Failed to load chat session',
      requestId: expect.any(String),
      phase: 'get_messages',
      details: {
        errorName: 'Error',
        errorMessage: 'Malformed tool metadata',
        stack: expect.stringContaining('Malformed tool metadata'),
      },
    });
  });

  it('returns null agentType when ACP session has no agentType', async () => {
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [
        {
          id: 'acp-chat-1',
          chatSessionId: 'chat-1',
          status: 'running',
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
    expect(body.session.agentType).toBeNull();
  });

  it('resolves a task embed agentProfileHint profile ID to the profile name', async () => {
    const task = await requestTaskEmbed({
      taskMode: 'conversation',
      storedHint: 'profile-fast-001',
      profileRows: [{ id: 'profile-fast-001', name: 'Fast Profile' }],
    });

    expect(task.taskMode).toBe('conversation');
    expect(task.agentProfileHint).toBe('Fast Profile');
  });

  it('falls back to the raw task embed agentProfileHint when no profile matches', async () => {
    const task = await requestTaskEmbed({
      taskMode: 'task',
      storedHint: 'Legacy Free Text Profile',
      profileRows: [],
    });

    expect(task.agentProfileHint).toBe('Legacy Free Text Profile');
  });
});

describe('chatRoutes message list', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userRole = 'user';

    mocks.drizzle.mockReturnValue({
      select: vi.fn().mockReturnValue(makeTaskQuery([])),
    });

    mocks.requireOwnedProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
    });

    mocks.getSession.mockResolvedValue({
      id: 'chat-1',
      workspaceId: 'ws-1',
      taskId: null,
      topic: 'Timeline source',
      status: 'active',
      messageCount: 2,
      startedAt: 1,
      endedAt: null,
      createdAt: 1,
    });

    mocks.getMessages.mockResolvedValue({
      messages: [makePersistedMessage('msg-user-1', 'user', 'Initial prompt', 1000, 1)],
      hasMore: false,
    });

    app = createChatRoutesTestApp();
  });

  it('returns role-filtered persisted messages for a session', async () => {
    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/messages?roles=user&limit=20&before=2000&compact=true',
      { method: 'GET' },
      { DATABASE: {}, CHAT_SESSION_MESSAGE_LIMIT: '500' } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe('msg-user-1');
    expect(mocks.getMessages).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'chat-1',
      20,
      2000,
      ['user'],
      true,
      'desc',
    );
  });

  it('passes ascending order through for first-message lookups', async () => {
    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/messages?roles=user&limit=1&compact=true&order=asc',
      { method: 'GET' },
      { DATABASE: {}, CHAT_SESSION_MESSAGE_LIMIT: '500' } as Env,
    );

    expect(response.status).toBe(200);
    expect(mocks.getMessages).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'chat-1',
      1,
      null,
      ['user'],
      true,
      'asc',
    );
  });

  it('returns 404 when the session does not exist', async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await app.request(
      '/api/projects/proj-1/sessions/missing/messages?roles=user',
      { method: 'GET' },
      { DATABASE: {} } as Env,
    );

    expect(response.status).toBe(404);
    expect(mocks.getMessages).not.toHaveBeenCalled();
  });

  it('rejects invalid before cursors', async () => {
    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/messages?before=not-a-timestamp',
      { method: 'GET' },
      { DATABASE: {} } as Env,
    );

    expect(response.status).toBe(400);
    expect(mocks.getMessages).not.toHaveBeenCalled();
  });

  it('rejects invalid message order values', async () => {
    const response = await app.request(
      '/api/projects/proj-1/sessions/chat-1/messages?order=sideways',
      { method: 'GET' },
      { DATABASE: {} } as Env,
    );

    expect(response.status).toBe(400);
    expect(mocks.getMessages).not.toHaveBeenCalled();
  });
});
