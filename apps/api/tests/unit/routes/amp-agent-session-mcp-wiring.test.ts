import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const { createAgentSessionOnNodeMock, storeMcpTokenMock, revokeMcpTokenMock } = vi.hoisted(() => ({
  createAgentSessionOnNodeMock: vi.fn(async () => undefined),
  storeMcpTokenMock: vi.fn(async () => undefined),
  revokeMcpTokenMock: vi.fn(async () => undefined),
}));

vi.mock('../../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: vi.fn().mockResolvedValue({
        user: {
          id: 'user-123',
          email: 'user@example.com',
          name: 'Test User',
          role: 'user',
          status: 'active',
        },
        session: { id: 'session-123', expiresAt: new Date('2030-01-01T00:00:00Z') },
      }),
    },
  }),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'agent-session-123',
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'mcp-token-123',
  storeMcpToken: storeMcpTokenMock,
  revokeMcpToken: revokeMcpTokenMock,
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: createAgentSessionOnNodeMock,
  resumeAgentSessionOnNode: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
  suspendAgentSessionOnNode: vi.fn(),
}));

const workspaceRow = {
  id: 'workspace-123',
  userId: 'user-123',
  nodeId: 'node-123',
  projectId: 'project-123',
  chatSessionId: 'chat-123',
  status: 'running',
};

const nodeRow = {
  id: 'node-123',
  userId: 'user-123',
  status: 'running',
  healthStatus: 'healthy',
};

const agentSessionRow = {
  id: 'agent-session-123',
  workspaceId: 'workspace-123',
  userId: 'user-123',
  status: 'running',
  label: 'Amp',
  agentType: 'amp',
  worktreePath: null,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  stoppedAt: null,
  suspendedAt: null,
  errorMessage: null,
};

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => {
    let selectCount = 0;
    return {
      select: () => {
        selectCount += 1;
        return {
          from: () => ({
            where: () => {
              if (selectCount === 1) return { limit: () => Promise.resolve([workspaceRow]) };
              if (selectCount === 2) return { limit: () => Promise.resolve([nodeRow]) };
              if (selectCount === 3) return Promise.resolve([]);
              return { limit: () => Promise.resolve([agentSessionRow]) };
            },
          }),
        };
      },
      insert: () => ({
        values: () => Promise.resolve(),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
    };
  },
}));

async function createTestApp(): Promise<Hono> {
  const { agentSessionRoutes } = await import('../../../src/routes/workspaces/agent-sessions');
  const app = new Hono();
  app.route('/api/workspaces', agentSessionRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  return app;
}

describe('Amp project-chat MCP wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mints a scoped MCP token and sends MCP config during direct agent-session creation', async () => {
    const app = await createTestApp();

    const res = await app.request('/api/workspaces/workspace-123/agent-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Amp', agentType: 'amp' }),
    }, {
      DATABASE: {},
      KV: {},
      BASE_DOMAIN: 'example.com',
    });

    expect(res.status).toBe(201);
    expect(storeMcpTokenMock).toHaveBeenCalledWith(
      {},
      'mcp-token-123',
      expect.objectContaining({
        taskId: 'agent-session-123',
        projectId: 'project-123',
        userId: 'user-123',
        workspaceId: 'workspace-123',
        chatSessionId: 'chat-123',
        agentSessionId: 'agent-session-123',
      }),
      expect.objectContaining({ BASE_DOMAIN: 'example.com' }),
    );
    expect(createAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-123',
      'workspace-123',
      'agent-session-123',
      'Amp',
      expect.objectContaining({ BASE_DOMAIN: 'example.com' }),
      'user-123',
      'chat-123',
      'project-123',
      {
        url: 'https://api.example.com/mcp',
        token: 'mcp-token-123',
      },
    );
    expect(revokeMcpTokenMock).not.toHaveBeenCalled();
  });
});
