/**
 * Regression coverage for the TaskRunner branch-creation token path.
 *
 * This keeps the internal TaskRunner -> GitHub service path real and mocks only
 * the external boundaries: D1 and GitHub HTTP.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

vi.mock('jose', () => {
  class MockSignJWT {
    setProtectedHeader() { return this; }
    setIssuedAt() { return this; }
    setIssuer() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'mock-jwt'; }
  }
  return {
    importPKCS8: vi.fn().mockResolvedValue('mock-key'),
    SignJWT: MockSignJWT,
  };
});

vi.mock('../../../../src/lib/runtime-validation', () => ({
  readResponseJson: vi.fn().mockImplementation(async (response: Response) => response.json()),
  expectJsonRecord: vi.fn().mockImplementation((value: unknown) => value),
}));

import type { TaskRunnerContext, TaskRunnerState } from '../../../../src/durable-objects/task-runner/types';
import { ensureBranchExistsOnRemote } from '../../../../src/durable-objects/task-runner/workspace-steps';

function makeState(): TaskRunnerState {
  return {
    taskId: 'task-test-001',
    projectId: 'proj-test-001',
    userId: 'user-test-001',
    completed: false,
    currentStep: 'workspace_creation',
    stepResults: {},
    retryCount: 0,
    config: {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      branch: 'feature/my-branch',
      defaultBranch: 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'test@test.com',
      githubId: 'gh-12345',
      taskTitle: 'Test task',
      taskDescription: 'Test description',
      repository: 'acme/widgets',
      installationId: '01KTDBROW000000000000000001',
      outputBranch: null,
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'claude-code',
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      taskMode: 'task',
      model: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      attachments: null,
    },
  } as unknown as TaskRunnerState;
}

function makeContext(): TaskRunnerContext {
  const first = vi.fn().mockResolvedValue({
    installationId: 'legacy-external-123',
    externalInstallationId: '987654321',
  });
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });

  return {
    env: {
      DATABASE: { prepare },
      GITHUB_APP_ID: 'test-app-id',
      GITHUB_APP_PRIVATE_KEY: btoa('test-private-key'),
    },
  } as unknown as TaskRunnerContext;
}

describe('ensureBranchExistsOnRemote token path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes the external GitHub installation id all the way to getInstallationToken', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        Response.json({ token: 'test-installation-token', expires_at: '2026-12-31T00:00:00Z' }),
      )
      .mockResolvedValueOnce(Response.json({ name: 'feature/my-branch' }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureBranchExistsOnRemote(makeState(), makeContext());

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/app/installations/987654321/access_tokens',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('01KTDBROW000000000000000001'),
      expect.anything(),
    );
  });
});
