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
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: vi.fn().mockResolvedValue('session-001'),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/agent-profiles', () => ({
  resolveAgentProfile: vi.fn().mockResolvedValue(null),
}));

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

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `ULID${String(++ulidCounter).padStart(6, '0')}`,
}));

// Mock drizzle
const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
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
  vmSizeOverride: null,
  triggerName: 'Daily Review',
};

// =============================================================================
// Tests
// =============================================================================

describe('submitTriggeredTask', () => {
  beforeEach(() => {
    ulidCounter = 0;
    vi.clearAllMocks();
    mockSelectResult.length = 0;
  });

  it('creates a task with trigger metadata fields', async () => {
    // Setup mock DB responses: project, credential, user
    mockSelectResult.push(
      [{ // project
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
      }],
      [{ id: 'cred-1' }], // credential
      [{ githubId: '123', name: 'User', email: 'user@test.com' }], // user
    );

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
  });

  it('throws when project is not found', async () => {
    mockSelectResult.push([]); // empty project result

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toThrow(
      'Project project-1 not found'
    );
  });

  it('throws when user has no cloud provider credentials', async () => {
    mockSelectResult.push(
      [{ id: 'project-1', repository: 'user/repo', installationId: 'i1', defaultBranch: 'main' }],
      [], // no credentials
    );

    const { submitTriggeredTask } = await import('../../../src/services/trigger-submit');
    await expect(submitTriggeredTask({} as any, defaultInput)).rejects.toThrow(
      'no cloud provider credentials'
    );
  });
});
