import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  hibernateAgentSessionOnNode: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  sleepVmAgentContainer: vi.fn(),
  getRestorableSessionSnapshot: vi.fn(),
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
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: (...args: unknown[]) => mocks.drizzle(...args) }));
vi.mock('../../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: (...args: unknown[]) => mocks.hibernateAgentSessionOnNode(...args),
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));
vi.mock('../../../src/services/vm-agent-container', () => ({
  sleepVmAgentContainer: (...args: unknown[]) => mocks.sleepVmAgentContainer(...args),
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  getRestorableSessionSnapshot: (...args: unknown[]) => mocks.getRestorableSessionSnapshot(...args),
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
vi.mock('../../../src/services/project-data', () => ({
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  getSessionState: (...args: unknown[]) => mocks.getSessionState(...args),
  getAcpSession: (...args: unknown[]) => mocks.getAcpSession(...args),
  transitionAcpSession: (...args: unknown[]) => mocks.transitionAcpSession(...args),
}));

function buildDb(nodeRuntime = 'vm') {
  const selectRows = [
    [
      {
        id: 'workspace-1',
        userId: 'user-1',
        projectId: 'project-1',
        chatSessionId: 'chat-1',
        status: 'running',
        nodeId: 'node-1',
        nodeRuntime,
      },
    ],
    [{ id: 'agent-session-1', agentType: 'openai-codex' }],
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
    NODE_LIFECYCLE: {
      idFromName: vi.fn(() => 'node-do-id'),
      get: vi.fn(() => ({ scheduleWorkspaceDeletion: vi.fn(async () => undefined) })),
    },
  } as unknown as Env;
}

describe('sleepWorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue(buildDb());
    mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
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
  });

  it('preserves compute when the required final snapshot is degraded', async () => {
    mocks.getRestorableSessionSnapshot.mockResolvedValue(null);
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({
      status: 'degraded',
      degradation: 'entries-skipped',
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
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({
      status: 'available',
      degradation: 'none',
    });
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
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({
      status: 'available',
      degradation: 'none',
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
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({
      status: 'available',
      degradation: 'none',
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
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSessionSnapshotSleeping).toHaveBeenCalledTimes(1);
    expect(mocks.sleepSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
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
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({
      status: 'available',
      degradation: 'none',
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
    mocks.hibernateAgentSessionOnNode.mockResolvedValue({
      status: 'available',
      degradation: 'none',
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
