import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsProjectAgentDeployEnabled = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mocked: true })),
}));

vi.mock('../../src/services/deployment-control', () => ({
  isProjectAgentDeployEnabled: (...args: unknown[]) => mockIsProjectAgentDeployEnabled(...args),
}));

const { handleGetComposePublishInstructions } = await import(
  '../../src/routes/mcp/compose-publish-tools'
);

function tokenData() {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    createdAt: '2026-06-18T00:00:00Z',
  };
}

function env() {
  return { DATABASE: {} } as any;
}

describe('handleGetComposePublishInstructions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when agent deployment is not enabled for the project', async () => {
    mockIsProjectAgentDeployEnabled.mockResolvedValue(false);

    const result = await handleGetComposePublishInstructions('req-1', {}, tokenData(), env());

    expect(result.error?.message).toContain('Agent deployment is disabled');
    expect(mockIsProjectAgentDeployEnabled).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
    );
  });

  it('returns publish instructions referencing the receiver env var and never raw credentials', async () => {
    mockIsProjectAgentDeployEnabled.mockResolvedValue(true);

    const result = await handleGetComposePublishInstructions('req-1', {}, tokenData(), env());

    expect(result.error).toBeUndefined();
    const text = result.result?.content?.[0]?.text as string;
    const payload = JSON.parse(text);

    expect(payload.publishHostEnvVar).toBe('SAM_REGISTRY_PUBLISH_HOST');
    expect(payload.requestRawCredentials).toBe(false);
    expect(Array.isArray(payload.instructions)).toBe(true);
    expect(payload.instructions.join('\n')).toContain('docker compose publish');
    // Must NOT instruct the agent to perform a raw docker login / push itself.
    expect(text).not.toContain('docker login');
    expect(text).not.toContain('password');
  });
});
