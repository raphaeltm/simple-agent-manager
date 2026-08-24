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
  isSessionSnapshotSleepReleasable: vi.fn(),
  completeActiveSessionSnapshotAsDegraded: vi.fn(),
  claimSessionSnapshotSleep: vi.fn(),
  beginSessionSnapshotStopping: vi.fn(),
  finalizeSessionSnapshotSleeping: vi.fn(),
  failSessionSnapshotSleepBeforeTeardown: vi.fn(),
  deferSessionSnapshotStopping: vi.fn(),
  verifyRestorableSessionSnapshotArtifacts: vi.fn(),
  verifySessionSnapshotArtifactsForSleep: vi.fn(),
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
  isSessionSnapshotSleepReleasable: (...args: unknown[]) =>
    mocks.isSessionSnapshotSleepReleasable(...args),
  completeActiveSessionSnapshotAsDegraded: (...args: unknown[]) =>
    mocks.completeActiveSessionSnapshotAsDegraded(...args),
  claimSessionSnapshotSleep: (...args: unknown[]) => mocks.claimSessionSnapshotSleep(...args),
  beginSessionSnapshotStopping: (...args: unknown[]) => mocks.beginSessionSnapshotStopping(...args),
  finalizeSessionSnapshotSleeping: (...args: unknown[]) =>
    mocks.finalizeSessionSnapshotSleeping(...args),
  failSessionSnapshotSleepBeforeTeardown: (...args: unknown[]) =>
    mocks.failSessionSnapshotSleepBeforeTeardown(...args),
  deferSessionSnapshotStopping: (...args: unknown[]) => mocks.deferSessionSnapshotStopping(...args),
  verifyRestorableSessionSnapshotArtifacts: (...args: unknown[]) =>
    mocks.verifyRestorableSessionSnapshotArtifacts(...args),
  verifySessionSnapshotArtifactsForSleep: (...args: unknown[]) =>
    mocks.verifySessionSnapshotArtifactsForSleep(...args),
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

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: {},
    SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '200',
    SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS: '200',
    SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
    NODE_LIFECYCLE: {
      idFromName: vi.fn(() => 'node-do-id'),
      get: vi.fn(() => ({
        scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
        markIdle: mocks.markIdle,
      })),
    },
    ...overrides,
  } as unknown as Env;
}

describe('parseHarnessWorkConfig', () => {
  it('uses defaults when env vars are unset', async () => {
    const { parseHarnessWorkConfig, DEFAULT_HARNESS_BACKGROUND_WORK_LEASE_MS, DEFAULT_HARNESS_BACKGROUND_WORK_MAX_DURATION_MS } =
      await import('../../../src/services/session-sleep');

    const config = parseHarnessWorkConfig({});
    expect(config.leaseMs).toBe(DEFAULT_HARNESS_BACKGROUND_WORK_LEASE_MS);
    expect(config.maxDurationMs).toBe(DEFAULT_HARNESS_BACKGROUND_WORK_MAX_DURATION_MS);
  });

  it('reads configured env var values', async () => {
    const { parseHarnessWorkConfig } = await import('../../../src/services/session-sleep');

    const config = parseHarnessWorkConfig({
      HARNESS_BACKGROUND_WORK_LEASE_MS: '120000',
      HARNESS_BACKGROUND_WORK_MAX_DURATION_MS: '600000',
    });
    expect(config.leaseMs).toBe(120000);
    expect(config.maxDurationMs).toBe(600000);
  });
});

describe('isHarnessWorkLeaseActive', () => {
  it('returns false for null state', async () => {
    const { isHarnessWorkLeaseActive } = await import('../../../src/services/session-sleep');
    expect(isHarnessWorkLeaseActive(null, new Date(), { leaseMs: 300000, maxDurationMs: 1800000 })).toBe(false);
  });

  it('returns true for active work within lease', async () => {
    const { isHarnessWorkLeaseActive } = await import('../../../src/services/session-sleep');
    const now = new Date();
    expect(isHarnessWorkLeaseActive(
      { runtimeWorkState: 'active', runtimeWorkUpdatedAt: now.getTime() - 10_000, runtimeWorkProgressAt: now.getTime() - 10_000 },
      now,
      { leaseMs: 300000, maxDurationMs: 1800000 }
    )).toBe(true);
  });

  it('returns false for expired lease', async () => {
    const { isHarnessWorkLeaseActive } = await import('../../../src/services/session-sleep');
    const now = new Date();
    expect(isHarnessWorkLeaseActive(
      { runtimeWorkState: 'active', runtimeWorkUpdatedAt: now.getTime() - 400_000, runtimeWorkProgressAt: now.getTime() - 400_000 },
      now,
      { leaseMs: 300000, maxDurationMs: 1800000 }
    )).toBe(false);
  });

  it('returns false for inactive work state', async () => {
    const { isHarnessWorkLeaseActive } = await import('../../../src/services/session-sleep');
    const now = new Date();
    expect(isHarnessWorkLeaseActive(
      { runtimeWorkState: 'inactive', runtimeWorkUpdatedAt: now.getTime() - 10_000, runtimeWorkProgressAt: now.getTime() - 10_000 },
      now,
      { leaseMs: 300000, maxDurationMs: 1800000 }
    )).toBe(false);
  });
});

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
    mocks.isSessionSnapshotSleepReleasable.mockImplementation(
      (snapshot: { status?: string; degradation?: string } | null | undefined) =>
        Boolean(
          snapshot &&
          ((snapshot.status === 'available' && snapshot.degradation === 'none') ||
            (snapshot.status === 'degraded' && snapshot.degradation !== 'none'))
        )
    );
    mocks.completeActiveSessionSnapshotAsDegraded.mockResolvedValue(false);
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
    mocks.verifySessionSnapshotArtifactsForSleep.mockResolvedValue(true);
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

  it('defers an idle session while a fresh harness-work lease is active', async () => {
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: now.getTime() - 16 * 60 * 1000,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkUpdatedAt: now.getTime() - 30_000,
      runtimeWorkProgressAt: now.getTime() - 60_000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv({ HARNESS_BACKGROUND_WORK_LEASE_MS: '120000' }),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toEqual({
      eligible: false,
      reason: 'Harness-owned background work is active',
      retryAt: '2026-08-14T05:01:30.000Z',
    });

    expect(mocks.deferSessionSnapshotSleepBeforeClaim).toHaveBeenCalledTimes(1);
  });

  // Regression: the sliding lease is refreshed by the VM agent's periodic
  // re-report, so it alone can be renewed forever. An adapter faithfully
  // re-reporting a STALE task set — the canonical case being an abandoned
  // `run_in_background` dev server still listed in Claude's
  // `background_tasks_changed` — would otherwise pin compute awake
  // indefinitely, contradicting the canonical definition of idleness.
  //
  // DISCRIMINATING: this test fails without the progress-anchored absolute
  // ceiling, because `runtimeWorkUpdatedAt` is deliberately kept fresh here.
  it('allows sleep once the absolute ceiling elapses even while heartbeats stay fresh', async () => {
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: now.getTime() - 16 * 60 * 1000,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      // Heartbeat is 5s old — the sliding lease is WIDE open.
      runtimeWorkUpdatedAt: now.getTime() - 5_000,
      // But no real lifecycle progress for 31 minutes: the work is abandoned.
      runtimeWorkProgressAt: now.getTime() - 31 * 60 * 1000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv({
          HARNESS_BACKGROUND_WORK_LEASE_MS: '120000',
          HARNESS_BACKGROUND_WORK_MAX_DURATION_MS: '1800000',
        }),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toEqual({ eligible: true });
  });

  // Control: work that is genuinely still progressing must NOT be reaped by the
  // ceiling. Without this, an over-eager ceiling would silently kill live work.
  it('keeps deferring while lifecycle progress is still advancing', async () => {
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: now.getTime() - 16 * 60 * 1000,
      runtimeWorkState: 'active',
      runtimeWorkCount: 2,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkUpdatedAt: now.getTime() - 5_000,
      // Real progress 1 minute ago — well inside the 30-minute ceiling.
      runtimeWorkProgressAt: now.getTime() - 60_000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    const result = await checkAutomaticSessionSleepEligibility(
      buildEnv({
        HARNESS_BACKGROUND_WORK_LEASE_MS: '120000',
        HARNESS_BACKGROUND_WORK_MAX_DURATION_MS: '1800000',
      }),
      { workspaceId: 'workspace-1', userId: 'user-1' },
      now
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('Harness-owned background work is active');
  });

  // The ceiling must never EXTEND the sliding lease — it can only shorten it.
  it('never extends the sliding lease past its own expiry', async () => {
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: now.getTime() - 16 * 60 * 1000,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      // Heartbeat is stale (lease expired) even though progress is recent.
      runtimeWorkUpdatedAt: now.getTime() - 121_000,
      runtimeWorkProgressAt: now.getTime() - 1_000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv({
          HARNESS_BACKGROUND_WORK_LEASE_MS: '120000',
          HARNESS_BACKGROUND_WORK_MAX_DURATION_MS: '1800000',
        }),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toEqual({ eligible: true });
  });

  it('allows sleep after a stale harness-work lease expires', async () => {
    const now = new Date('2026-08-14T05:00:00.000Z');
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: now.getTime() - 16 * 60 * 1000,
      runtimeWorkState: 'settling',
      runtimeWorkCount: 0,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkUpdatedAt: now.getTime() - 121_000,
      runtimeWorkProgressAt: now.getTime() - 121_000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv({ HARNESS_BACKGROUND_WORK_LEASE_MS: '120000' }),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toEqual({ eligible: true });
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

  it('lets a completed task sleep when its final activity is still marked prompting', async () => {
    mocks.drizzle.mockReturnValue(buildDb('vm', 'running', 'completed'));
    mocks.getSessionState.mockResolvedValue({
      activity: 'prompting',
      activityAt: new Date('2026-08-13T20:15:19.488Z').getTime(),
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv(),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        new Date('2026-08-14T09:00:00.000Z')
      )
    ).resolves.toEqual({ eligible: true });

    expect(mocks.deferSessionSnapshotSleepBeforeClaim).not.toHaveBeenCalled();
  });

  it('preserves a completed task while its final prompt is still recent', async () => {
    const now = new Date('2026-08-14T09:00:00.000Z');
    mocks.drizzle.mockReturnValue(buildDb('vm', 'running', 'completed'));
    mocks.getSessionState.mockResolvedValue({
      activity: 'prompting',
      activityAt: now.getTime() - 30_000,
    });
    const { checkAutomaticSessionSleepEligibility } =
      await import('../../../src/services/session-sleep');

    await expect(
      checkAutomaticSessionSleepEligibility(
        buildEnv(),
        { workspaceId: 'workspace-1', userId: 'user-1' },
        now
      )
    ).resolves.toMatchObject({
      eligible: false,
      reason: 'Workspace agent is not idle (prompting)',
      retryAt: '2026-08-14T09:14:30.000Z',
    });

    expect(mocks.deferSessionSnapshotSleepBeforeClaim).toHaveBeenCalledTimes(1);
  });

  it('sleeps compute when the final snapshot is durably degraded and verified', async () => {
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'degraded',
        degradation: 'entries-skipped',
        expiresAt: '2026-08-19T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'degraded',
        degradation: 'entries-skipped',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
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
    ).resolves.toMatchObject({ status: 'sleeping', chatSessionId: 'chat-1' });

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
    expect(mocks.sleepVmAgentContainer).not.toHaveBeenCalled();
    expect(mocks.verifySessionSnapshotArtifactsForSleep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'degraded', degradation: 'entries-skipped' })
    );
    expect(mocks.finalizeSessionSnapshotSleeping).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'chat-1',
      expect.any(String),
      expect.any(Date),
      { sleepWarning: 'Workspace slept with degraded snapshot (entries-skipped)' }
    );
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).not.toHaveBeenCalled();
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
    mocks.verifySessionSnapshotArtifactsForSleep.mockResolvedValue(false);
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

  it('aborts when harness work begins across the artifact-verification barrier', async () => {
    let harnessActive = false;
    mocks.getSessionState.mockImplementation(async () => ({
      activity: 'idle',
      activityAt: 100,
      runtimeWorkState: harnessActive ? 'active' : 'inactive',
      runtimeWorkCount: harnessActive ? 1 : 0,
      runtimeWorkUpdatedAt: harnessActive ? Date.now() : 90,
      runtimeWorkProgressAt: harnessActive ? Date.now() : 90,
    }));
    mocks.getRestorableSessionSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce({
      status: 'available',
      degradation: 'none',
      expiresAt: '2026-08-19T00:00:00.000Z',
    });
    mocks.verifySessionSnapshotArtifactsForSleep.mockImplementation(async () => {
      harnessActive = true;
      return true;
    });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(buildEnv(), {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      })
    ).rejects.toThrow('activity changed during snapshot artifact verification');

    expect(mocks.beginSessionSnapshotStopping).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).toHaveBeenCalledTimes(1);
  });

  it('allows a slow but progressing final snapshot to exceed the request timeout budget', async () => {
    const env = {
      ...buildEnv(),
      SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '5',
      SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS: '200',
      SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
    } as Env;
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
    mocks.getSessionSnapshotCaptureState.mockReset();
    mocks.getSessionSnapshotCaptureState
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: null,
        updatedAt: '2026-08-15T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: 'generation-final',
        updatedAt: '2026-08-15T00:00:00.010Z',
      })
      .mockResolvedValueOnce({
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: 'generation-final',
        updatedAt: '2026-08-15T00:00:00.020Z',
      })
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          status: 'available',
          degradation: 'none',
          snapshotGeneration: 'generation-final',
          captureGeneration: null,
          updatedAt: '2026-08-15T00:00:00.030Z',
        };
      });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'slow-progress',
      })
    ).resolves.toMatchObject({ status: 'sleeping' });

    expect(mocks.completeActiveSessionSnapshotAsDegraded).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
  });

  it('degrades and sleeps a final snapshot that stalls with no progress after prepare', async () => {
    const env = {
      ...buildEnv(),
      SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '20',
      SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS: '5',
      SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
    } as Env;
    let degradedPersisted = false;
    mocks.completeActiveSessionSnapshotAsDegraded.mockImplementation(async () => {
      degradedPersisted = true;
      return true;
    });
    mocks.getRestorableSessionSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'degraded',
        degradation: 'transcript-only',
        expiresAt: '2026-08-19T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'degraded',
        degradation: 'transcript-only',
        sleepingAt: '2026-08-12T00:00:00.000Z',
        sleepStatus: 'sleeping',
        expiresAt: '2026-08-19T00:00:00.000Z',
      });
    mocks.getSessionSnapshotCaptureState.mockReset();
    mocks.getSessionSnapshotCaptureState.mockImplementation(async () => {
      if (degradedPersisted) {
        return {
          status: 'degraded',
          degradation: 'transcript-only',
          snapshotGeneration: 'generation-stalled',
          captureGeneration: null,
          updatedAt: '2026-08-15T00:00:00.006Z',
        };
      }
      return {
        status: 'pending',
        degradation: 'none',
        snapshotGeneration: null,
        captureGeneration: 'generation-stalled',
        updatedAt: '2026-08-15T00:00:00.000Z',
      };
    });
    const { sleepWorkspaceSession } = await import('../../../src/services/session-sleep');

    await expect(
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'stalled',
      })
    ).resolves.toMatchObject({ status: 'sleeping' });

    expect(mocks.completeActiveSessionSnapshotAsDegraded).toHaveBeenCalledWith(
      expect.anything(),
      env,
      expect.objectContaining({
        workspaceId: 'workspace-1',
        chatSessionId: 'chat-1',
        captureGeneration: 'generation-stalled',
        reason: 'Workspace snapshot made no progress for 5ms',
      })
    );
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
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

  // DISCRIMINATING: this test MUST fail when the isHarnessWorkLeaseActive
  // check in the stateBefore gate (session-sleep.ts, sleepWorkspaceSession)
  // is removed. It covers the scenario where harness work is active from
  // the start (not just appearing mid-verification), proving the check at
  // the very first gate prevents the destructive path.
  it('aborts before stopping when harness work is active from the start', async () => {
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: 100,
      runtimeWorkState: 'active',
      runtimeWorkCount: 2,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkUpdatedAt: Date.now() - 10_000,
      runtimeWorkProgressAt: Date.now() - 10_000,
    });
    mocks.getRestorableSessionSnapshot
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
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
    ).rejects.toThrow('Workspace agent is not idle');

    expect(mocks.beginSessionSnapshotStopping).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.sleepSession).not.toHaveBeenCalled();
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).toHaveBeenCalledTimes(1);
  });

  // Gate 2 (stateAfter): harness work starts between stateBefore and
  // stateAfter. stateBefore is idle, stateAfter has active harness work.
  it('aborts after snapshot when harness work begins during verification', async () => {
    const now = Date.now();
    let callCount = 0;
    mocks.getSessionState.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        // stateBefore: idle, no harness work
        return {
          activity: 'idle',
          activityAt: 100,
          runtimeWorkState: null,
          runtimeWorkUpdatedAt: null,
          runtimeWorkProgressAt: null,
        };
      }
      // stateAfter: harness work has started
      return {
        activity: 'idle',
        activityAt: 100,
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkUpdatedAt: now - 1_000,
        runtimeWorkProgressAt: now - 1_000,
      };
    });
    mocks.getRestorableSessionSnapshot
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
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
    ).rejects.toThrow('Workspace activity changed while the final snapshot was captured');

    expect(mocks.beginSessionSnapshotStopping).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.sleepSession).not.toHaveBeenCalled();
    expect(mocks.failSessionSnapshotSleepBeforeTeardown).toHaveBeenCalledTimes(1);
  });

  // The ceiling must also block sleep at the point-of-no-return. This test
  // uses the same scenario but with an expired ceiling so sleep proceeds,
  // proving the ceiling is checked at every gate.
  it('allows sleep when harness work lease has expired', async () => {
    const now = Date.now();
    mocks.getSessionState.mockResolvedValue({
      activity: 'idle',
      activityAt: 100,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkUpdatedAt: now - 121_000,
      runtimeWorkProgressAt: now - 121_000,
    });
    mocks.getRestorableSessionSnapshot
      .mockReset()
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

    await sleepWorkspaceSession(
      buildEnv({ HARNESS_BACKGROUND_WORK_LEASE_MS: '120000' }),
      {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'test',
      }
    );

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSessionSnapshotSleeping).toHaveBeenCalledTimes(1);
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
