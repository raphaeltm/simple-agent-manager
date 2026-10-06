import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../../src/env';
import type { McpTokenData } from '../../../../src/routes/mcp/_helpers';
import { handleGetCredentialLimits } from '../../../../src/routes/mcp/workspace-tools-credential-limits';

const mocks = vi.hoisted(() => ({
  listProjectCredentialLimits: vi.fn(),
  resolveAgentSessionCredentialReference: vi.fn(),
}));

vi.mock('../../../../src/services/credential-limit-events/read', () => ({
  listProjectCredentialLimits: mocks.listProjectCredentialLimits,
  resolveAgentSessionCredentialReference: mocks.resolveAgentSessionCredentialReference,
}));

const env = {} as Env;

function token(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    agentSessionId: 'agent-session-1',
    createdAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

function parseContent(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const RESPONSE = {
  credentials: [
    {
      credentialReference: 'cc_credentials:cred-1',
      credentialId: 'cred-1',
      credentialSource: 'user',
      provider: 'openai',
      providerMode: 'direct',
      agentType: 'openai-codex',
      level: 'critical',
      observedAt: 1_700_000_000_000,
      windows: [
        {
          windowType: 'codex.primary',
          provider: 'openai',
          source: 'vm-agent.codex_rollout',
          status: 'allowed',
          level: 'critical',
          utilizationPercent: 93.4,
          limitAmount: null,
          remainingAmount: null,
          windowMinutes: 300,
          resetsAt: 1_700_003_600_000,
          observedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
        {
          windowType: 'codex.secondary',
          provider: 'openai',
          source: 'vm-agent.codex_rollout',
          status: 'allowed',
          level: 'ok',
          utilizationPercent: 20,
          limitAmount: null,
          remainingAmount: null,
          windowMinutes: 10080,
          resetsAt: null,
          observedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ],
    },
  ],
  generatedAt: 1_700_000_001_000,
};

describe('get_credential_limits MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectCredentialLimits.mockResolvedValue(RESPONSE);
    mocks.resolveAgentSessionCredentialReference.mockResolvedValue('cc_credentials:cred-1');
  });

  it("defaults to the calling session's credential and renders readable summary lines", async () => {
    const response = await handleGetCredentialLimits('1', {}, token(), env);
    expect(mocks.resolveAgentSessionCredentialReference).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      agentSessionId: 'agent-session-1',
    });
    expect(mocks.listProjectCredentialLimits).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      userId: 'user-1',
      credentialReference: 'cc_credentials:cred-1',
    });
    const body = parseContent(response);
    expect(body.scope).toBe('session');
    expect(body.summary).toEqual([
      'Codex 5h (user credential): 93% used, level critical, resets 2023-11-14T23:13:20.000Z',
      'Codex Week (user credential): 20% used, level ok',
    ]);
    expect(body.credentials).toEqual(RESPONSE.credentials);
  });

  it('reads every visible credential with scope=project and no session lookup', async () => {
    const response = await handleGetCredentialLimits('2', { scope: 'project' }, token(), env);
    expect(mocks.resolveAgentSessionCredentialReference).not.toHaveBeenCalled();
    expect(mocks.listProjectCredentialLimits).toHaveBeenCalledWith(env, {
      projectId: 'proj-1',
      userId: 'user-1',
      credentialReference: undefined,
    });
    expect(parseContent(response).scope).toBe('project');
  });

  it('explains when the session credential has no samples yet', async () => {
    mocks.resolveAgentSessionCredentialReference.mockResolvedValue(null);
    const body = parseContent(await handleGetCredentialLimits('3', {}, token(), env));
    expect(body.credentials).toEqual([]);
    expect(String(body.note)).toContain('No usage samples');
    expect(mocks.listProjectCredentialLimits).not.toHaveBeenCalled();
  });

  it('explains when the token carries no agent session', async () => {
    const body = parseContent(
      await handleGetCredentialLimits('4', {}, token({ agentSessionId: undefined }), env)
    );
    expect(body.credentials).toEqual([]);
    expect(String(body.note)).toContain('scope "project"');
  });

  it('returns a JSON-RPC internal error when the read service fails', async () => {
    mocks.listProjectCredentialLimits.mockRejectedValue(new Error('D1 unavailable'));
    const response = await handleGetCredentialLimits('6', { scope: 'project' }, token(), env);
    expect(response.error?.code).toBe(-32603);
    expect(response.error?.message).toContain('Failed to read credential limits');
    expect(response.error?.message).toContain('D1 unavailable');
  });

  it('rejects an unknown scope', async () => {
    const response = await handleGetCredentialLimits('5', { scope: 'galaxy' }, token(), env);
    expect(response.error?.code).toBe(-32602);
    expect(mocks.listProjectCredentialLimits).not.toHaveBeenCalled();
  });
});
