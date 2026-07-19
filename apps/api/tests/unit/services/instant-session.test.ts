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
    getCfContainerCreateWorkspaceTimeoutMs: vi.fn(),
    startAgentSessionOnNode: vi.fn(),
    waitForNodeAgentReady: vi.fn(),
  },
  nodes: {
    createNodeRecord: vi.fn(),
  },
  projectData: {
    createAcpSession: vi.fn(),
    createSession: vi.fn(),
    getAcpSession: vi.fn(),
    persistMessage: vi.fn(),
    transitionAcpSession: vi.fn(),
    failSession: vi.fn(),
  },
  container: {
    destroyVmAgentContainer: vi.fn(),
    getVmAgentContainerConfig: vi.fn(),
    launchVmAgentContainer: vi.fn(),
    requireVmAgentContainer: vi.fn(),
    runContainerPhase: vi.fn(),
  },
  ulid: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => mocks.jwt);
vi.mock('../../../src/services/mcp-token', () => mocks.mcp);
vi.mock('../../../src/services/node-agent', () => mocks.nodeAgent);
vi.mock('../../../src/services/nodes', () => mocks.nodes);
vi.mock('../../../src/services/project-data', () => mocks.projectData);
vi.mock('../../../src/services/vm-agent-container', () => mocks.container);
vi.mock('../../../src/lib/ulid', () => ({ ulid: mocks.ulid }));

import { launchInstantSession } from '../../../src/services/instant-session';

function makeDb(selectResults: unknown[][] = []) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  let selectIndex = 0;
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
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi
              .fn()
              .mockImplementation(() => Promise.resolve(selectResults[selectIndex++] ?? [])),
          })),
        })),
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
  CF_CONTAINER_ENABLED: 'true',
  CF_CONTAINER_PORT_READY_TIMEOUT_MS: '30000',
  CF_CONTAINER_VM_AGENT_PORT: '8080',
} as never;

describe('launchInstantSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ulid.mockReturnValueOnce('workspace-1').mockReturnValueOnce('agent-session-1');
    mocks.jwt.signCallbackToken.mockResolvedValue('workspace-callback-token');
    mocks.jwt.signNodeCallbackToken.mockResolvedValue('node-callback-token');
    mocks.mcp.generateMcpToken.mockReturnValue('mcp-token');
    mocks.mcp.revokeMcpToken.mockResolvedValue(undefined);
    mocks.mcp.storeMcpToken.mockResolvedValue(undefined);
    mocks.nodeAgent.createAgentSessionOnNode.mockResolvedValue({});
    mocks.nodeAgent.createWorkspaceOnNode.mockResolvedValue({});
    mocks.nodeAgent.getCfContainerCreateWorkspaceTimeoutMs.mockReturnValue(120_000);
    mocks.nodeAgent.startAgentSessionOnNode.mockResolvedValue({});
    mocks.nodeAgent.waitForNodeAgentReady.mockResolvedValue(undefined);
    mocks.nodes.createNodeRecord.mockResolvedValue({ id: 'node-1' });
    mocks.projectData.createAcpSession.mockResolvedValue({ id: 'agent-session-1' });
    mocks.projectData.getAcpSession.mockResolvedValue(null);
    mocks.projectData.createSession.mockResolvedValue('chat-session-1');
    mocks.projectData.persistMessage.mockResolvedValue(undefined);
    mocks.projectData.transitionAcpSession.mockResolvedValue({});
    mocks.projectData.failSession.mockResolvedValue(undefined);
    mocks.container.getVmAgentContainerConfig.mockReturnValue({
      vmAgentPort: 8080,
      enabled: true,
      sleepAfter: '10m',
    });
    mocks.container.destroyVmAgentContainer.mockResolvedValue(undefined);
    mocks.container.launchVmAgentContainer.mockResolvedValue(undefined);
    mocks.container.runContainerPhase.mockImplementation((_phase, _detail, fn) => fn());
  });

  it('creates a linked cf-container workspace, ACP session, and running agent session', async () => {
    const { db, inserts, updates } = makeDb();

    const result = await launchInstantSession(db as never, env, {
      taskId: 'task-1',
      project,
      userId: 'user-1',
      initialPrompt: 'enriched prompt',
      displayMessage: 'clean prompt',
      contextSummary: 'fork context',
      agentType: 'claude-code',
      agentProfileId: 'profile-1',
      skillId: 'skill-1',
      overrides: { model: 'claude-sonnet-4-5-20250929', effort: 'auto' },
    });

    expect(result).toMatchObject({
      runtime: 'cf-container',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      chatSessionId: 'chat-session-1',
      agentSessionId: 'agent-session-1',
    });
    expect(result.timings).toEqual(
      expect.objectContaining({
        totalDurationMs: expect.any(Number),
        preContainerDurationMs: expect.any(Number),
        containerLaunchDurationMs: expect.any(Number),
        setupDurationMs: expect.any(Number),
        installDurationMs: expect.any(Number),
        agentReadyDurationMs: expect.any(Number),
        workspaceCreateDurationMs: expect.any(Number),
        acpSessionCreateDurationMs: expect.any(Number),
        acpSessionStartDurationMs: expect.any(Number),
      })
    );
    expect(result.timings.setupDurationMs).toBe(result.timings.totalDurationMs);
    expect(result.timings.installDurationMs).toBe(result.timings.containerLaunchDurationMs);
    // Bounded phase timings must be non-negative and never exceed the total.
    expect(result.timings.preContainerDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.containerLaunchDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.preContainerDurationMs).toBeLessThanOrEqual(
      result.timings.totalDurationMs
    );

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
      'task-1',
      'user-1'
    );
    expect(mocks.projectData.persistMessage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'project-1',
      'chat-session-1',
      'system',
      'fork context',
      null
    );
    expect(mocks.projectData.persistMessage).toHaveBeenNthCalledWith(
      2,
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
      agentProfileId: 'profile-1',
      skillId: 'skill-1',
    });
    expect(updates).toContainEqual(
      expect.objectContaining({
        agentProfileId: 'profile-1',
        skillId: 'skill-1',
      })
    );
    expect(mocks.mcp.storeMcpToken).toHaveBeenCalledWith(
      expect.anything(),
      'mcp-token',
      expect.objectContaining({
        taskId: 'task-1',
        contextType: 'conversation',
        taskMode: 'conversation',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        chatSessionId: 'chat-session-1',
        agentSessionId: 'agent-session-1',
      }),
      expect.anything()
    );
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
      { model: 'claude-sonnet-4-5-20250929', effort: 'auto' },
      { projectId: 'project-1', taskId: 'task-1', taskMode: 'conversation' },
      expect.stringContaining('MUST call')
    );
    expect(mocks.nodeAgent.startAgentSessionOnNode.mock.calls[0][4]).toBe('enriched prompt');
    expect(mocks.container.launchVmAgentContainer).toHaveBeenCalledWith(
      expect.anything(),
      'node-1',
      expect.objectContaining({
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        chatSessionId: 'chat-session-1',
        repository: 'owner/repo',
        branch: 'main',
        workspaceDir: '/workspaces/repo',
        controlPlaneUrl: 'https://api.example.com',
        vmAgentPort: 8080,
      }),
      { nodeCallbackToken: 'node-callback-token' }
    );
    const launchConfig = mocks.container.launchVmAgentContainer.mock.calls[0][2];
    expect(JSON.stringify(launchConfig)).not.toContain('node-callback-token');
    expect(JSON.stringify(launchConfig)).not.toContain('profile-1');
    expect(JSON.stringify(launchConfig)).not.toContain('skill-1');
    expect(updates).toContainEqual(expect.objectContaining({ dispatchedAt: expect.any(String) }));
    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'in_progress', workspaceId: 'workspace-1' })
    );
  });

  it('passes GitLab repository metadata to the VM agent create-workspace request', async () => {
    const gitlabMetadata = {
      userId: 'user-1',
      host: 'gitlab.com',
      gitlabProjectId: 12345,
      pathWithNamespace: 'group/gitlab-repo',
      webUrl: 'https://gitlab.com/group/gitlab-repo',
      httpUrlToRepo: 'https://gitlab.com/group/gitlab-repo.git',
      defaultBranch: 'main',
    };
    const { db } = makeDb([[gitlabMetadata]]);

    await launchInstantSession(db as never, env, {
      project: {
        ...project,
        id: 'gitlab-project-1',
        repository: 'group/gitlab-repo',
        repoProvider: 'gitlab',
        installationId: '',
      } as never,
      userId: 'user-1',
      initialPrompt: 'prompt',
      displayMessage: 'prompt',
      agentType: 'claude-code',
    });

    expect(mocks.nodeAgent.createWorkspaceOnNode).toHaveBeenCalledWith(
      'node-1',
      env,
      'user-1',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        repository: 'group/gitlab-repo',
        branch: 'main',
        repoProvider: 'gitlab',
        cloneUrl: 'https://gitlab.com/group/gitlab-repo.git',
        repositoryHost: 'gitlab.com',
        repositoryPath: 'group/gitlab-repo',
        callbackToken: 'workspace-callback-token',
        lightweight: true,
      }),
      { requestTimeoutMs: 120_000 }
    );
  });

  // Regression test for the 2026-07-18 instant-container outage: the standalone
  // vm-agent clones synchronously inside the create-workspace request, so the
  // instant path MUST use the cf-container create budget instead of the
  // interactive node-agent default (30s). This fails on pre-fix code, which
  // passed no timeout override.
  it('runs create-workspace under the configured cf-container create budget', async () => {
    const { db } = makeDb();
    mocks.nodeAgent.getCfContainerCreateWorkspaceTimeoutMs.mockReturnValue(90_000);

    await launchInstantSession(db as never, env, {
      taskId: 'task-1',
      project,
      userId: 'user-1',
      initialPrompt: 'prompt',
      displayMessage: 'prompt',
      agentType: 'claude-code',
    } as never);

    expect(mocks.nodeAgent.getCfContainerCreateWorkspaceTimeoutMs).toHaveBeenCalledWith(env);
    expect(mocks.nodeAgent.createWorkspaceOnNode).toHaveBeenCalledWith(
      'node-1',
      env,
      'user-1',
      expect.objectContaining({ workspaceId: 'workspace-1', lightweight: true }),
      { requestTimeoutMs: 90_000 }
    );
  });

  it('marks the workspace error and destroys the container when launch fails', async () => {
    const { db, updates } = makeDb();
    mocks.nodeAgent.waitForNodeAgentReady.mockRejectedValueOnce(
      new Error('agent never became ready')
    );

    await expect(
      launchInstantSession(db as never, env, {
        taskId: 'task-1',
        project,
        userId: 'user-1',
        initialPrompt: 'prompt',
        displayMessage: 'prompt',
        agentType: 'claude-code',
        agentProfileId: 'profile-1',
        skillId: 'skill-1',
        overrides: { model: 'claude-sonnet-4-5-20250929', effort: 'auto' },
      })
    ).rejects.toThrow('agent never became ready');

    // The best-effort cleanup must tear down the launched container and mark
    // the workspace errored so a failed cold start does not leak resources.
    expect(mocks.container.destroyVmAgentContainer).toHaveBeenCalledWith(env, 'node-1');
    expect(updates).toContainEqual(expect.objectContaining({ status: 'error' }));
  });

  // Capacity containment for the create-workspace timeout (security review):
  // the Worker-side race does not abort the in-container clone, so the ONLY
  // bound on a stalled create's container-slot hold is this immediate destroy.
  // A timed-out create must tear the container down, not leave it running.
  it('destroys the container when create-workspace times out', async () => {
    const { db, updates } = makeDb();
    mocks.nodeAgent.createWorkspaceOnNode.mockRejectedValueOnce(
      new Error('Request timed out after 120000ms')
    );

    await expect(
      launchInstantSession(db as never, env, {
        taskId: 'task-1',
        project,
        userId: 'user-1',
        initialPrompt: 'prompt',
        displayMessage: 'prompt',
        agentType: 'claude-code',
      })
    ).rejects.toThrow('Request timed out after 120000ms');

    expect(mocks.container.destroyVmAgentContainer).toHaveBeenCalledWith(env, 'node-1');
    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'error', errorMessage: 'Request timed out after 120000ms' })
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'failed', executionStep: 'launch_failed' })
    );
  });

  it('honors a configured raw container workspace base directory', async () => {
    const { db } = makeDb();
    const envWithWorkspaceBase = {
      ...(env as Record<string, unknown>),
      CF_CONTAINER_WORKSPACE_BASE_DIR: '/workspace-root',
    } as never;

    await launchInstantSession(db as never, envWithWorkspaceBase, {
      taskId: 'task-1',
      project: { ...project, repository: 'https://github.com/owner/custom-repo.git' } as never,
      userId: 'user-1',
      initialPrompt: 'prompt',
      displayMessage: 'prompt',
      agentType: 'claude-code',
    });

    expect(mocks.container.launchVmAgentContainer).toHaveBeenCalledWith(
      expect.anything(),
      'node-1',
      expect.objectContaining({
        workspaceDir: '/workspace-root/custom-repo',
      }),
      expect.anything()
    );
  });
});
