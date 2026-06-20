import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAssertAgentDeploymentAllowed = vi.fn();
const mockProxyToVmAgentWithNodeManagement = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mocked: true })),
}));

vi.mock('../../src/services/deployment-control', () => ({
  assertAgentDeploymentAllowed: (...args: unknown[]) => mockAssertAgentDeploymentAllowed(...args),
}));

vi.mock('../../src/routes/mcp/workspace-tools', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/mcp/workspace-tools')>(
    '../../src/routes/mcp/workspace-tools'
  );
  return {
    ...actual,
    proxyToVmAgentWithNodeManagement: (...args: unknown[]) =>
      mockProxyToVmAgentWithNodeManagement(...args),
  };
});

const { handleBuildAndPublish } = await import('../../src/routes/mcp/compose-publish-tools');

function tokenData(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    createdAt: '2026-06-18T00:00:00Z',
    ...overrides,
  } as any;
}

function env() {
  return { DATABASE: {} } as any;
}

describe('handleBuildAndPublish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when there is no active workspace', async () => {
    const result = await handleBuildAndPublish(
      'req-1',
      {},
      tokenData({ workspaceId: undefined }),
      env()
    );

    expect(result.error?.message).toContain('No active workspace');
    expect(mockAssertAgentDeploymentAllowed).not.toHaveBeenCalled();
    expect(mockProxyToVmAgentWithNodeManagement).not.toHaveBeenCalled();
  });

  it('rejects when no target environment is provided', async () => {
    const result = await handleBuildAndPublish('req-1', {}, tokenData(), env());

    expect(result.error?.message).toContain('deployment environment name is required');
    expect(mockAssertAgentDeploymentAllowed).not.toHaveBeenCalled();
    expect(mockProxyToVmAgentWithNodeManagement).not.toHaveBeenCalled();
  });

  it('rejects when agent deployment is not enabled for the target environment', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      error: 'Agent deployment is disabled for environment staging.',
    });

    const result = await handleBuildAndPublish(
      'req-1',
      { environment: 'staging' },
      tokenData(),
      env()
    );

    expect(result.error?.message).toContain('Agent deployment is disabled');
    expect(mockAssertAgentDeploymentAllowed).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'staging',
      tokenData()
    );
    expect(mockProxyToVmAgentWithNodeManagement).not.toHaveBeenCalled();
  });

  it('proxies to the vm-agent build-and-publish path and returns the release result', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: { agentDeployEnabled: true, allowedDeployProfileIds: [] },
      taskAgentProfileId: 'profile-1',
    });
    mockProxyToVmAgentWithNodeManagement.mockResolvedValue({
      releaseId: 'rel-1',
      version: 1,
      status: 'created',
    });

    const result = await handleBuildAndPublish(
      'req-1',
      { environment: ' staging ' },
      tokenData(),
      env()
    );

    expect(result.error).toBeUndefined();
    expect(mockProxyToVmAgentWithNodeManagement).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'build-and-publish',
      'POST',
      {
        environment: 'staging',
        environmentId: 'env-1',
        submittedBy: {
          userId: 'user-1',
          workspaceId: 'ws-1',
          taskId: 'task-1',
          agentProfileId: 'profile-1',
        },
      },
      expect.any(Number)
    );

    const text = result.result?.content?.[0]?.text as string;
    const payload = JSON.parse(text);
    expect(payload.releaseId).toBe('rel-1');
    expect(payload.status).toBe('created');
  });

  it('forwards a trimmed reference argument to the vm-agent', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: {},
      taskAgentProfileId: null,
    });
    mockProxyToVmAgentWithNodeManagement.mockResolvedValue({
      releaseId: 'rel-2',
      version: 2,
      status: 'created',
    });

    await handleBuildAndPublish(
      'req-1',
      { environment: 'staging', reference: '  v2  ' },
      tokenData(),
      env()
    );

    expect(mockProxyToVmAgentWithNodeManagement).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'build-and-publish',
      'POST',
      expect.objectContaining({ environment: 'staging', environmentId: 'env-1', reference: 'v2' }),
      expect.any(Number)
    );
  });

  it('ignores a blank reference argument', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: {},
      taskAgentProfileId: null,
    });
    mockProxyToVmAgentWithNodeManagement.mockResolvedValue({
      releaseId: 'rel-3',
      version: 3,
      status: 'created',
    });

    await handleBuildAndPublish(
      'req-1',
      { environment: 'staging', reference: '   ' },
      tokenData(),
      env()
    );

    expect(mockProxyToVmAgentWithNodeManagement).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'build-and-publish',
      'POST',
      expect.objectContaining({ environment: 'staging', environmentId: 'env-1' }),
      expect.any(Number)
    );
  });

  it('forwards a trimmed workingDir argument to the vm-agent', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: {},
      taskAgentProfileId: null,
    });
    mockProxyToVmAgentWithNodeManagement.mockResolvedValue({
      releaseId: 'rel-4',
      version: 4,
      status: 'created',
    });

    await handleBuildAndPublish(
      'req-1',
      { environment: 'staging', workingDir: '  /workspaces/crewai-wt-feature  ' },
      tokenData(),
      env()
    );

    expect(mockProxyToVmAgentWithNodeManagement).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'build-and-publish',
      'POST',
      expect.objectContaining({
        environment: 'staging',
        environmentId: 'env-1',
        workingDir: '/workspaces/crewai-wt-feature',
      }),
      expect.any(Number)
    );
  });

  it('forwards both reference and workingDir when provided together', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: {},
      taskAgentProfileId: null,
    });
    mockProxyToVmAgentWithNodeManagement.mockResolvedValue({
      releaseId: 'rel-5',
      version: 5,
      status: 'created',
    });

    await handleBuildAndPublish(
      'req-1',
      { environment: 'staging', reference: 'v5', workingDir: '/workspaces/crewai-wt-feature' },
      tokenData(),
      env()
    );

    expect(mockProxyToVmAgentWithNodeManagement).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'build-and-publish',
      'POST',
      expect.objectContaining({
        environment: 'staging',
        environmentId: 'env-1',
        reference: 'v5',
        workingDir: '/workspaces/crewai-wt-feature',
      }),
      expect.any(Number)
    );
  });

  it('ignores a blank or non-string workingDir argument', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: {},
      taskAgentProfileId: null,
    });
    mockProxyToVmAgentWithNodeManagement.mockResolvedValue({
      releaseId: 'rel-6',
      version: 6,
      status: 'created',
    });

    await handleBuildAndPublish(
      'req-1',
      { environment: 'staging', workingDir: '   ', reference: 42 as unknown as string },
      tokenData(),
      env()
    );

    expect(mockProxyToVmAgentWithNodeManagement).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'build-and-publish',
      'POST',
      expect.objectContaining({ environment: 'staging', environmentId: 'env-1' }),
      expect.any(Number)
    );
  });

  it('surfaces a vm-agent failure as an internal error', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: {},
      taskAgentProfileId: null,
    });
    mockProxyToVmAgentWithNodeManagement.mockRejectedValue(
      new Error('VM agent returned 500: build failed')
    );

    const result = await handleBuildAndPublish(
      'req-1',
      { environment: 'staging' },
      tokenData(),
      env()
    );

    expect(result.error?.message).toContain('Build and publish failed');
    expect(result.error?.message).toContain('build failed');
  });
});
