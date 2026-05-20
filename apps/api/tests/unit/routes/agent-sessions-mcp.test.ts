import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { agentSessionRoutes, createProjectChatMcpServer } from '../../../src/routes/workspaces/agent-sessions';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  createAgentSessionOnNode: vi.fn(),
  getOwnedWorkspace: vi.fn(),
  getOwnedNode: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: mocks.drizzle,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-123',
}));

vi.mock('../../../src/routes/workspaces/_helpers', () => ({
  getOwnedWorkspace: mocks.getOwnedWorkspace,
  getOwnedNode: mocks.getOwnedNode,
  assertNodeOperational: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/node-agent')>();
  return {
    ...actual,
    createAgentSessionOnNode: mocks.createAgentSessionOnNode,
  };
});

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    return typeof appError.statusCode === 'number' && typeof appError.error === 'string'
      ? c.json({ error: appError.error, message: appError.message }, appError.statusCode)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/workspaces', agentSessionRoutes);
  return app;
}

describe('project-chat agent session MCP wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a SAM MCP server config scoped to the project chat session', async () => {
    const kv = {
      put: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      BASE_DOMAIN: 'example.com',
      KV: kv,
      MCP_TOKEN_TTL_SECONDS: '3600',
    } as any;

    const result = await createProjectChatMcpServer(
      env,
      'user-123',
      {
        id: 'workspace-123',
        projectId: 'project-123',
        chatSessionId: 'chat-123',
      },
      'agent-session-123',
    );

    expect(result?.url).toBe('https://api.example.com/mcp');
    expect(result?.token).toEqual(expect.any(String));
    expect(result?.token).not.toHaveLength(0);

    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, rawValue, options] = kv.put.mock.calls[0];
    expect(key).toBe(`mcp:${result?.token}`);
    expect(options).toEqual({ expirationTtl: 3600 });
    expect(JSON.parse(rawValue)).toMatchObject({
      kind: 'project-chat',
      taskId: 'agent-session-123',
      projectId: 'project-123',
      userId: 'user-123',
      workspaceId: 'workspace-123',
      chatSessionId: 'chat-123',
      agentSessionId: 'agent-session-123',
    });
  });

  it('does not create MCP config when the workspace lacks project-chat context', async () => {
    const kv = {
      put: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      BASE_DOMAIN: 'example.com',
      KV: kv,
    } as any;

    const result = await createProjectChatMcpServer(
      env,
      'user-123',
      {
        id: 'workspace-123',
        projectId: null,
        chatSessionId: 'chat-123',
      },
      'agent-session-123',
    );

    expect(result).toBeUndefined();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('sends project-chat SAM MCP config when creating an agent session on a node', async () => {
    const kv = {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      BASE_DOMAIN: 'example.com',
      DATABASE: {} as D1Database,
      KV: kv,
      MCP_TOKEN_TTL_SECONDS: '3600',
      MAX_AGENT_SESSIONS_PER_WORKSPACE: '5',
    } as unknown as Env;

    mocks.getOwnedWorkspace.mockResolvedValue({
      id: 'workspace-123',
      userId: 'user-123',
      nodeId: 'node-123',
      status: 'running',
      projectId: 'project-123',
      chatSessionId: 'chat-123',
    });
    mocks.getOwnedNode.mockResolvedValue({
      id: 'node-123',
      userId: 'user-123',
      status: 'running',
      healthStatus: 'healthy',
    });
    mocks.createAgentSessionOnNode.mockResolvedValue({});

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const existingRunningQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const createdSessionQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{
          id: 'agent-session-123',
          workspaceId: 'workspace-123',
          userId: 'user-123',
          status: 'running',
          label: 'Amp chat',
          agentType: 'amp',
          worktreePath: null,
          createdAt: '2026-05-20T15:00:00.000Z',
          updatedAt: '2026-05-20T15:00:00.000Z',
          stoppedAt: null,
          suspendedAt: null,
          errorMessage: null,
        }]),
      }),
    };
    mocks.drizzle.mockReturnValue({
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
      select: vi.fn()
        .mockReturnValueOnce(existingRunningQuery)
        .mockReturnValueOnce(createdSessionQuery),
    });

    const response = await createApp().request(
      '/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Amp chat', agentType: 'amp' }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-123',
      userId: 'user-123',
      status: 'running',
      label: 'Amp chat',
      agentType: 'amp',
    }));

    expect(mocks.createAgentSessionOnNode).toHaveBeenCalledTimes(1);
    const nodeCall = mocks.createAgentSessionOnNode.mock.calls[0];
    expect(nodeCall.slice(0, 8)).toEqual([
      'node-123',
      'workspace-123',
      expect.any(String),
      'Amp chat',
      env,
      'user-123',
      'chat-123',
      'project-123',
    ]);
    expect(nodeCall[8]).toMatchObject({
      url: 'https://api.example.com/mcp',
      token: expect.any(String),
    });

    const token = nodeCall[8].token;
    expect(kv.put).toHaveBeenCalledWith(
      `mcp:${token}`,
      expect.stringContaining('"kind":"project-chat"'),
      { expirationTtl: 3600 },
    );
    const [, rawTokenData] = kv.put.mock.calls[0];
    expect(JSON.parse(rawTokenData)).toMatchObject({
      kind: 'project-chat',
      projectId: 'project-123',
      userId: 'user-123',
      workspaceId: 'workspace-123',
      chatSessionId: 'chat-123',
      agentSessionId: nodeCall[2],
      taskId: nodeCall[2],
    });
  });
});
