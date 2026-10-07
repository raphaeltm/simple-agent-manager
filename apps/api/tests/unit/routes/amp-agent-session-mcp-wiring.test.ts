import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';
import * as projectHelpers from '../../../src/routes/projects/_helpers';

const {
  createAgentSessionOnNodeMock,
  storeMcpTokenMock,
  revokeMcpTokenMock,
  insertAgentSessionMock,
} = vi.hoisted(() => ({
  createAgentSessionOnNodeMock: vi.fn(async () => undefined),
  storeMcpTokenMock: vi.fn(async () => undefined),
  revokeMcpTokenMock: vi.fn(async () => undefined),
  insertAgentSessionMock: vi.fn(async (_value: Record<string, unknown>) => undefined),
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

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: vi.fn().mockResolvedValue(undefined),
}));

let testWorkspaceRow: Record<string, unknown> = {
  id: 'workspace-123',
  userId: 'user-123',
  nodeId: 'node-123',
  projectId: 'project-123',
  chatSessionId: 'chat-123',
  status: 'running',
};
let testProfileRows: { id: string; projectId: string | null; userId: string; agentType: string }[] =
  [];
let testConversationTaskRow: { id: string; taskMode: string } | null = {
  id: 'task-123',
  taskMode: 'conversation',
};
let insertedAgentSession: Record<string, unknown> | null = null;

const nodeRow = {
  id: 'node-123',
  userId: 'user-123',
  status: 'running',
  healthStatus: 'healthy',
  runtime: 'vm',
  agentVersion: 'current-agent',
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

const projectRow = {
  id: 'project-123',
  userId: 'user-123',
  repository: 'octo/repo',
  installationId: 'install-123',
  repoProvider: 'github',
  githubRepoId: 123,
};

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => {
    let selectCount = 0;
    return {
      select: (fields?: Record<string, unknown>) => {
        if (fields && 'value' in fields) {
          return {
            from: () => ({
              where: () => ({
                get: () => Promise.resolve(undefined),
              }),
            }),
          };
        }

        if (fields && 'agentType' in fields) {
          return {
            from: () => ({
              where: (condition: Parameters<SQLiteSyncDialect['sqlToQuery']>[0]) => ({
                limit: () => {
                  const query = new SQLiteSyncDialect().sqlToQuery(condition);
                  expect(query.sql).toContain('"agent_profiles"."project_id" = ?');
                  const [id, projectId] = query.params;
                  return Promise.resolve(
                    testProfileRows.filter((row) => row.id === id && row.projectId === projectId)
                  );
                },
              }),
            }),
          };
        }

        if (fields && 'taskMode' in fields) {
          return {
            from: () => ({
              where: (condition: Parameters<SQLiteSyncDialect['sqlToQuery']>[0]) => ({
                limit: () => {
                  const query = new SQLiteSyncDialect().sqlToQuery(condition);
                  expect(query.sql).toContain('"tasks"."workspace_id" = ?');
                  expect(query.sql).toContain('"tasks"."chat_session_id" = ?');
                  expect(query.params).toEqual([
                    'workspace-123',
                    'project-123',
                    'user-123',
                    'chat-123',
                    'conversation',
                    'in_progress',
                  ]);
                  return Promise.resolve(testConversationTaskRow ? [testConversationTaskRow] : []);
                },
              }),
            }),
          };
        }

        selectCount += 1;
        return {
          from: () => ({
            where: () => {
              if (selectCount === 1) return { limit: () => Promise.resolve([testWorkspaceRow]) };
              if (selectCount === 2) return { limit: () => Promise.resolve([nodeRow]) };
              if (selectCount === 3 && testWorkspaceRow.projectId) {
                return { limit: () => Promise.resolve([projectRow]) };
              }
              if (selectCount === 3 || (selectCount === 4 && testWorkspaceRow.projectId)) {
                return Promise.resolve([]);
              }
              return { limit: () => Promise.resolve([agentSessionRow]) };
            },
          }),
        };
      },
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          insertedAgentSession = value;
          return insertAgentSessionMock(value);
        },
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
    testProfileRows = [];
    testConversationTaskRow = { id: 'task-123', taskMode: 'conversation' };
    insertedAgentSession = null;
    nodeRow.agentVersion = 'current-agent';
    testWorkspaceRow = {
      id: 'workspace-123',
      userId: 'user-123',
      nodeId: 'node-123',
      projectId: 'project-123',
      chatSessionId: 'chat-123',
      status: 'running',
    };
  });

  it.each([
    { name: 'other-project profile', projectId: 'project-elsewhere', userId: 'other-user' },
    { name: 'another user personal profile', projectId: null, userId: 'other-user' },
    { name: 'the caller personal profile', projectId: null, userId: 'user-123' },
  ])('rejects $name before side effects', async ({ projectId, userId }) => {
    testProfileRows = [{ id: 'profile-123', projectId, userId, agentType: 'openai-codex' }];
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentProfileId: 'profile-123' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(404);
    expect(insertedAgentSession).toBeNull();
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
  });

  it('binds a project profile to a manual session and uses its agent type', async () => {
    testProfileRows = [
      {
        id: 'profile-123',
        projectId: 'project-123',
        userId: 'other-user',
        agentType: 'openai-codex',
      },
    ];
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentProfileId: ' profile-123 ', agentType: ' openai-codex ' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(201);
    expect(insertedAgentSession).toMatchObject({
      agentType: 'openai-codex',
      agentProfileId: 'profile-123',
    });
    expect(storeMcpTokenMock).toHaveBeenCalledWith(
      {},
      'mcp-token-123',
      expect.objectContaining({
        contextType: 'conversation',
        taskMode: 'conversation',
        projectId: 'project-123',
        workspaceId: 'workspace-123',
        chatSessionId: 'chat-123',
        agentSessionId: 'agent-session-123',
      }),
      expect.anything()
    );
    expect(createAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-123',
      'workspace-123',
      'agent-session-123',
      null,
      expect.anything(),
      'user-123',
      'chat-123',
      'project-123',
      expect.any(Array),
      undefined,
      'conversation'
    );
  });

  it('rejects an unknown profile before creating or starting a session', async () => {
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentProfileId: 'profile-from-other-project' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(404);
    expect(insertedAgentSession).toBeNull();
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
  });

  it.each(['', '  '])(
    'rejects an empty profile ID %j before side effects',
    async (agentProfileId) => {
      const app = await createTestApp();
      const res = await app.request(
        '/api/workspaces/workspace-123/agent-sessions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentProfileId }),
        },
        { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
      );

      expect(res.status).toBe(400);
      expect(insertedAgentSession).toBeNull();
      expect(storeMcpTokenMock).not.toHaveBeenCalled();
      expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    }
  );

  it('rejects a profile for a non-project workspace before side effects', async () => {
    testWorkspaceRow = { ...testWorkspaceRow, projectId: null, chatSessionId: null };
    testProfileRows = [
      {
        id: 'profile-123',
        projectId: 'project-123',
        userId: 'user-123',
        agentType: 'openai-codex',
      },
    ];
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentProfileId: 'profile-123' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(400);
    expect(insertedAgentSession).toBeNull();
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
  });

  it('keeps no-profile blank agent type normalized to null', async () => {
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: '  ' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(201);
    expect(insertedAgentSession).toMatchObject({ agentType: null, agentProfileId: null });
  });

  it('does not enable conversation interactions from a chat ID without a matching task', async () => {
    testConversationTaskRow = null;
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'openai-codex' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(201);
    expect(createAgentSessionOnNodeMock.mock.lastCall?.at(-1)).toBeUndefined();
  });

  it('rejects an agent type that disagrees with the selected profile', async () => {
    testProfileRows = [
      {
        id: 'profile-123',
        projectId: 'project-123',
        userId: 'other-user',
        agentType: 'openai-codex',
      },
    ];
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentProfileId: 'profile-123', agentType: 'claude-code' }),
      },
      { DATABASE: {}, KV: {}, BASE_DOMAIN: 'example.com' }
    );

    expect(res.status).toBe(400);
    expect(insertedAgentSession).toBeNull();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
  });

  it('mints a scoped MCP token and sends MCP config during direct agent-session creation', async () => {
    const app = await createTestApp();

    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Amp', agentType: 'amp' }),
      },
      {
        DATABASE: {},
        KV: {},
        BASE_DOMAIN: 'example.com',
      }
    );

    expect(res.status).toBe(201);
    expect(storeMcpTokenMock).toHaveBeenCalledWith(
      {},
      'mcp-token-123',
      expect.objectContaining({
        taskId: '',
        projectId: 'project-123',
        userId: 'user-123',
        workspaceId: 'workspace-123',
        chatSessionId: 'chat-123',
        agentSessionId: 'agent-session-123',
      }),
      expect.objectContaining({ BASE_DOMAIN: 'example.com' })
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
      [
        {
          url: 'https://api.example.com/mcp',
          token: 'mcp-token-123',
          name: 'sam-mcp',
        },
      ],
      undefined,
      'conversation'
    );
    expect(revokeMcpTokenMock).not.toHaveBeenCalled();
  });

  it('refuses a direct new session on an incompatible existing VM before minting a token', async () => {
    nodeRow.agentVersion = 'old-agent';
    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Amp', agentType: 'amp' }),
      },
      {
        DATABASE: {},
        KV: {},
        BASE_DOMAIN: 'example.com',
        VM_AGENT_REQUIRED_VERSION: 'current-agent',
      }
    );

    expect(res.status).toBe(409);
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(insertAgentSessionMock).not.toHaveBeenCalled();
  });

  it('revokes MCP token when createAgentSessionOnNode fails', async () => {
    createAgentSessionOnNodeMock.mockRejectedValueOnce(new Error('VM agent unreachable'));

    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Amp', agentType: 'amp' }),
      },
      {
        DATABASE: {},
        KV: {},
        BASE_DOMAIN: 'example.com',
      }
    );

    expect(res.status).toBe(500);
    expect(storeMcpTokenMock).toHaveBeenCalledTimes(1);
    expect(revokeMcpTokenMock).toHaveBeenCalledWith({}, 'mcp-token-123');
  });

  it('skips MCP token minting when workspace has no projectId', async () => {
    testWorkspaceRow = {
      id: 'workspace-123',
      userId: 'user-123',
      nodeId: 'node-123',
      projectId: null,
      chatSessionId: null,
      status: 'running',
    };

    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Amp', agentType: 'amp' }),
      },
      {
        DATABASE: {},
        KV: {},
        BASE_DOMAIN: 'example.com',
      }
    );

    expect(res.status).toBe(201);
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-123',
      'workspace-123',
      'agent-session-123',
      'Amp',
      expect.anything(),
      'user-123',
      null,
      null,
      undefined,
      undefined,
      undefined
    );
  });

  it('blocks before direct agent-session provisioning when GitHub owner access is revoked', async () => {
    vi.mocked(projectHelpers.requireRepositoryOwnerAccess).mockRejectedValueOnce(
      new AppError(
        403,
        'Repository access is no longer available',
        'GITHUB_REPOSITORY_ACCESS_DENIED'
      )
    );

    const app = await createTestApp();
    const res = await app.request(
      '/api/workspaces/workspace-123/agent-sessions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Amp', agentType: 'amp' }),
      },
      {
        DATABASE: {},
        KV: {},
        BASE_DOMAIN: 'example.com',
      }
    );

    expect(res.status).toBe(403);
    expect(projectHelpers.requireRepositoryOwnerAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'project-123', repository: 'octo/repo' }),
      'user-123',
      'workspace-agent-session'
    );
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
  });
});
