import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  ensureSessionSnapshotForSleep: vi.fn(),
  scheduleSessionSnapshotSleep: vi.fn(),
  deferSessionSnapshotSleepBeforeClaim: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  sleepVmAgentContainer: vi.fn(),
  markVmAgentContainerActiveWorkStarted: vi.fn(),
  getRestorableSessionSnapshot: vi.fn(),
  getSessionSnapshotCaptureState: vi.fn(),
  claimSessionSnapshotSleep: vi.fn(),
  beginSessionSnapshotStopping: vi.fn(),
  finalizeSessionSnapshotSleeping: vi.fn(),
  failSessionSnapshotSleepBeforeTeardown: vi.fn(),
  deferSessionSnapshotStopping: vi.fn(),
  verifyRestorableSessionSnapshotArtifacts: vi.fn(),
  sleepSession: vi.fn(),
  getSession: vi.fn(),
  getSessionState: vi.fn(),
  getAcpSession: vi.fn(),
  transitionAcpSession: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  markIdle: vi.fn(),
  stopComputeTracking: vi.fn(),
  cleanupTaskRun: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: (...args: unknown[]) => mocks.drizzle(...args) }));
vi.mock('../../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: (...args: unknown[]) => mocks.hibernateAgentSessionOnNode(...args),
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));
vi.mock('../../../src/services/vm-agent-container', () => ({
  sleepVmAgentContainer: (...args: unknown[]) => mocks.sleepVmAgentContainer(...args),
  markVmAgentContainerActiveWorkStarted: (...args: unknown[]) =>
    mocks.markVmAgentContainerActiveWorkStarted(...args),
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  ensureSessionSnapshotForSleep: (...args: unknown[]) =>
    mocks.ensureSessionSnapshotForSleep(...args),
  scheduleSessionSnapshotSleep: (...args: unknown[]) => mocks.scheduleSessionSnapshotSleep(...args),
  deferSessionSnapshotSleepBeforeClaim: (...args: unknown[]) =>
    mocks.deferSessionSnapshotSleepBeforeClaim(...args),
  DEFAULT_SESSION_SLEEP_AFTER_MS: 15 * 60 * 1000,
  getRestorableSessionSnapshot: (...args: unknown[]) => mocks.getRestorableSessionSnapshot(...args),
  getSessionSnapshotCaptureState: (...args: unknown[]) =>
    mocks.getSessionSnapshotCaptureState(...args),
  claimSessionSnapshotSleep: (...args: unknown[]) => mocks.claimSessionSnapshotSleep(...args),
  beginSessionSnapshotStopping: (...args: unknown[]) => mocks.beginSessionSnapshotStopping(...args),
  finalizeSessionSnapshotSleeping: (...args: unknown[]) =>
    mocks.finalizeSessionSnapshotSleeping(...args),
  failSessionSnapshotSleepBeforeTeardown: (...args: unknown[]) =>
    mocks.failSessionSnapshotSleepBeforeTeardown(...args),
  deferSessionSnapshotStopping: (...args: unknown[]) => mocks.deferSessionSnapshotStopping(...args),
  verifyRestorableSessionSnapshotArtifacts: (...args: unknown[]) =>
    mocks.verifyRestorableSessionSnapshotArtifacts(...args),
}));
vi.mock('../../../src/services/compute-usage', () => ({
  stopComputeTracking: (...args: unknown[]) => mocks.stopComputeTracking(...args),
}));
vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));
vi.mock('../../../src/services/project-data', () => ({
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  getSessionState: (...args: unknown[]) => mocks.getSessionState(...args),
  getAcpSession: (...args: unknown[]) => mocks.getAcpSession(...args),
  transitionAcpSession: (...args: unknown[]) => mocks.transitionAcpSession(...args),
}));

function buildDb(
  nodeRuntime = 'vm',
  workspaceStatus = 'running',
  taskStatus = 'in_progress',
  activeNodeWorkspaces: Array<{ id: string }> = [],
  nodeWarmSince: string | null = null,
  includeAgentQuery = true
) {
  const selectRows = [
    [
      {
        id: 'workspace-1',
        userId: 'user-1',
        projectId: 'project-1',
        chatSessionId: 'chat-1',
        status: workspaceStatus,
        nodeId: 'node-1',
        nodeRuntime,
        nodeRole: 'workspace',
        taskId: 'task-1',
        taskStatus,
      },
    ],
    ...(includeAgentQuery ? [[{ id: 'agent-session-1', agentType: 'openai-codex' }]] : []),
    [{ warmSince: nodeWarmSince }],
    activeNodeWorkspaces,
  ];
  const select = vi.fn(() => {
    const rows = selectRows.shift() ?? [];
    const chain = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async () => rows),
    };
    return chain;
  });
  const update = vi.fn(() => {
    const chain = {
      set: vi.fn(() => chain),
      where: vi.fn(async () => ({ meta: { changes: 1 } })),
    };
    return chain;
  });
  return { select, update, batch: vi.fn(async () => undefined) };
}

function buildEnv(): Env {
  return {
    DATABASE: {},
    SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '200',
    SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
    NODE_LIFECYCLE: {
      idFromName: vi.fn(() => 'node-do-id'),
      get: vi.fn(() => ({
        scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
        markIdle: mocks.markIdle,
      })),
    },
  } as unknown as Env;
}

describe('sleepWorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue(buildDb());
    mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
    mocks.ensureSessionSnapshotForSleep.mockResolvedValue(undefined);
    mocks.scheduleSessionSnapshotSleep.mockResolvedValue(undefined);
    mocks.deferSessionSnapshotSleepBeforeClaim.mockResolvedValue(true);
    mocks.markVmAgentContainerActiveWorkStarted.mockResolvedValue(undefined);
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({ status: 'pending', accepted: true });
    mocks.getSessionSnapshotCaptureState
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: null,
      })
      .mockResolvedValue({
        status: 'available',
        degradation: 'none',
        snapshotGeneration: 'generation-final',
        captureGeneration: null,
      });
    mocks.claimSessionSnapshotSleep.mockResolvedValue({
      status: 'claimed',
      claimId: 'claim-1',
      phase: 'preparing',
    });
    mocks.beginSessionSnapshotStopping.mockResolvedValue(true);
    mocks.finalizeSessionSnapshotSleeping.mockResolvedValue(true);
    mocks.failSessionSnapshotSleepBeforeTeardown.mockResolvedValue(true);
    mocks.deferSessionSnapshotStopping.mockResolvedValue(true);
    mocks.verifyRestorableSessionSnapshotArtifacts.mockResolvedValue(true);
    mocks.sleepSession.mockResolvedValue(true);
    mocks.getSession.mockResolvedValue({ status: 'active' });
    mocks.getSessionState.mockResolvedValue({ activity: 'idle', activityAt: 100 });
    mocks.getAcpSession.mockResolvedValue(null);
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.markIdle.mockResolvedValue(undefined);
    mocks.stopComputeTracking.mockResolvedValue(0);
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
  });

  it('queues an immediate terminal sleep intent without snapshotting or stopping compute', async () => {
    const env = buildEnv();
    const { queueWorkspaceSessionSleep } = await import('../../../src/services/session-sleep');

    await queueWorkspaceSessionSleep(env, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'Task completed',
      sleepAfterMs: 0,
    });

    expect(mocks.ensureSessionSnapshotForSleep).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSessionSnapshotSleep).toHaveBeenCalledWith(
      expect.anything(),
      env,
      'chat-1',
      expect.any(Date),
      { sleepAfterMs: 0, allowIncomplete: true, resetAttempts: false }
    );
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
  });

  it('defers heartbeat-live prompting activity without consuming a sleep claim', async () => {
    mocks.getSessionState.mockResolvedValue({ activity: 'prompting', activityAt: Date.now() });
    const env = buildEnv();
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        env,
        { workspaceId: 'workspace-1', userId: 'user-1' },
        new Date('2026-08-14T05:00:00.000Z')
      )
    ).resolves.toMatchObject({
      eligible: false,
      reason: 'Workspace agent is not idle (prompting)',
    });

    expect(mocks.deferSessionSnapshotSleepBeforeClaim).toHaveBeenCalledTimes(1);
    expect(mocks.claimSessionSnapshotSleep).not.toHaveBeenCalled();
  });

  it('uses genuine idle activity instead of the running session heartbeat state', async () => {
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: now.getTime() - 16 * 60 * 1000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv(),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toEqual({ eligible: true });

    expect(mocks.deferSessionSnapshotSleepBeforeClaim).not.toHaveBeenCalled();
  });

  it('lets a completed task sleep on its first idle observation', async () => {
    mocks.drizzle.mockReturnValue(buildDb('vm', 'running', 'completed'));
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({ activity: 'idle', activityAt: now.getTime() - 1 });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv(),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toEqual({ eligible: true });
  });

  it('preserves compute when the required final snapshot is degraded', async () => {
    mocks.getRestorableSessionSnapshot.mockResolvedValue(null);
    mocks.getSessionSnapshotCaptureState.mockReset();
    mocks.getSessionSnapshotCaptureState
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: null,
      })
      .mockResolvedValue({
        status: 'degraded',
        degradation: 'entries-skipped',
        snapshotGeneration: 'generation-degraded',
        captureGeneration: null,
      });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(buildEnv(), {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      })
    ).rejects.toThrow('Workspace snapshot is not complete');

    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.sleepVmAgentContainer).not.toHaveBeenCalled();
    expect(mocks.finalizeSessionSnapshotSleeping).not.toHaveBeenCalled();
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).toHaveBeenCalledTimes(1);
  });

  it('preserves compute when snapshot completion cannot be re-read durably', async () => {
    mocks.getRestorableSessionSnapshot.mockResolvedValue(null);
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(buildEnv(), {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      })
    ).rejects.toThrow('snapshot completion was not durably verified');

    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.sleepVmAgentContainer).not.toHaveBeenCalled();
  });

  it('preserves compute when the immutable R2 generation cannot be verified', async () => {
    mocks.getRestorableSessionSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce({
      status: 'available',
      degradation: 'none',
      expiresAt: '2026-08-19T00:00:00.000Z',
    });
    mocks.verifyRestorableSessionSnapshotArtifacts.mockResolvedValue(false);
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(buildEnv(), {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      })
    ).rejects.toThrow('snapshot artifacts failed durable R2 verification');

    expect(mocks.beginSessionSnapshotStopping).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).toHaveBeenCalledTimes(1);
  });

  it('stops a VM only after a verified complete snapshot', async () => {
    mocks.getSessionSnapshotCaptureState.mockReset();
    mocks.getSessionSnapshotCaptureState
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: 'idle-checkpoint-in-progress',
      })
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: 'idle-checkpoint-in-progress',
      })
      .mockResolvedValue({
        status: 'available',
        degradation: 'none',
        snapshotGeneration: 'generation-final',
        captureGeneration: null,
      });
    mocks.hibernateAgentSessionOnNode
      .mockResolvedValueOnce({ status: 'pending', accepted: false })
      .mockResolvedValue({ status: 'pending', accepted: true });
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        expiresAt: '2026-08-19T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    const env = buildEnv();
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      })
    ).resolves.toMatchObject({ status: 'sleeping', chatSessionId: 'chat-1' });

    expect(mocks.hibernateAgentSessionOnNode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopWorkspaceOnNode.mock.invocationCallOrder[0]
    );
    expect(mocks.hibernateAgentSessionOnNode).toHaveBeenCalledTimes(2);
    expect(mocks.ensureSessionSnapshotForSleep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        workspaceId: 'workspace-1',
        nodeId: 'node-1',
        projectId: 'project-1',
        userId: 'user-1',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-session-1',
        runtime: 'vm',
      }
    );
    expect(mocks.ensureSessionSnapshotForSleep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimSessionSnapshotSleep.mock.invocationCallOrder[0]
    );
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSessionSnapshotSleeping).toHaveBeenCalledTimes(1);
    expect(mocks.sleepSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith('node-1', 'workspace-1', 'user-1');
    expect(mocks.markIdle).toHaveBeenCalledWith('node-1', 'user-1', null);
    expect(mocks.stopComputeTracking).toHaveBeenCalledWith(expect.anything(), 'workspace-1');
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env, null);
  });

  it('keeps a shared VM node active while another workspace still runs on it', async () => {
    mocks.drizzle.mockReturnValue(buildDb('vm', 'running', 'in_progress', [{ id: 'workspace-2' }]));
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        expiresAt: '2026-08-19T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await sleepWorkspaceSession(buildEnv(), {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'test',
    });

    expect(mocks.markIdle).not.toHaveBeenCalled();
  });

  it('does not reset an existing warm-node retention timer after sleep', async () => {
    mocks.drizzle.mockReturnValue(
      buildDb('vm', 'running', 'in_progress', [], '2026-08-14T04:00:00.000Z')
    );
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        expiresAt: '2026-08-19T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await sleepWorkspaceSession(buildEnv(), {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'test',
    });

    expect(mocks.markIdle).not.toHaveBeenCalled();
  });

  it('re-arms deletion when an already sleeping VM is slept idempotently', async () => {
    mocks.drizzle.mockReturnValue(buildDb('vm', 'sleeping', 'in_progress', [], null, false));
    mocks.getRestorableSessionSnapshot.mockResolvedValue({
      status: 'available',
      degradation: 'none',
      sleepingAt: '2026-08-12T00:00:00.000Z',
      sleepStatus: 'sleeping',
      expiresAt: '2026-08-19T00:00:00.000Z',
    });
    const env = buildEnv();
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'retry',
      })
    ).resolves.toMatchObject({ status: 'sleeping', workspaceId: 'workspace-1' });

    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith('node-1', 'workspace-1', 'user-1');
    expect(mocks.markIdle).toHaveBeenCalledWith('node-1', 'user-1', null);
  });

  it('acknowledges a Cloudflare Container stop and commits node sleep in the same D1 batch', async () => {
    const db = buildDb('cf-container');
    mocks.drizzle.mockReturnValue(db);
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        expiresAt: '2026-08-19T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    mocks.sleepVmAgentContainer.mockResolvedValue(undefined);
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await sleepWorkspaceSession(buildEnv(), {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'test',
    });

    expect(mocks.sleepVmAgentContainer).toHaveBeenCalledWith(expect.anything(), 'node-1');
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([expect.anything()]));
    expect(db.batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(mocks.markIdle).not.toHaveBeenCalled();
  });

  it('aborts before teardown when ProjectData activity changes during capture', async () => {
    mocks.getSessionState
      .mockResolvedValueOnce({ activity: 'idle', activityAt: 100 })
      .mockResolvedValueOnce({ activity: 'prompting', activityAt: 101 });
    mocks.getRestorableSessionSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce({
      status: 'available',
      degradation: 'none',
      expiresAt: '2026-08-19T00:00:00.000Z',
    });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(buildEnv(), {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      })
    ).rejects.toThrow('Workspace activity changed');

    expect(mocks.beginSessionSnapshotStopping).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).toHaveBeenCalledTimes(1);
  });

  it('rolls a reclaimed stopping claim forward without recapturing', async () => {
    mocks.claimSessionSnapshotSleep.mockResolvedValueOnce({
      status: 'claimed',
      claimId: 'claim-repair',
      phase: 'stopping',
    });
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce({ status: 'available', degradation: 'none' })
      .mockResolvedValueOnce({
        status: 'available',
        degradation: 'none',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await sleepWorkspaceSession(buildEnv(), {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'repair',
      sleepClaimId: 'claim-repair',
    });

    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSessionSnapshotSleeping).toHaveBeenCalledTimes(1);
  });
});
