import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAssertAgentDeploymentAllowed = vi.fn();
const mockLoadDeploymentBuildInterpolationEnv = vi.fn();
const mockLookupWorkspaceForVmAgent = vi.fn();
const mockStartBuildPublishJobOnVm = vi.fn();
const mockCreateDeploymentPublishJob = vi.fn();
const mockAppendDeploymentPublishJobEvent = vi.fn();
const mockGetDeploymentPublishJobForMcp = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../src/services/deployment-control', () => ({
  assertAgentDeploymentAllowed: (...args: unknown[]) => mockAssertAgentDeploymentAllowed(...args),
}));

vi.mock('../../src/services/deployment-environment-config', () => ({
  loadDeploymentBuildInterpolationEnv: (...args: unknown[]) =>
    mockLoadDeploymentBuildInterpolationEnv(...args),
}));

vi.mock('../../src/services/deployment-publish-jobs', () => ({
  appendDeploymentPublishJobEvent: (...args: unknown[]) =>
    mockAppendDeploymentPublishJobEvent(...args),
  createDeploymentPublishJob: (...args: unknown[]) => mockCreateDeploymentPublishJob(...args),
  getDeploymentPublishJobForMcp: (...args: unknown[]) => mockGetDeploymentPublishJobForMcp(...args),
  sanitizePublishEventText: (value: unknown) =>
    String(value).replace(/X-Amz-Signature=[^&\s"]+/g, 'X-Amz-Signature=[redacted]'),
}));

vi.mock('../../src/routes/mcp/workspace-tools', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/mcp/workspace-tools')>(
    '../../src/routes/mcp/workspace-tools'
  );
  return {
    ...actual,
    lookupWorkspaceForVmAgent: (...args: unknown[]) => mockLookupWorkspaceForVmAgent(...args),
    startBuildPublishJobOnVm: (...args: unknown[]) => mockStartBuildPublishJobOnVm(...args),
  };
});

const { handleBuildAndPublish, handleGetPublishStatus } =
  await import('../../src/routes/mcp/compose-publish-tools');

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
  return { DATABASE: {}, BUILD_PUBLISH_START_TIMEOUT_MS: '12345' } as any;
}

describe('async build_and_publish MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      environmentId: 'env-1',
      policy: { agentDeployEnabled: true, allowedDeployProfileIds: [] },
      taskAgentProfileId: 'profile-1',
    });
    mockLoadDeploymentBuildInterpolationEnv.mockResolvedValue({
      values: { PUBLIC_APP_DOMAIN: 'staging.example.com' },
      plainKeys: ['PUBLIC_APP_DOMAIN'],
      secretKeys: ['DATABASE_URL'],
      configUpdatedAt: null,
      totalBytes: 43,
    });
    mockLookupWorkspaceForVmAgent.mockResolvedValue({
      id: 'ws-1',
      status: 'running',
      nodeId: 'node-1',
      projectId: 'proj-1',
    });
    mockCreateDeploymentPublishJob.mockResolvedValue({ id: 'job-1' });
    mockStartBuildPublishJobOnVm.mockResolvedValue({ publishJobId: 'job-1', status: 'accepted' });
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
  });

  it('still enforces deployment environment policy before creating a job', async () => {
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
    expect(mockCreateDeploymentPublishJob).not.toHaveBeenCalled();
    expect(mockStartBuildPublishJobOnVm).not.toHaveBeenCalled();
  });

  it('creates a durable job, starts the VM job with a short timeout, and returns polling instructions', async () => {
    const result = await handleBuildAndPublish(
      'req-1',
      {
        environment: ' staging ',
        reference: ' v1 ',
        workingDir: ' /workspaces/app-wt-feature ',
      },
      tokenData(),
      env()
    );

    expect(result.error).toBeUndefined();
    expect(mockCreateDeploymentPublishJob).toHaveBeenCalledWith(expect.anything(), {
      projectId: 'proj-1',
      environmentId: 'env-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      taskId: 'task-1',
      agentProfileId: 'profile-1',
      requestedBy: 'user-1',
      environmentName: 'staging',
      reference: 'v1',
      workingDir: '/workspaces/app-wt-feature',
    });
    expect(mockStartBuildPublishJobOnVm).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      'user-1',
      'proj-1',
      'node-1',
      'job-1',
      expect.objectContaining({
        publishJobId: 'job-1',
        environment: 'staging',
        environmentId: 'env-1',
        reference: 'v1',
        workingDir: '/workspaces/app-wt-feature',
        buildInterpolationEnv: { PUBLIC_APP_DOMAIN: 'staging.example.com' },
        secretInterpolationKeys: ['DATABASE_URL'],
      }),
      12345
    );
    expect(mockAppendDeploymentPublishJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishJobId: 'job-1', eventType: 'publish.job.accepted' })
    );

    const payload = JSON.parse(result.result?.content?.[0]?.text as string);
    expect(payload).toMatchObject({
      publishJobId: 'job-1',
      status: 'starting',
      pollTool: 'get_publish_status',
    });
  });

  it('persists a failed terminal job when VM start fails and redacts signed URL details', async () => {
    mockStartBuildPublishJobOnVm.mockRejectedValue(
      new Error('Put https://r2.example/object?X-Amz-Signature=secret failed')
    );

    const result = await handleBuildAndPublish(
      'req-1',
      { environment: 'staging' },
      tokenData(),
      env()
    );

    expect(result.error).toBeUndefined();
    expect(mockAppendDeploymentPublishJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publishJobId: 'job-1',
        status: 'failed',
        terminal: true,
        errorCode: 'failed_to_start',
        message: expect.not.stringContaining('X-Amz-Signature=secret'),
      })
    );
    const payload = JSON.parse(result.result?.content?.[0]?.text as string);
    expect(payload.status).toBe('failed');
    expect(payload.publishJobId).toBe('job-1');
  });

  it('polls publish status scoped to the MCP workspace and returns the job view', async () => {
    mockGetDeploymentPublishJobForMcp.mockResolvedValue({
      publishJobId: 'job-1',
      status: 'uploading',
      events: [{ seq: 3, eventType: 'publish.upload.started' }],
      nextSinceSeq: 3,
      pollAfterSeconds: 15,
    });

    const result = await handleGetPublishStatus(
      'req-2',
      { publishJobId: 'job-1', sinceSeq: 2, limit: 20 },
      tokenData(),
      env()
    );

    expect(mockGetDeploymentPublishJobForMcp).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'job-1',
      {
        workspaceId: 'ws-1',
        sinceSeq: 2,
        limit: 20,
      }
    );
    const payload = JSON.parse(result.result?.content?.[0]?.text as string);
    expect(payload.status).toBe('uploading');
    expect(payload.nextSinceSeq).toBe(3);
  });

  it('rejects polling for jobs outside the workspace scope', async () => {
    mockGetDeploymentPublishJobForMcp.mockResolvedValue(null);

    const result = await handleGetPublishStatus(
      'req-2',
      { publishJobId: 'job-other' },
      tokenData(),
      env()
    );

    expect(result.error?.message).toContain('Publish job not found');
  });
});
