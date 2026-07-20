/**
 * Unit tests for the trigger task submission bridge.
 *
 * These test the submitTriggeredTask function's behavior when interacting
 * with the database, project data service, and TaskRunner DO.
 */
import { describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mock all external dependencies
// =============================================================================
vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: vi.fn().mockResolvedValue(undefined),
  ensureTaskRunnerStarted: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: vi.fn().mockResolvedValue('session-001'),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/agent-profiles', () => ({
  resolveAgentProfile: vi.fn().mockResolvedValue(null),
}));

const skillMocks = vi.hoisted(() => ({
  resolveSkillProfile: vi.fn(),
  parseSkillResourceRequirementsJson: vi.fn(),
}));

vi.mock('../../../src/services/skills', () => skillMocks);

vi.mock('../../../src/services/branch-name', () => ({
  generateBranchName: vi.fn().mockReturnValue('sam/daily-review-abc123'),
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: vi.fn().mockResolvedValue('Daily PR Review'),
  getTaskTitleConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: vi.fn().mockResolvedValue(undefined),
}));

const providerCredentialMocks = vi.hoisted(() => ({
  resolveCredentialSource: vi.fn(),
}));

vi.mock('../../../src/services/provider-credentials', () => providerCredentialMocks);

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `ULID${String(++ulidCounter).padStart(6, '0')}`,
}));

// Mock drizzle
const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockUpdateSetWhere = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
const mockSelectResult: any[] = [];

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockSelectResult.shift() || []),
        }),
      }),
    }),
    insert: () => ({
      values: mockInsertValues,
    }),
    update: () => ({
      set: () => ({
        where: mockUpdateSetWhere,
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => val),
  and: vi.fn((...args: unknown[]) => args),
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s }),
}));

import * as projectHelpers from '../../../src/routes/projects/_helpers';
import * as projectData from '../../../src/services/project-data';
import * as taskRunnerDo from '../../../src/services/task-runner-do';
import type { SubmitTriggeredTaskInput } from '../../../src/services/trigger-submit';

const defaultInput: SubmitTriggeredTaskInput = {
  triggerId: 'trigger-1',
  triggerExecutionId: 'exec-1',
  projectId: 'project-1',
  userId: 'user-1',
  renderedPrompt: 'Review all PRs from today',
  triggeredBy: 'cron',
  agentProfileId: null,
  taskMode: 'task',
  skillId: null,
  vmSizeOverride: null,
  triggerName: 'Daily Review',
};

function triggerProjectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    userId: 'user-1',
    name: 'Test Project',
    repository: 'user/repo',
    installationId: 'install-1',
    defaultBranch: 'main',
    defaultVmSize: null,
    defaultAgentType: null,
    defaultWorkspaceProfile: null,
    defaultProvider: null,
    defaultLocation: null,
    taskExecutionTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
    warmNodeTimeoutMs: null,
    ...overrides,
  };
}

function queueTriggerSubmitLookups(project = triggerProjectRow()) {
  mockSelectResult.push(
    [project],
    [{ githubId: '123', name: 'User', email: 'user@test.com' }] // user
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('submitTriggeredTask', () => {
  beforeEach(() => {
    ulidCounter = 0;
    vi.clearAllMocks();
    mockSelectResult.length = 0;
    providerCredentialMocks.resolveCredentialSource.mockResolvedValue({
      credentialSource: 'user',
      providerName: 'hetzner',
    });
    vi.mocked(taskRunnerDo.startTaskRunnerDO).mockResolvedValue(undefined);
    vi.mocked(taskRunnerDo.ensureTaskRunnerStarted).mockResolvedValue(false);
  });

  it('creates a task with trigger metadata fields', async () => {
    // Setup mock DB responses: project, user
    queueTriggerSubmitLookups();

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    const result = await submitTriggeredTask({} as any, defaultInput);

    expect(result.taskId).toBeDefined();
    expect(result.sessionId).toBe('session-001');
    expect(result.branchName).toBe('sam/daily-review-abc123');

    // Verify task was inserted with trigger metadata
    expect(mockInsertValues).toHaveBeenCalled();
    const insertCall = mockInsertValues.mock.calls[0]![0];
    expect(insertCall.triggeredBy).toBe('cron');
    expect(insertCall.triggerId).toBe('trigger-1');
    expect(insertCall.triggerExecutionId).toBe('exec-1');
    expect(insertCall.status).toBe('queued');
    expect(insertCall.credentialAttributionUserId).toBe('user-1');
    expect(insertCall.credentialAttributionSource).toBe('user');
  });

  it('pins project credential attribution for member A trigger even if another member edited it', async () => {
    providerCredentialMocks.resolveCredentialSource.mockResolvedValueOnce({
      credentialSource: 'project',
      providerName: 'hetzner',
    });
    queueTriggerSubmitLookups(triggerProjectRow({ userId: 'member-b' }));

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await submitTriggeredTask({} as any, {
      ...defaultInput,
      userId: 'member-a',
      projectId: 'project-1',
    });

    expect(providerCredentialMocks.resolveCredentialSource).toHaveBeenCalledWith(
      expect.anything(),
      'member-a',
      undefined,
      'project-1'
    );
    const insertCall = mockInsertValues.mock.calls[0]![0];
    expect(insertCall.credentialAttributionUserId).toBe('member-a');
    expect(insertCall.credentialAttributionProjectId).toBe('project-1');
    expect(insertCall.credentialAttributionSource).toBe('project');
    expect(taskRunnerDo.startTaskRunnerDO).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'member-a',
        credentialAttributionUserId: 'member-a',
        credentialAttributionProjectId: 'project-1',
        credentialAttributionSource: 'project',
        cloudProvider: 'hetzner',
      })
    );
  });

  it('treats a lost TaskRunner acknowledgement as success when DO state is durable', async () => {
    queueTriggerSubmitLookups();
    vi.mocked(taskRunnerDo.startTaskRunnerDO).mockRejectedValueOnce(
      new Error('TaskRunner response was lost')
    );
    vi.mocked(taskRunnerDo.ensureTaskRunnerStarted).mockResolvedValueOnce(true);

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    const result = await submitTriggeredTask({} as any, defaultInput);

    expect(result).toMatchObject({
      taskId: 'ULID000001',
      sessionId: 'session-001',
      branchName: 'sam/daily-review-abc123',
    });
    expect(taskRunnerDo.ensureTaskRunnerStarted).toHaveBeenCalledWith(
      expect.anything(),
      'ULID000001'
    );
    expect(mockUpdateSetWhere).not.toHaveBeenCalled();
    expect(projectData.stopSession).not.toHaveBeenCalled();
  });

  it('fails the task and session when TaskRunner has no durable state', async () => {
    queueTriggerSubmitLookups();
    vi.mocked(taskRunnerDo.startTaskRunnerDO).mockRejectedValueOnce(
      new Error('TaskRunner unavailable')
    );

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toThrow(
      'TaskRunner unavailable'
    );

    expect(taskRunnerDo.ensureTaskRunnerStarted).toHaveBeenCalledWith(
      expect.anything(),
      'ULID000001'
    );
    expect(mockUpdateSetWhere).toHaveBeenCalledOnce();
    expect(projectData.stopSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'session-001'
    );
  });

  it('keeps the task and session intact when TaskRunner confirmation is unavailable', async () => {
    queueTriggerSubmitLookups();
    vi.mocked(taskRunnerDo.startTaskRunnerDO).mockRejectedValueOnce(
      new Error('TaskRunner response was lost')
    );
    vi.mocked(taskRunnerDo.ensureTaskRunnerStarted).mockRejectedValueOnce(
      new Error('TaskRunner status unavailable')
    );

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toMatchObject({
      name: 'TriggerTaskSubmissionPendingError',
      submission: {
        taskId: 'ULID000001',
        sessionId: 'session-001',
        branchName: 'sam/daily-review-abc123',
      },
    });

    expect(mockUpdateSetWhere).not.toHaveBeenCalled();
    expect(projectData.stopSession).not.toHaveBeenCalled();
  });

  it('persists resolved skill metadata for trigger submissions', async () => {
    skillMocks.resolveSkillProfile.mockResolvedValueOnce({
      profileId: 'profile-1',
      profileName: 'Reviewer',
      skillId: 'skill-1',
      skillName: 'Triage',
      skillHint: 'triage',
      agentType: 'opencode',
      model: 'gpt-test',
      effort: 'auto',
      permissionMode: null,
      systemPromptAppend: 'Profile prompt\n\nSkill prompt',
      maxTurns: null,
      timeoutMinutes: null,
      vmSizeOverride: 'medium',
      provider: null,
      vmLocation: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      taskMode: 'task',
      resourceRequirementsJson: '{"cpu":4}',
      defaultProfileId: 'profile-1',
    });
    skillMocks.parseSkillResourceRequirementsJson.mockReturnValueOnce({ cpu: 4 });
    queueTriggerSubmitLookups();

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await submitTriggeredTask({} as any, { ...defaultInput, skillId: 'triage' });

    expect(skillMocks.resolveSkillProfile).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      null,
      'triage',
      'user-1',
      expect.anything()
    );
    const insertCall = mockInsertValues.mock.calls[0]![0];
    expect(insertCall.agentProfileHint).toBe('profile-1');
    expect(insertCall.skillId).toBe('skill-1');
    expect(insertCall.skillHint).toBe('triage');
    expect(insertCall.resourceRequirementsJson).toBe('{"cpu":4}');
  });

  it('throws when project is not found', async () => {
    mockSelectResult.push([]); // empty project result

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toThrow(
      'Project project-1 not found'
    );
  });

  it('throws when user has no cloud provider credentials', async () => {
    providerCredentialMocks.resolveCredentialSource.mockResolvedValueOnce(null);
    mockSelectResult.push([triggerProjectRow({ installationId: 'i1' })]);

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toThrow(
      'No cloud provider credentials available'
    );
  });

  it('blocks before provisioning when trigger submit GitHub owner access is revoked', async () => {
    queueTriggerSubmitLookups();
    vi.mocked(projectHelpers.requireRepositoryOwnerAccess).mockRejectedValueOnce(
      new Error('Repository access is no longer available')
    );

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toThrow(
      'Repository access is no longer available'
    );

    expect(projectHelpers.requireRepositoryOwnerAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'project-1', repository: 'user/repo' }),
      'user-1',
      'trigger-cron'
    );
    expect(taskRunnerDo.startTaskRunnerDO).not.toHaveBeenCalled();
  });
});
