import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { chatRoutes } from '../../../src/routes/chat';
import * as projectDataService from '../../../src/services/project-data';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  sendPromptToAgentOnNode: vi.fn(),
  cancelAgentSessionOnNode: vi.fn(),
  getCfContainerWakeTimeoutMs: vi.fn(() => 120_000),
  enrichMessageWithMentions: vi.fn(),
  parseOptionalBody: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: mocks.drizzle,
}));

vi.mock('@simple-agent-manager/shared', () => ({
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT: 500,
  DEFAULT_CHAT_SESSION_MESSAGE_MAX: 50000,
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
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
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
  parseOptionalBody: mocks.parseOptionalBody,
}));

vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: mocks.sendPromptToAgentOnNode,
  cancelAgentSessionOnNode: mocks.cancelAgentSessionOnNode,
  getCfContainerWakeTimeoutMs: mocks.getCfContainerWakeTimeoutMs,
}));

vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: mocks.enrichMessageWithMentions,
}));

/** Helper to build a drizzle mock that returns workspace + agent session rows. */
function setupDrizzle(opts: {
  workspace?: {
    id: string;
    nodeId: string | null;
    nodeStatus: string | null;
    nodeRuntime?: string | null;
    userId?: string;
    projectId?: string | null;
  } | null;
  agentSession?: { id: string } | null;
}) {
  // Default the workspace owner to the authenticated caller so the
  // defence-in-depth ownership assertion passes for positive cases.
  const workspaceRow = opts.workspace
    ? { userId: 'user-1', projectId: 'proj-1', nodeRuntime: 'vm', ...opts.workspace }
    : null;
  let callCount = 0;
  const selectMock = vi.fn().mockImplementation(() => {
    callCount++;
    const currentCall = callCount;
    return {
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue(currentCall === 1 ? (workspaceRow ? [workspaceRow] : []) : []),
          }),
        }),
        where: vi.fn().mockReturnValue({
          limit: vi
            .fn()
            .mockResolvedValue(
              currentCall === 2 ? (opts.agentSession ? [opts.agentSession] : []) : []
            ),
        }),
      }),
    };
  });
  mocks.drizzle.mockReturnValue({ select: selectMock });
}

let app: Hono<{ Bindings: Env }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireProjectAccess.mockResolvedValue({ id: 'proj-1', userId: 'user-1' });
  mocks.parseOptionalBody.mockResolvedValue({ content: 'hello agent' });
  mocks.enrichMessageWithMentions.mockResolvedValue({ enrichedMessage: 'hello agent' });
  vi.mocked(projectDataService.getSession).mockResolvedValue({
    id: 'chat-1',
    createdByUserId: 'user-1',
    status: 'active',
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

describe('GET /sessions', () => {
  function setupUserLookup() {
    mocks.drizzle.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'user-1',
              name: 'Alice',
              email: 'alice@example.com',
              image: null,
              avatarUrl: null,
            },
            { id: 'user-2', name: 'Bob', email: 'bob@example.com', image: null, avatarUrl: null },
          ]),
        }),
      }),
    });
  }

  it('returns all member-visible sessions with creator metadata by default', async () => {
    setupUserLookup();
    vi.mocked(projectDataService.listSessions).mockResolvedValue({
      sessions: [
        { id: 'chat-1', createdByUserId: 'user-1', status: 'active' },
        { id: 'chat-2', createdByUserId: 'user-2', status: 'active' },
      ],
      total: 2,
    });

    const response = await app.request('/api/projects/proj-1/sessions', { method: 'GET' }, {
      DATABASE: {} as D1Database,
    } as Env);

    expect(response.status).toBe(200);
    expect(projectDataService.listSessions).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      null,
      20,
      0,
      null,
      null
    );
    const body = await response.json();
    expect(body.sessions).toMatchObject([
      { id: 'chat-1', createdByUserId: 'user-1', isMine: true, createdBy: { name: 'Alice' } },
      { id: 'chat-2', createdByUserId: 'user-2', isMine: false, createdBy: { name: 'Bob' } },
    ]);
  });

  it('filters to the current creator for scope=my', async () => {
    setupUserLookup();
    vi.mocked(projectDataService.listSessions).mockResolvedValue({
      sessions: [{ id: 'chat-1', createdByUserId: 'user-1', status: 'active' }],
      total: 1,
    });

    const response = await app.request(
      '/api/projects/proj-1/sessions?scope=my',
      { method: 'GET' },
      { DATABASE: {} as D1Database } as Env
    );

    expect(response.status).toBe(200);
    expect(projectDataService.listSessions).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      null,
      20,
      0,
      null,
      'user-1'
    );
  });
});

describe('POST /sessions/:sessionId/prompt', () => {
  function postPrompt() {
    return app.request(
      '/api/projects/proj-1/sessions/chat-1/prompt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello agent' }),
      },
      { DATABASE: {} as D1Database } as Env
    );
  }

  it('forwards a prompt to the running agent session', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.sendPromptToAgentOnNode.mockResolvedValue({ ok: true });

    const response = await postPrompt();

    expect(response.status).toBe(200);
    expect(mocks.sendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-1',
      'ws-1',
      'agent-sess-1',
      'hello agent',
      expect.anything(),
      'user-1',
      undefined,
      undefined
    );
  });

  it('uses the extended wake budget for a sleeping session', async () => {
    setupDrizzle({
      workspace: {
        id: 'ws-1',
        nodeId: 'node-1',
        nodeStatus: 'sleeping',
        nodeRuntime: 'cf-container',
      },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.sendPromptToAgentOnNode.mockResolvedValue({ ok: true });

    const response = await postPrompt();

    expect(response.status).toBe(200);
    expect(mocks.sendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-1',
      'ws-1',
      'agent-sess-1',
      'hello agent',
      expect.anything(),
      'user-1',
      undefined,
      { requestTimeoutMs: 120_000 }
    );
  });

  it.each(['recovery', 'error'])(
    'routes cf-container %s state to bounded recovery',
    async (nodeStatus) => {
      setupDrizzle({
        workspace: {
          id: 'ws-1',
          nodeId: 'node-1',
          nodeStatus,
          nodeRuntime: 'cf-container',
        },
        agentSession: { id: 'agent-sess-1' },
      });
      mocks.sendPromptToAgentOnNode.mockResolvedValue({ ok: true });

      const response = await postPrompt();

      expect(response.status).toBe(200);
      expect(mocks.sendPromptToAgentOnNode).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'agent-sess-1',
        'hello agent',
        expect.anything(),
        'user-1',
        undefined,
        { requestTimeoutMs: 120_000 }
      );
    }
  );

  it('returns the stable sanitized interruption error without replaying', async () => {
    setupDrizzle({
      workspace: {
        id: 'ws-1',
        nodeId: 'node-1',
        nodeStatus: 'running',
        nodeRuntime: 'cf-container',
      },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.sendPromptToAgentOnNode.mockRejectedValue(
      new AppError(
        409,
        'RUNTIME_REQUEST_INTERRUPTED',
        'Your message is saved, but it was not replayed automatically.'
      )
    );

    const response = await postPrompt();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'RUNTIME_REQUEST_INTERRUPTED',
      message: 'Your message is saved, but it was not replayed automatically.',
    });
  });

  it('returns 404 when no active workspace is found', async () => {
    setupDrizzle({ workspace: null, agentSession: null });

    const response = await postPrompt();

    expect(response.status).toBe(404);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('returns 409 when node is not running', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'destroyed' },
      agentSession: null,
    });

    const response = await postPrompt();

    expect(response.status).toBe(409);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('returns 404 when the workspace has no node (nodeId null)', async () => {
    // A workspace whose node was destroyed (FK set null) resolves but has no
    // node to drive — the handler must 404, not contact any agent.
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: null, nodeStatus: null },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postPrompt();

    expect(response.status).toBe(404);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('returns 400 when the prompt content is empty', async () => {
    mocks.parseOptionalBody.mockResolvedValue({ content: '' });
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postPrompt();

    expect(response.status).toBe(400);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('blocks a non-creator member before contacting the VM agent', async () => {
    vi.mocked(projectDataService.getSession).mockResolvedValue({
      id: 'chat-1',
      createdByUserId: 'other-user',
      status: 'active',
    });
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postPrompt();

    expect(response.status).toBe(403);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('returns 404 when no running agent session is found', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: null,
    });

    const response = await postPrompt();

    expect(response.status).toBe(404);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('rejects a workspace row owned by another user (404, no prompt sent)', async () => {
    // Defence-in-depth: a mismatched owner row must be rejected and the VM
    // agent must never be contacted.
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running', userId: 'attacker' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postPrompt();

    expect(response.status).toBe(404);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('does not let an admin member prompt the project owner session', async () => {
    // Project membership grants visibility/write capability, but message
    // submission still resolves the live workspace by the active creator user.
    setupDrizzle({
      workspace: { id: 'ws-owner', nodeId: 'node-1', nodeStatus: 'running', userId: 'owner-user' },
      agentSession: { id: 'agent-sess-owner' },
    });

    const response = await postPrompt();

    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'user-1',
      'task:write'
    );
    expect(response.status).toBe(404);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('rejects a workspace row belonging to another project (404, no prompt sent)', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running', projectId: 'other-proj' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postPrompt();

    expect(response.status).toBe(404);
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });
});

describe('POST /sessions/:sessionId/cancel', () => {
  function postCancel() {
    return app.request('/api/projects/proj-1/sessions/chat-1/cancel', { method: 'POST' }, {
      DATABASE: {} as D1Database,
    } as Env);
  }

  it('cancels a running prompt successfully', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: true, status: 200 });

    const response = await postCancel();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('cancelled');
    expect(body.message).toBe('Prompt cancel signal sent');
    expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'ws-1',
      'agent-sess-1',
      expect.anything(),
      'user-1'
    );
  });

  it('returns idle status when no prompt is in flight (409)', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status: 409 });

    const response = await postCancel();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('idle');
    expect(body.message).toBe('No prompt in flight to cancel');
  });

  it('returns 500 when the cancel signal fails for a non-idle reason', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status: 500 });

    const response = await postCancel();

    expect(response.status).toBe(500);
  });

  it('returns 404 when no active workspace is found', async () => {
    setupDrizzle({ workspace: null, agentSession: null });

    const response = await postCancel();

    expect(response.status).toBe(404);
  });

  it('returns 409 when node is not running', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'destroyed' },
      agentSession: null,
    });

    const response = await postCancel();

    expect(response.status).toBe(409);
  });

  it('returns 404 when no running agent session is found', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: null,
    });

    const response = await postCancel();

    expect(response.status).toBe(404);
  });

  it('blocks non-creator cancellation before contacting the VM agent', async () => {
    vi.mocked(projectDataService.getSession).mockResolvedValue({
      id: 'chat-1',
      createdByUserId: 'other-user',
      status: 'active',
    });
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postCancel();

    expect(response.status).toBe(403);
    expect(mocks.cancelAgentSessionOnNode).not.toHaveBeenCalled();
  });

  it('rejects a workspace row owned by another user (404, no cancel sent)', async () => {
    // Defence-in-depth: even if a row leaks past the WHERE clause (regression),
    // a mismatched owner must be rejected and the VM agent never contacted.
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running', userId: 'attacker' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postCancel();

    expect(response.status).toBe(404);
    expect(mocks.cancelAgentSessionOnNode).not.toHaveBeenCalled();
  });

  it('rejects a workspace row belonging to another project (404, no cancel sent)', async () => {
    setupDrizzle({
      workspace: { id: 'ws-1', nodeId: 'node-1', nodeStatus: 'running', projectId: 'other-proj' },
      agentSession: { id: 'agent-sess-1' },
    });

    const response = await postCancel();

    expect(response.status).toBe(404);
    expect(mocks.cancelAgentSessionOnNode).not.toHaveBeenCalled();
  });
});
