import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jwt: {
    signCallbackToken: vi.fn(),
    signNodeCallbackToken: vi.fn(),
  },
  mcp: {
    generateMcpToken: vi.fn(),
    revokeMcpToken: vi.fn(),
    storeMcpToken: vi.fn(),
  },
  nodeAgent: {
    createAgentSessionOnNode: vi.fn(),
    createWorkspaceOnNode: vi.fn(),
    startAgentSessionOnNode: vi.fn(),
    waitForNodeAgentReady: vi.fn(),
  },
  nodes: {
    createNodeRecord: vi.fn(),
  },
  projectData: {
    createAcpSession: vi.fn(),
    createSession: vi.fn(),
    persistMessage: vi.fn(),
    transitionAcpSession: vi.fn(),
  },
  sandbox: {
    destroySandboxInstance: vi.fn(),
    getSandboxConfig: vi.fn(),
    getSandboxInstance: vi.fn(),
    requireSandbox: vi.fn(),
    runSandboxPhase: vi.fn(),
    shellQuote: vi.fn(),
  },
  sandboxExec: vi.fn(),
  ulid: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => mocks.jwt);
vi.mock('../../../src/services/mcp-token', () => mocks.mcp);
vi.mock('../../../src/services/node-agent', () => mocks.nodeAgent);
vi.mock('../../../src/services/nodes', () => mocks.nodes);
vi.mock('../../../src/services/project-data', () => mocks.projectData);
vi.mock('../../../src/services/sandbox', () => mocks.sandbox);
vi.mock('../../../src/lib/ulid', () => ({ ulid: mocks.ulid }));

import { launchInstantSession } from '../../../src/services/instant-session';

function makeDb() {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  return {
    inserts,
    updates,
    db: {
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          inserts.push(value);
          return Promise.resolve();
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => {
          updates.push(value);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    },
  };
}

const project = {
  id: 'project-1',
  repository: 'owner/repo',
  defaultBranch: 'main',
  installationId: 'installation-1',
} as never;

const env = {
  BASE_DOMAIN: 'example.com',
  KV: {},
  SANDBOX_ENABLED: 'true',
  SANDBOX_EXEC_TIMEOUT_MS: '30000',
  SANDBOX_VM_AGENT_PORT: '8080',
} as never;

describe('launchInstantSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ulid.mockReturnValueOnce('workspace-1').mockReturnValueOnce('agent-session-1');
    mocks.jwt.signCallbackToken.mockResolvedValue('workspace-callback-token');
    mocks.jwt.signNodeCallbackToken.mockResolvedValue('node-callback-token');
    mocks.mcp.generateMcpToken.mockReturnValue('mcp-token');
    mocks.mcp.storeMcpToken.mockResolvedValue(undefined);
    mocks.nodeAgent.createAgentSessionOnNode.mockResolvedValue({});
    mocks.nodeAgent.createWorkspaceOnNode.mockResolvedValue({});
    mocks.nodeAgent.startAgentSessionOnNode.mockResolvedValue({});
    mocks.nodeAgent.waitForNodeAgentReady.mockResolvedValue(undefined);
    mocks.nodes.createNodeRecord.mockResolvedValue({ id: 'node-1' });
    mocks.projectData.createAcpSession.mockResolvedValue({ id: 'agent-session-1' });
    mocks.projectData.createSession.mockResolvedValue('chat-session-1');
    mocks.projectData.persistMessage.mockResolvedValue(undefined);
    mocks.projectData.transitionAcpSession.mockResolvedValue({});
    mocks.sandbox.getSandboxConfig.mockReturnValue({ execTimeoutMs: 30_000 });
    mocks.sandbox.destroySandboxInstance.mockResolvedValue(undefined);
    mocks.sandboxExec.mockResolvedValue({ success: true, stdout: 'ok', stderr: '' });
    mocks.sandbox.getSandboxInstance.mockResolvedValue({ exec: mocks.sandboxExec });
    mocks.sandbox.runSandboxPhase.mockImplementation((_phase, _detail, fn) => fn());
    mocks.sandbox.shellQuote.mockImplementation((value: string) => `'${value}'`);
  });

  it('creates a linked cf-container workspace, ACP session, and running agent session', async () => {
    const { db, inserts, updates } = makeDb();

    const result = await launchInstantSession(db as never, env, {
      project,
      userId: 'user-1',
      initialPrompt: 'enriched prompt',
      displayMessage: 'clean prompt',
      agentType: 'claude-code',
      agentProfileId: 'profile-1',
      overrides: { model: 'claude-sonnet-4-5-20250929', effort: 'auto' },
    });

    expect(result).toMatchObject({
      runtime: 'cf-container',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      chatSessionId: 'chat-session-1',
      agentSessionId: 'agent-session-1',
    });

    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtime: 'cf-container',
        vmLocation: 'cf-container',
        credentialAttributionSource: 'platform',
      })
    );
    expect(inserts[0]).toMatchObject({
      id: 'workspace-1',
      nodeId: 'node-1',
      installationId: 'installation-1',
      repository: 'owner/repo',
      workspaceProfile: 'lightweight',
      agentProfileHint: 'profile-1',
    });
    expect(mocks.projectData.createSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'workspace-1',
      'clean prompt',
      null,
      'user-1'
    );
    expect(mocks.projectData.persistMessage).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'chat-session-1',
      'user',
      'clean prompt',
      null
    );
    expect(inserts[1]).toMatchObject({
      id: 'agent-session-1',
      workspaceId: 'workspace-1',
      status: 'running',
      agentType: 'claude-code',
    });
    expect(mocks.projectData.createAcpSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'chat-session-1',
      null,
      'claude-code',
      null,
      0,
      'agent-session-1'
    );
    expect(mocks.nodeAgent.startAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-session-1',
      'claude-code',
      'enriched prompt',
      expect.anything(),
      'user-1',
      { url: 'https://api.example.com/mcp', token: 'mcp-token' },
      { model: 'claude-sonnet-4-5-20250929', effort: 'auto' }
    );
    const sandboxCommands = mocks.sandboxExec.mock.calls
      .map(([command]) => String(command))
      .join('\n');
    expect(sandboxCommands).toContain("mkdir -p '/workspaces/repo' /var/lib/vm-agent");
    expect(sandboxCommands).toContain("WORKSPACE_DIR='/workspaces/repo'");
    expect(sandboxCommands).toContain("CONTAINER_WORK_DIR='/workspaces/repo'");
    expect(sandboxCommands).toContain('cd /var/lib/vm-agent');
    expect(sandboxCommands).not.toContain("cd '/workspaces/repo'");
    expect(sandboxCommands).not.toContain('/workspaces/workspace');
    expect(updates.at(-1)).toMatchObject({ dispatchedAt: expect.any(String) });
  });

  it('honors a configured Sandbox workspace base directory', async () => {
    const { db } = makeDb();
    const envWithWorkspaceBase = {
      ...(env as Record<string, unknown>),
      SANDBOX_WORKSPACE_BASE_DIR: '/workspace-root',
    } as never;

    await launchInstantSession(db as never, envWithWorkspaceBase, {
      project: { ...project, repository: 'https://github.com/owner/custom-repo.git' } as never,
      userId: 'user-1',
      initialPrompt: 'prompt',
      displayMessage: 'prompt',
      agentType: 'claude-code',
    });

    const sandboxCommands = mocks.sandboxExec.mock.calls
      .map(([command]) => String(command))
      .join('\n');
    expect(sandboxCommands).toContain("mkdir -p '/workspace-root/custom-repo' /var/lib/vm-agent");
    expect(sandboxCommands).toContain("WORKSPACE_DIR='/workspace-root/custom-repo'");
    expect(sandboxCommands).toContain("CONTAINER_WORK_DIR='/workspace-root/custom-repo'");
    expect(sandboxCommands).toContain('cd /var/lib/vm-agent');
    expect(sandboxCommands).not.toContain("cd '/workspace-root/custom-repo'");
  });
});
