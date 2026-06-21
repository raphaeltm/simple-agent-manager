import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAssertAgentDeploymentAllowed = vi.fn();
const mockConsumeRegistryCredentialRateLimit = vi.fn();
const mockMintProjectRegistryCredential = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mocked: true })),
}));

vi.mock('../../src/services/deployment-control', () => ({
  assertAgentDeploymentAllowed: (...args: unknown[]) => mockAssertAgentDeploymentAllowed(...args),
}));

vi.mock('../../src/services/registry-credentials', () => ({
  consumeRegistryCredentialRateLimit: (...args: unknown[]) =>
    mockConsumeRegistryCredentialRateLimit(...args),
  mintProjectRegistryCredential: (...args: unknown[]) => mockMintProjectRegistryCredential(...args),
}));

vi.mock('../../src/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { handleGetRegistryCredentials } =
  await import('../../src/routes/mcp/registry-credential-tools');

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
  return {
    DATABASE: {},
  } as any;
}

describe('handleGetRegistryCredentials policy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests without a deployment environment before minting credentials', async () => {
    const result = await handleGetRegistryCredentials('req-1', {}, tokenData(), env());

    expect(result.error?.message).toContain('deployment environment name is required');
    expect(mockAssertAgentDeploymentAllowed).not.toHaveBeenCalled();
    expect(mockMintProjectRegistryCredential).not.toHaveBeenCalled();
  });

  it('rejects policy-denied environments before rate limiting or minting credentials', async () => {
    mockAssertAgentDeploymentAllowed.mockResolvedValue({
      error: 'Agent deployment is disabled for environment staging.',
    });
    const mockEnv = env();

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'staging' },
      tokenData(),
      mockEnv
    );

    expect(result.error?.message).toContain('Agent deployment is disabled');
    expect(mockConsumeRegistryCredentialRateLimit).not.toHaveBeenCalled();
    expect(mockMintProjectRegistryCredential).not.toHaveBeenCalled();
  });
});
