import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  claimSessionSnapshotRecoveryMock,
  dbMock,
  failSessionSnapshotRecoveryMock,
  insertedTasks,
  selectQueue,
  startTaskRunnerDOMock,
} = vi.hoisted(() => {
  const insertedTasks: Array<Record<string, unknown>> = [];
  const selectQueue: unknown[] = [];
  const nextSelectedRow = async () => {
    const next = selectQueue.shift();
    if (next === '__created_task__') return insertedTasks.at(-1) ?? null;
    return next ?? null;
  };

  const dbMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(nextSelectedRow),
          orderBy: vi.fn(() => ({
            get: vi.fn(nextSelectedRow),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ kind: 'update' })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if ('projectId' in row && 'chatSessionId' in row && 'triggeredBy' in row) {
          insertedTasks.push(row);
        }
        return { kind: 'insert', row };
      }),
    })),
    batch: vi.fn(async () => []),
  };

  return {
    claimSessionSnapshotRecoveryMock: vi.fn(),
    dbMock,
    failSessionSnapshotRecoveryMock: vi.fn(async () => undefined),
    insertedTasks,
    selectQueue,
    startTaskRunnerDOMock: vi.fn(async () => undefined),
  };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => dbMock,
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'recovery-task-1',
}));

vi.mock('../../../src/services/session-snapshots', () => ({
  claimSessionSnapshotRecovery: claimSessionSnapshotRecoveryMock,
  failSessionSnapshotRecovery: failSessionSnapshotRecoveryMock,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: vi.fn(async () => false),
  startTaskRunnerDO: startTaskRunnerDOMock,
}));

import {
  ensureSessionRecovery,
  SESSION_RECOVERY_INITIAL_PROMPT,
} from '../../../src/services/session-recovery';

describe('ensureSessionRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedTasks.length = 0;
    selectQueue.length = 0;
    claimSessionSnapshotRecoveryMock.mockResolvedValue({
      status: 'claimed',
      taskId: 'recovery-task-1',
    });
  });

  it('creates recovery tasks with a wake-specific prompt instead of rerunning the source task title', async () => {
    selectQueue.push(
      {
        id: 'snapshot-1',
        projectId: 'project-1',
        workspaceId: 'workspace-sleeping',
        userId: 'user-1',
        runtime: 'vm',
        sleepingAt: '2026-08-15T13:11:53.580Z',
        manifestJson: JSON.stringify({ agentType: 'claude-code' }),
      },
      {
        id: 'project-1',
        defaultLocation: 'nbg1',
        defaultBranch: 'main',
        repository: 'owner/repo',
        installationId: 'install-1',
        defaultVmSize: null,
        defaultAgentType: null,
        defaultProvider: null,
        taskExecutionTimeoutMs: null,
        maxWorkspacesPerNode: null,
        nodeCpuThresholdPercent: null,
        nodeMemoryThresholdPercent: null,
        warmNodeTimeoutMs: null,
      },
      {
        id: 'workspace-sleeping',
        userId: 'user-1',
        vmSize: 'small',
        vmLocation: 'nbg1',
        branch: 'main',
        workspaceProfile: 'lightweight',
        devcontainerConfigName: null,
        agentProfileHint: null,
      },
      {
        id: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        githubId: 'gh-1',
      },
      {
        id: 'source-task-1',
        title: 'Original task title that must not become the fresh wake prompt',
        priority: 0,
        agentProfileHint: null,
        skillId: null,
        skillHint: null,
        outputBranch: 'sam/original',
        requestedVmSizeSource: 'user',
        resourceRequirementsJson: null,
        resourceRequirementsSource: null,
        resolvedReservationJson: null,
        credentialAttributionUserId: 'user-1',
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
      },
      null,
      '__created_task__'
    );

    const result = await ensureSessionRecovery(
      { DATABASE: {}, BASE_DOMAIN: 'example.test' } as never,
      'project-1',
      'chat-1'
    );

    expect(result).toEqual({ status: 'waking', taskId: 'recovery-task-1' });
    expect(insertedTasks[0]).toMatchObject({
      id: 'recovery-task-1',
      description: SESSION_RECOVERY_INITIAL_PROMPT,
      taskMode: 'conversation',
      triggeredBy: 'session-recovery',
    });
    expect(startTaskRunnerDOMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: 'recovery-task-1',
        taskTitle: 'Original task title that must not become the fresh wake prompt',
        taskDescription: SESSION_RECOVERY_INITIAL_PROMPT,
        resumeSnapshotChatSessionId: 'chat-1',
      })
    );
  });
});
