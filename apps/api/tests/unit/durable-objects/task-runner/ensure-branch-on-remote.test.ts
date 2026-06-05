/**
 * Tests for ensureBranchExistsOnRemote() — the DO-layer wrapper that calls
 * ensureBranchExists() from github-app.ts before workspace provisioning.
 *
 * Verifies:
 * 1. Default branch short-circuit (no GitHub API call)
 * 2. Invalid repository string handling
 * 3. Successful branch creation propagation
 * 4. Error handling (best-effort — failures don't throw)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  ensureBranchExists: vi.fn(),
}));

vi.mock('../../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

vi.mock('../../../../src/services/github-app', () => ({
  ensureBranchExists: mocks.ensureBranchExists,
}));

import type { TaskRunnerContext, TaskRunnerState } from '../../../../src/durable-objects/task-runner/types';
import { ensureBranchExistsOnRemote } from '../../../../src/durable-objects/task-runner/workspace-steps';

function makeState(overrides: {
  branch?: string;
  defaultBranch?: string;
  repository?: string;
}): TaskRunnerState {
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
      branch: overrides.branch ?? 'feature-branch',
      defaultBranch: overrides.defaultBranch ?? 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'test@test.com',
      githubId: 'gh-12345',
      taskTitle: 'Test task',
      taskDescription: 'Test description',
      repository: overrides.repository ?? 'owner/repo',
      installationId: 'inst-test-001',
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

const mockRc = {} as unknown as TaskRunnerContext;

describe('ensureBranchExistsOnRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips GitHub API call when branch matches defaultBranch', async () => {
    const state = makeState({ branch: 'main', defaultBranch: 'main' });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('skips when branch matches fallback default ("main") and defaultBranch is empty', async () => {
    const state = makeState({ branch: 'main', defaultBranch: '' });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('calls ensureBranchExists with correct args for non-default branch', async () => {
    mocks.ensureBranchExists.mockResolvedValue(true);
    const state = makeState({
      branch: 'feature/my-branch',
      defaultBranch: 'main',
      repository: 'acme/widgets',
    });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).toHaveBeenCalledWith(
      'inst-test-001',
      'acme',
      'widgets',
      'feature/my-branch',
      'main',
      undefined, // rc.env from the mock context
    );
    expect(mocks.log.info).toHaveBeenCalledWith('task_runner_do.ensure_branch.ok', {
      taskId: 'task-test-001',
      branch: 'feature/my-branch',
    });
  });

  it('logs warning when ensureBranchExists returns false', async () => {
    mocks.ensureBranchExists.mockResolvedValue(false);
    const state = makeState({ branch: 'feature-x', defaultBranch: 'develop' });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.log.warn).toHaveBeenCalledWith('task_runner_do.ensure_branch.failed', {
      taskId: 'task-test-001',
      branch: 'feature-x',
      defaultBranch: 'develop',
    });
  });

  it('catches errors without throwing (best-effort)', async () => {
    mocks.ensureBranchExists.mockRejectedValue(new Error('Network timeout'));
    const state = makeState({ branch: 'feature-x' });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.log.warn).toHaveBeenCalledWith('task_runner_do.ensure_branch.error', {
      taskId: 'task-test-001',
      branch: 'feature-x',
      error: 'Network timeout',
    });
  });

  it('warns and skips on invalid repository string', async () => {
    const state = makeState({ branch: 'feature-x', repository: 'invalid-repo' });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'task_runner_do.ensure_branch.invalid_repository',
      expect.objectContaining({ repository: 'invalid-repo' }),
    );
  });

  it('warns and skips on repository with empty owner', async () => {
    const state = makeState({ branch: 'feature-x', repository: '/repo' });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });
});
