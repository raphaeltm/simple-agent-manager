import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  claimSessionSnapshotRecoveryMock,
  databaseMock,
  dbMock,
  failSessionSnapshotRecoveryMock,
  selectQueue,
  startTaskRunnerDOMock,
} = vi.hoisted(() => {
  const selectQueue: unknown[] = [];
  let batchInsertChanges = 1;
  const nextSelectedRow = async () => {
    const next = selectQueue.shift();
    return next ?? null;
  };

  const databaseMock = {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({ kind: 'prepared' })) })),
    batch: vi.fn(async () => [
      { meta: { changes: batchInsertChanges } },
      { meta: { changes: batchInsertChanges } },
      { meta: { changes: batchInsertChanges } },
      { meta: { changes: batchInsertChanges } },
      { meta: { changes: batchInsertChanges } },
    ]),
    setBatchInsertChanges: (changes: number) => {
      batchInsertChanges = changes;
    },
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
    insert: vi.fn(() => ({ values: vi.fn((row: Record<string, unknown>) => ({ row })) })),
    batch: vi.fn(async () => []),
  };

  return {
    claimSessionSnapshotRecoveryMock: vi.fn(),
    databaseMock,
    dbMock,
    failSessionSnapshotRecoveryMock: vi.fn(async () => undefined),
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
    selectQueue.length = 0;
    databaseMock.setBatchInsertChanges(1);
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
      {
        id: 'recovery-task-1',
        projectId: 'project-1',
        userId: 'user-1',
        chatSessionId: 'chat-1',
        recoverySourceTaskId: 'source-task-1',
        title: 'Original task title that must not become the fresh wake prompt',
        description: SESSION_RECOVERY_INITIAL_PROMPT,
        status: 'queued',
        agentProfileHint: null,
        outputBranch: 'sam/original',
        credentialAttributionUserId: 'user-1',
        credentialAttributionProjectId: null,
        credentialAttributionSource: 'user',
        triggeredBy: 'session-recovery',
      },
      { id: 'source-task-1' }
    );

    const result = await ensureSessionRecovery(
      { DATABASE: databaseMock, BASE_DOMAIN: 'example.test' } as never,
      'project-1',
      'chat-1'
    );

    expect(result).toEqual({ status: 'waking', taskId: 'recovery-task-1' });
    expect(databaseMock.batch).toHaveBeenCalledTimes(1);
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

  it('abandons a claimed wake when the source parent terminalizes before task creation', async () => {
    databaseMock.setBatchInsertChanges(0);
    selectQueue.push(
      {
        id: 'snapshot-1',
        projectId: 'project-1',
        workspaceId: 'workspace-sleeping',
        userId: 'user-1',
        runtime: 'vm',
        sleepingAt: '2026-08-15T13:11:53.580Z',
        manifestJson: '{}',
      },
      { id: 'project-1' },
      { id: 'workspace-sleeping', userId: 'user-1' },
      { id: 'user-1' },
      { id: 'source-task-1', title: 'Parent', recoverySourceTaskId: null },
      null,
      null
    );
    const guard = {
      taskId: 'source-task-1',
      projectId: 'project-1',
      chatSessionId: 'chat-1',
    };

    await expect(
      ensureSessionRecovery(
        { DATABASE: databaseMock, BASE_DOMAIN: 'example.test' } as never,
        'project-1',
        'chat-1',
        guard
      )
    ).resolves.toEqual({ status: 'unavailable', reason: 'source_task_not_wakeable' });
    expect(claimSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      dbMock,
      expect.anything(),
      expect.objectContaining({ sourceTaskGuard: guard })
    );
    expect(failSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      dbMock,
      expect.anything(),
      'chat-1',
      'recovery-task-1',
      'source task is no longer wakeable'
    );
    expect(databaseMock.batch).toHaveBeenCalledTimes(1);
    expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
  });
});
