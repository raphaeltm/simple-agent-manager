import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  claimSessionSnapshotRecoveryMock,
  databaseMock,
  dbMock,
  failSessionSnapshotRecoveryMock,
  selectQueue,
  startTaskRunnerDOMock,
  assertReplacementDeletionConfirmedMock,
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
    assertReplacementDeletionConfirmedMock: vi.fn(async () => undefined),
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
  sessionLifecycleError: (_env: unknown, error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: vi.fn(async () => false),
  startTaskRunnerDO: startTaskRunnerDOMock,
}));

vi.mock('../../../src/services/replacement-deletion-fence', () => ({
  assertReplacementDeletionConfirmed: assertReplacementDeletionConfirmedMock,
  WorkspaceDeletionUnconfirmedError: class WorkspaceDeletionUnconfirmedError extends Error {},
}));

vi.mock('../../../src/services/placement-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/placement-resolver')>();
  return {
    ...actual,
    resolveTaskStartPlacement: vi.fn((input) => ({
      entryPoint: input.entryPoint,
      taskId: input.taskId,
      projectId: input.projectId,
      userId: input.userId,
      provider: input.explicit.provider ?? 'hetzner',
      vmLocation: input.explicit.vmLocation ?? 'nbg1',
      vmSize: input.explicit.vmSize ?? 'small',
      vmSizeSource: 'workspace',
      workspaceProfile: input.explicit.workspaceProfile ?? 'lightweight',
      devcontainerConfigName: input.explicit.devcontainerConfigName ?? null,
      taskMode: input.explicit.taskMode ?? 'conversation',
      agentType: input.explicit.agentType ?? null,
      explicitVmLocation: true,
      resolvedReservation: { cpuMillis: 2_000, memoryMb: 4096, diskMb: 0 },
      credentialLookup: {
        userId: input.userId,
        projectId: null,
        provider: input.explicit.provider ?? 'hetzner',
      },
      inheritedCredentialAttribution: {
        userId: input.inheritedCredentialAttribution?.userId ?? input.userId,
        projectId: input.inheritedCredentialAttribution?.projectId ?? null,
        source: input.inheritedCredentialAttribution?.source ?? 'user',
      },
      runtime: {
        requestedRuntime: null,
        decision: null,
        executionRuntime: 'vm',
        isInstantRuntime: false,
        reason: 'vm-only',
      },
      capacityPoolSelection: null,
    })),
    resolveTaskStartPlacementCredentialAttributionFromPlacement: vi.fn(async (_db, placement) => ({
      placement,
      credential: {
        credentialSource: 'user',
        providerName: placement.provider ?? 'hetzner',
      },
      capacityPoolSelection: null,
      quotaCredentialSource: 'user',
      capacityPlacementSnapshot: null,
      effectiveProvider: placement.provider ?? 'hetzner',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      credentialAttribution: {
        userId: 'user-1',
        projectId: null,
        source: 'user',
      },
    })),
  };
});

import {
  ensureSessionRecovery,
  SESSION_RECOVERY_INITIAL_PROMPT,
} from '../../../src/services/session-recovery';

const emptyCapacityPlacement = {
  capacityPoolId: null,
  capacityPoolScope: null,
  capacityPoolRevision: null,
  capacitySourceId: null,
  capacityPoolCandidateId: null,
  placementCredentialSource: null,
  placementCredentialReference: null,
  placementCredentialVersion: null,
  capacityPoolProjectId: null,
  workloadRole: null,
  placementExplanationJson: null,
};

describe('ensureSessionRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    databaseMock.setBatchInsertChanges(1);
    claimSessionSnapshotRecoveryMock.mockResolvedValue({
      status: 'claimed',
      taskId: 'recovery-task-1',
    });
    assertReplacementDeletionConfirmedMock.mockResolvedValue(undefined);
  });

  it('fences an unconfirmed predecessor before claiming or creating recovery state', async () => {
    const { WorkspaceDeletionUnconfirmedError } =
      await import('../../../src/services/replacement-deletion-fence');
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
      },
      {
        id: 'workspace-sleeping',
        ...emptyCapacityPlacement,
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
        id: 'source-task-unconfirmed',
        recoverySourceTaskId: null,
        workspaceId: 'workspace-unconfirmed',
        title: 'Unsafe predecessor',
      }
    );
    assertReplacementDeletionConfirmedMock.mockRejectedValueOnce(
      new WorkspaceDeletionUnconfirmedError('workspace-unconfirmed')
    );

    await expect(
      ensureSessionRecovery(
        { DATABASE: databaseMock, BASE_DOMAIN: 'example.test' } as never,
        'project-1',
        'chat-1'
      )
    ).resolves.toEqual({ status: 'unavailable', reason: 'workspace_deletion_unconfirmed' });

    expect(assertReplacementDeletionConfirmedMock).toHaveBeenCalledWith(expect.anything(), {
      sourceTaskId: 'source-task-unconfirmed',
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(claimSessionSnapshotRecoveryMock).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(databaseMock.batch).not.toHaveBeenCalled();
    expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
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
        ...emptyCapacityPlacement,
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
    expect(assertReplacementDeletionConfirmedMock).toHaveBeenCalledWith(expect.anything(), {
      sourceTaskId: 'source-task-1',
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(databaseMock.batch).toHaveBeenCalledTimes(1);
    expect(startTaskRunnerDOMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: 'recovery-task-1',
        taskTitle: 'Original task title that must not become the fresh wake prompt',
        taskDescription: SESSION_RECOVERY_INITIAL_PROMPT,
        resumeSnapshotChatSessionId: 'chat-1',
        recoverySourceTaskId: null,
        retrySourceTaskId: 'source-task-1',
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
      { id: 'workspace-sleeping', ...emptyCapacityPlacement, userId: 'user-1' },
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

/**
 * Wake must resume the ORIGINAL run's canonical resource plan.
 *
 * Before this change `resolveRecoveryPlacement` did
 * `JSON.parse(sourceTask.resourceRequirementsJson)` into the `task` layer alone.
 * That dropped every inherited layer, ignored the persisted reservation, and
 * threw an unhandled SyntaxError on a malformed value — while the project and
 * agent-profile rows it read were TODAY's, so a default changed after the
 * session went to sleep silently re-sized the woken workspace.
 */
describe('session recovery consumes the canonical persisted resource plan', () => {
  // Sibling describe: the outer `beforeEach` does not run here, so the queue and
  // mocks must be primed explicitly or rows leak between cases.
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    databaseMock.setBatchInsertChanges(1);
    claimSessionSnapshotRecoveryMock.mockResolvedValue({
      status: 'claimed',
      taskId: 'recovery-task-1',
    });
    assertReplacementDeletionConfirmedMock.mockResolvedValue(undefined);
  });

  const SLEEPING_SNAPSHOT = {
    id: 'snapshot-1',
    projectId: 'project-1',
    workspaceId: 'workspace-sleeping',
    userId: 'user-1',
    runtime: 'vm',
    sleepingAt: '2026-08-15T13:11:53.580Z',
    manifestJson: JSON.stringify({ agentType: 'claude-code' }),
  };

  /** The project row as it looks NOW — deliberately different from the original run. */
  const PROJECT_WITH_CHANGED_DEFAULTS = {
    id: 'project-1',
    defaultLocation: 'nbg1',
    defaultBranch: 'main',
    repository: 'owner/repo',
    installationId: 'install-1',
    defaultVmSize: 'large',
    defaultAgentType: null,
    defaultProvider: null,
    // A project-layer requirement added AFTER the session went to sleep.
    resourceRequirementsJson: JSON.stringify({ minVcpu: 8, minMemoryGb: 16 }),
    taskExecutionTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
    warmNodeTimeoutMs: null,
  };

  const WORKSPACE = {
    id: 'workspace-sleeping',
    ...emptyCapacityPlacement,
    userId: 'user-1',
    vmSize: 'small',
    vmLocation: 'nbg1',
    branch: 'main',
    workspaceProfile: 'lightweight',
    devcontainerConfigName: null,
    agentProfileHint: null,
  };

  const USER = { id: 'user-1', name: 'Test User', email: 'test@example.com', githubId: 'gh-1' };

  function queueWake(sourceTask: Record<string, unknown>) {
    selectQueue.push(SLEEPING_SNAPSHOT, PROJECT_WITH_CHANGED_DEFAULTS, WORKSPACE, USER, {
      id: 'source-task-1',
      recoverySourceTaskId: null,
      workspaceId: 'workspace-sleeping',
      title: 'Original run',
      ...sourceTask,
    });
  }

  async function wake() {
    return ensureSessionRecovery(
      { DATABASE: databaseMock, BASE_DOMAIN: 'example.test' } as never,
      'project-1',
      'chat-1'
    );
  }

  async function placementInput() {
    const { resolveTaskStartPlacement } = await import('../../../src/services/placement-resolver');
    const mock = resolveTaskStartPlacement as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    return mock.mock.calls[0]?.[0] as {
      resourceRequirements: Record<string, unknown>;
      resolvedReservationOverride: unknown;
      explicit: { vmSize: string; vmSizeSource: string };
    };
  }

  it('replays every persisted layer at its original precedence, not just the task layer', async () => {
    queueWake({
      triggerId: 'trigger-1',
      skillId: 'skill-1',
      agentProfileHint: 'profile-1',
      resourceRequirementPlanJson: JSON.stringify({
        version: 1,
        intent: {
          task: { minVcpu: 2 },
          trigger: { minMemoryGb: 3 },
          skill: { minDiskGb: 20 },
          agentProfile: { maxCoTenants: 2 },
          project: { exclusiveNode: false },
          user: null,
        },
        resolvedReservation: {
          version: 1,
          cpuMillis: 1500,
          memoryMb: 3072,
          diskMb: 20480,
          maxCoTenants: 3,
          exclusiveNode: false,
          source: 'task',
          sourceId: 'source-task-1',
        },
      }),
      requestedVmSize: 'small',
      requestedVmSizeSource: 'task',
    });

    await wake();
    const input = await placementInput();

    // Every inherited layer survives the wake. The pre-fix reader produced
    // `{ task: <parsed> }` and nothing else.
    expect(input.resourceRequirements).toMatchObject({
      task: expect.objectContaining({ minVcpu: 2 }),
      trigger: expect.objectContaining({ minMemoryGb: 3 }),
      skill: expect.objectContaining({ minDiskGb: 20 }),
      agentProfile: expect.objectContaining({ maxCoTenants: 2 }),
      project: expect.objectContaining({ exclusiveNode: false }),
    });
  });

  it('reuses the persisted reservation instead of recomputing from current defaults', async () => {
    queueWake({
      resourceRequirementPlanJson: JSON.stringify({
        version: 1,
        intent: { task: { minVcpu: 2 } },
        resolvedReservation: {
          version: 1,
          cpuMillis: 1500,
          memoryMb: 3072,
          diskMb: 20480,
          maxCoTenants: 3,
          exclusiveNode: false,
          source: 'task',
          sourceId: 'source-task-1',
        },
      }),
      requestedVmSize: 'small',
      requestedVmSizeSource: 'task',
    });

    await wake();
    const input = await placementInput();

    // The project row above now carries minVcpu 8 / minMemoryGb 16 and a
    // 'large' default size. None of it may reach the woken run.
    expect(input.resolvedReservationOverride).toMatchObject({
      cpuMillis: 1500,
      memoryMb: 3072,
      diskMb: 20480,
    });
    expect(input.explicit.vmSize).toBe('small');
    expect(input.explicit.vmSizeSource).toBe('task');
  });

  it('preserves the original requested size when the project default changed after sleep', async () => {
    queueWake({
      resourceRequirementPlanJson: null,
      resourceRequirementsJson: null,
      resourceRequirementsSource: null,
      resolvedReservationJson: null,
      requestedVmSize: 'medium',
      requestedVmSizeSource: 'trigger',
    });

    await wake();
    const input = await placementInput();

    // Not 'large' (today's project default) and not 'small' (the workspace row).
    expect(input.explicit.vmSize).toBe('medium');
    expect(input.explicit.vmSizeSource).toBe('trigger');
  });

  it.each([
    { label: 'plan json', row: { resourceRequirementPlanJson: '{not json' } },
    {
      // The exact value the pre-fix `JSON.parse(sourceTask.resourceRequirementsJson)`
      // threw a raw SyntaxError on, straight out of ensureSessionRecovery.
      label: 'legacy requirements json',
      row: { resourceRequirementsJson: '{not json', resourceRequirementsSource: 'task' },
    },
    {
      label: 'unsupported plan version',
      row: {
        resourceRequirementPlanJson: JSON.stringify({ version: 99, intent: {} }),
      },
    },
  ])(
    'fails visibly on a malformed stored intent ($label) instead of waking onto current defaults',
    async ({ row }) => {
      queueWake({
        ...row,
        requestedVmSize: 'small',
        requestedVmSizeSource: 'task',
      });

      const result = await wake();

      // A named, surfaced refusal — not a raw SyntaxError escaping
      // ensureSessionRecovery, and not a silent wake onto current defaults.
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'session_recovery_placement_placement',
      });
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
      const { resolveTaskStartPlacement } =
        await import('../../../src/services/placement-resolver');
      expect(resolveTaskStartPlacement).not.toHaveBeenCalled();
    }
  );

  it('control: a well-formed plan still wakes normally', async () => {
    // Absence assertions above are also satisfied by wake being broken outright
    // (`.claude/rules/62`). This proves the happy path still reaches the runner.
    queueWake({
      resourceRequirementPlanJson: JSON.stringify({
        version: 1,
        intent: { task: { minVcpu: 2 } },
        resolvedReservation: {
          version: 1,
          cpuMillis: 1500,
          memoryMb: 3072,
          diskMb: 0,
          maxCoTenants: 3,
          exclusiveNode: false,
          source: 'task',
          sourceId: 'source-task-1',
        },
      }),
      requestedVmSize: 'small',
      requestedVmSizeSource: 'task',
      outputBranch: 'sam/original',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
    });
    // Rows the recovery-task creation batch reads back after the insert.
    selectQueue.push(
      null,
      {
        id: 'recovery-task-1',
        projectId: 'project-1',
        userId: 'user-1',
        chatSessionId: 'chat-1',
        recoverySourceTaskId: 'source-task-1',
        title: 'Original run',
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

    const result = await wake();

    expect(result).toEqual({ status: 'waking', taskId: 'recovery-task-1' });
    expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(1);
  });
});
