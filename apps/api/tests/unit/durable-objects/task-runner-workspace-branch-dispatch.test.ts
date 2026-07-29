import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorkspaceOnNode: vi.fn(),
  signCallbackToken: vi.fn(),
  resolveWorkspaceGitSource: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  createWorkspaceOnNode: mocks.createWorkspaceOnNode,
}));
vi.mock('../../../src/services/jwt', () => ({ signCallbackToken: mocks.signCallbackToken }));
vi.mock('../../../src/services/workspace-git-source', () => ({
  resolveWorkspaceGitSource: mocks.resolveWorkspaceGitSource,
}));

import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { handleWorkspaceDispatch } from '../../../src/durable-objects/task-runner/workspace-steps';

function makeState(branch: string, outputBranch: string): TaskRunnerState {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    completed: false,
    currentStep: 'workspace_dispatch',
    stepResults: { nodeId: 'node-1', workspaceId: 'workspace-1' },
    retryCount: 0,
    workspaceDispatchAttempts: 0,
    workspaceDispatchStartedAt: null,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchAckedAt: null,
    workspaceDispatchLastError: null,
    config: {
      repository: 'owner/repository',
      branch,
      outputBranch,
      defaultBranch: 'main',
      installationId: 'installation-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
      githubId: '42',
      workspaceProfile: 'lightweight',
      devcontainerConfigName: null,
    },
  } as TaskRunnerState;
}

function makeContext(): TaskRunnerContext {
  const prepare = vi.fn((query: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (query.includes('SELECT dispatched_at')) return { dispatched_at: null };
        if (query.includes('FROM projects'))
          return { repoProvider: 'github', installationId: 'installation-1' };
        return null;
      }),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    })),
  }));
  return {
    env: { DATABASE: { prepare } },
    ctx: { storage: { put: vi.fn(), setAlarm: vi.fn() } },
    updateD1ExecutionStep: vi.fn(),
    advanceToStep: vi.fn(),
    getWorkspaceDispatchTimeoutMs: vi.fn(() => 30_000),
    getWorkspaceDispatchBaseDelayMs: vi.fn(() => 100),
    getWorkspaceDispatchMaxDelayMs: vi.fn(() => 1_000),
  } as unknown as TaskRunnerContext;
}

describe('TaskRunner workspace branch dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signCallbackToken.mockResolvedValue('callback-token');
    mocks.resolveWorkspaceGitSource.mockResolvedValue({
      repoProvider: 'github',
      cloneUrl: 'https://github.com/owner/repository.git',
      repositoryHost: 'github.com',
      repositoryPath: 'owner/repository',
    });
    mocks.createWorkspaceOnNode.mockResolvedValue({
      workspaceId: 'workspace-1',
      status: 'creating',
    });
  });

  it.each([
    {
      scenario: 'generated output branch',
      configuredBranch: 'sam/generated-output-abc123',
      outputBranch: 'sam/generated-output-abc123',
      checkoutBranch: 'sam/generated-output-abc123',
      baseBranch: 'main',
    },
    {
      scenario: 'explicit non-default branch with separate output branch',
      configuredBranch: 'feature/existing-work',
      outputBranch: 'sam/continuation-output-def456',
      checkoutBranch: 'sam/continuation-output-def456',
      baseBranch: 'feature/existing-work',
    },
    {
      scenario: 'explicit default branch with separate output branch',
      configuredBranch: 'main',
      outputBranch: 'sam/default-safe-output-ghi789',
      checkoutBranch: 'sam/default-safe-output-ghi789',
      baseBranch: 'main',
    },
  ])(
    'checks out the task output branch for $scenario',
    async ({ configuredBranch, outputBranch, checkoutBranch, baseBranch }) => {
      await handleWorkspaceDispatch(makeState(configuredBranch, outputBranch), makeContext());
      expect(mocks.createWorkspaceOnNode).toHaveBeenCalledOnce();
      expect(mocks.createWorkspaceOnNode).toHaveBeenCalledWith(
        'node-1',
        expect.any(Object),
        'user-1',
        expect.objectContaining({
          workspaceId: 'workspace-1',
          branch: checkoutBranch,
          baseBranch,
          defaultBranch: 'main',
        })
      );
    }
  );
});
