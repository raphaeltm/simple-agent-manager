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
  installationId?: string;
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
      installationId: overrides.installationId ?? 'inst-test-001',
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

type InstallationRow = {
  installationId: string;
  externalInstallationId: string | null;
};

function makeContext(installation: InstallationRow | null = {
  installationId: 'legacy-external-123',
  externalInstallationId: '987654321',
}): TaskRunnerContext {
  const first = vi.fn().mockResolvedValue(installation);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });

  return {
    env: {
      DATABASE: {
        prepare,
      },
    },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

describe('ensureBranchExistsOnRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips GitHub API call when branch matches defaultBranch', async () => {
    const state = makeState({ branch: 'main', defaultBranch: 'main' });
    const mockRc = makeContext();

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('skips when branch matches fallback default ("main") and defaultBranch is empty', async () => {
    const state = makeState({ branch: 'main', defaultBranch: '' });
    const mockRc = makeContext();

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('calls ensureBranchExists with correct args for non-default branch', async () => {
    mocks.ensureBranchExists.mockResolvedValue({ status: 'created' });
    const state = makeState({
      branch: 'feature/my-branch',
      defaultBranch: 'main',
      installationId: '01KTDBROW000000000000000001',
      repository: 'acme/widgets',
    });
    const mockRc = makeContext({
      installationId: 'legacy-external-123',
      externalInstallationId: '987654321',
    });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).toHaveBeenCalledWith(
      '987654321',
      'acme',
      'widgets',
      'feature/my-branch',
      'main',
      mockRc.env,
    );
    expect(mocks.log.info).toHaveBeenCalledWith('task_runner_do.ensure_branch.ok', {
      taskId: 'task-test-001',
      branch: 'feature/my-branch',
      defaultBranch: 'main',
      detail: 'created',
    });
  });

  it('falls back to installation_id when external_installation_id is absent', async () => {
    mocks.ensureBranchExists.mockResolvedValue({ status: 'created' });
    const state = makeState({
      branch: 'feature/my-branch',
      defaultBranch: 'main',
      installationId: '01KTDBROW000000000000000001',
      repository: 'acme/widgets',
    });
    const mockRc = makeContext({
      installationId: '123456789',
      externalInstallationId: null,
    });

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).toHaveBeenCalledWith(
      '123456789',
      'acme',
      'widgets',
      'feature/my-branch',
      'main',
      mockRc.env,
    );
  });

  it('warns and skips when the configured installation row is missing', async () => {
    const state = makeState({
      branch: 'feature-x',
      installationId: '01KTMISSINGINSTALLATIONROW',
    });
    const mockRc = makeContext(null);

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
    // A missing installation row means the check could NOT run — it is not
    // evidence that the ref is absent, so it must surface as `unknown`.
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'task_runner_do.ensure_branch.unknown',
      expect.objectContaining({
        taskId: 'task-test-001',
        branch: 'feature-x',
        reason: 'GitHub installation not found for this user',
      }),
    );
  });

  it('logs a warning when the branch is confirmed missing — but does NOT throw', async () => {
    mocks.ensureBranchExists.mockResolvedValue({
      status: 'missing',
      reason: 'branch creation failed (403)',
    });
    const state = makeState({ branch: 'feature-x', defaultBranch: 'develop' });
    const mockRc = makeContext();

    // Best-effort is correct for the VM runtime specifically: bootstrap.go
    // clones baseBranch and `git checkout -b`s the target, so a missing ref
    // still yields a working workspace. This is the discriminating control for
    // the Instant path's fail-closed behaviour — if the fail-fast ever leaks
    // into the DO, this test goes red.
    await expect(ensureBranchExistsOnRemote(state, mockRc)).resolves.toBeUndefined();

    expect(mocks.log.warn).toHaveBeenCalledWith('task_runner_do.ensure_branch.missing', {
      taskId: 'task-test-001',
      branch: 'feature-x',
      defaultBranch: 'develop',
      reason: 'branch creation failed (403)',
    });
  });

  it('catches errors without throwing (best-effort)', async () => {
    mocks.ensureBranchExists.mockRejectedValue(new Error('Network timeout'));
    const state = makeState({ branch: 'feature-x' });
    const mockRc = makeContext();

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.log.warn).toHaveBeenCalledWith('task_runner_do.ensure_branch.error', {
      taskId: 'task-test-001',
      branch: 'feature-x',
      error: 'Network timeout',
    });
  });

  it('warns and skips on invalid repository string', async () => {
    const state = makeState({ branch: 'feature-x', repository: 'invalid-repo' });
    const mockRc = makeContext();

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'task_runner_do.ensure_branch.unknown',
      expect.objectContaining({
        reason: 'repository "invalid-repo" is not "owner/repo"',
      }),
    );
  });

  it('warns and skips on repository with empty owner', async () => {
    const state = makeState({ branch: 'feature-x', repository: '/repo' });
    const mockRc = makeContext();

    await ensureBranchExistsOnRemote(state, mockRc);

    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });
});
