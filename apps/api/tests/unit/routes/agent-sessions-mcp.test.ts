import { describe, expect, it, vi } from 'vitest';

import { createProjectChatMcpServer } from '../../../src/routes/workspaces/agent-sessions';

describe('project-chat agent session MCP wiring', () => {
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
});
