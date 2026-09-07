import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VmAgentContainerLaunchConfig } from '../../../src/durable-objects/vm-agent-container';
import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';
import { ACTIVE_WORK_KEY, type ActiveWorkState } from '../../../src/durable-objects/vm-agent-container-active-work';

const { mockIsHarnessWorkLeaseActive, mockParseHarnessWorkConfig, mockGetSessionState } =
  vi.hoisted(() => ({
    mockIsHarnessWorkLeaseActive: vi.fn(),
    mockParseHarnessWorkConfig: vi.fn(() => ({
      leaseMs: 120_000,
      maxDurationMs: 1_800_000,
    })),
    mockGetSessionState: vi.fn(),
  }));

vi.mock('../../../src/services/session-idleness', () => ({
  isHarnessWorkLeaseActive: mockIsHarnessWorkLeaseActive,
  parseHarnessWorkConfig: mockParseHarnessWorkConfig,
}));

vi.mock('../../../src/services/project-data', () => ({
  getSessionState: mockGetSessionState,
}));

const callOnActivityExpired = VmAgentContainer.prototype.onActivityExpired as (
  this: unknown
) => Promise<void>;

function makeActiveWork(overrides: Partial<ActiveWorkState> = {}): ActiveWorkState {
  return {
    status: 'ended',
    nodeId: 'node-1',
    workspaceId: 'ws-1',
    agentSessionId: 'sess-1',
    reason: 'prompt',
    activeSince: Date.now() - 60_000,
    lastRenewedAt: Date.now() - 30_000,
    deadlineAt: Date.now() - 10_000,
    endedAt: Date.now() - 10_000,
    endReason: 'turn_complete',
    ...overrides,
  };
}

const launchConfig: VmAgentContainerLaunchConfig = {
  nodeId: 'node-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  chatSessionId: 'chat-1',
  repository: 'https://github.com/test/repo',
  branch: 'main',
  workspaceDir: '/workspace',
  controlPlaneUrl: 'https://api.example.com',
  vmAgentPort: 8080,
};

function makeFake(input: {
  activeWork: ActiveWorkState | undefined;
  launchConfig?: VmAgentContainerLaunchConfig | undefined;
}) {
  const storageData = new Map<string, unknown>();
  if (input.activeWork) storageData.set(ACTIVE_WORK_KEY, input.activeWork);
  if (input.launchConfig !== undefined) storageData.set('launchConfig', input.launchConfig);

  const storagePut = vi.fn(async (key: string, value: unknown) => {
    storageData.set(key, value);
  });

  return {
    ctx: {
      storage: {
        get: vi.fn(async <T>(key: string): Promise<T | undefined> => storageData.get(key) as T),
        put: storagePut,
      },
    },
    env: {} as Record<string, string>,
    renewActiveWorkKeepalive: vi.fn(async () => undefined),
    renewActivityTimeout: vi.fn(),
    markRuntimeSleeping: vi.fn(async () => 'sleeping' as const),
    stop: vi.fn(async () => undefined),
    storagePut,
    storageData,
  };
}

describe('onActivityExpired harness work lease integration', () => {
  beforeEach(() => {
    mockIsHarnessWorkLeaseActive.mockReset();
    mockParseHarnessWorkConfig.mockReset().mockReturnValue({
      leaseMs: 120_000,
      maxDurationMs: 1_800_000,
    });
    mockGetSessionState.mockReset();
  });

  it('defers sleep when ProjectData harness work is active', async () => {
    mockGetSessionState.mockResolvedValue({
      runtimeWorkState: 'busy',
      runtimeWorkUpdatedAt: Date.now(),
      runtimeWorkProgressAt: Date.now(),
    });
    mockIsHarnessWorkLeaseActive.mockReturnValue(true);

    const fake = makeFake({
      activeWork: makeActiveWork(),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(mockGetSessionState).toHaveBeenCalledWith(fake.env, 'proj-1', 'sess-1');
    expect(mockIsHarnessWorkLeaseActive).toHaveBeenCalled();
    expect(fake.renewActivityTimeout).toHaveBeenCalledOnce();
    expect(fake.storagePut).not.toHaveBeenCalledWith(
      'lifecycleStatus',
      expect.anything()
    );
    expect(fake.markRuntimeSleeping).not.toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it('proceeds to sleep when harness work lease is inactive', async () => {
    mockGetSessionState.mockResolvedValue({
      runtimeWorkState: null,
      runtimeWorkUpdatedAt: null,
      runtimeWorkProgressAt: null,
    });
    mockIsHarnessWorkLeaseActive.mockReturnValue(false);

    const fake = makeFake({
      activeWork: makeActiveWork(),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(mockGetSessionState).toHaveBeenCalledWith(fake.env, 'proj-1', 'sess-1');
    expect(mockIsHarnessWorkLeaseActive).toHaveBeenCalled();
    expect(fake.storagePut).toHaveBeenCalledWith('lifecycleStatus', 'sleep-preparing');
    expect(fake.markRuntimeSleeping).toHaveBeenCalledOnce();
  });

  it('fails closed when ProjectData lookup fails — renews timeout instead of sleeping', async () => {
    mockGetSessionState.mockRejectedValue(new Error('DO unavailable'));

    const fake = makeFake({
      activeWork: makeActiveWork(),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(fake.renewActivityTimeout).toHaveBeenCalledOnce();
    expect(fake.storagePut).not.toHaveBeenCalledWith('lifecycleStatus', expect.anything());
    expect(fake.markRuntimeSleeping).not.toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it('skips harness check when activeWork has no agentSessionId', async () => {
    const fake = makeFake({
      activeWork: makeActiveWork({ agentSessionId: '' }),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(fake.storagePut).toHaveBeenCalledWith('lifecycleStatus', 'sleep-preparing');
  });

  it('skips harness check when launchConfig is absent', async () => {
    const fake = makeFake({
      activeWork: makeActiveWork(),
      launchConfig: undefined,
    });

    await callOnActivityExpired.call(fake);

    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(fake.storagePut).toHaveBeenCalledWith('lifecycleStatus', 'sleep-preparing');
  });

  it('skips harness check when activeWork was never set (no prompt processed)', async () => {
    const fake = makeFake({
      activeWork: undefined,
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(fake.storagePut).toHaveBeenCalledWith('lifecycleStatus', 'sleep-preparing');
  });

  it('proceeds to sleep when getSessionState returns null (session not found)', async () => {
    mockGetSessionState.mockResolvedValue(null);
    mockIsHarnessWorkLeaseActive.mockReturnValue(false);

    const fake = makeFake({
      activeWork: makeActiveWork(),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(mockGetSessionState).toHaveBeenCalledWith(fake.env, 'proj-1', 'sess-1');
    expect(mockIsHarnessWorkLeaseActive).not.toHaveBeenCalled();
    expect(fake.storagePut).toHaveBeenCalledWith('lifecycleStatus', 'sleep-preparing');
  });

  it('passes correct arguments to harness helpers', async () => {
    const sessionState = {
      runtimeWorkState: 'active',
      runtimeWorkUpdatedAt: Date.now(),
      runtimeWorkProgressAt: Date.now(),
    };
    mockGetSessionState.mockResolvedValue(sessionState);
    mockIsHarnessWorkLeaseActive.mockReturnValue(true);

    const fake = makeFake({
      activeWork: makeActiveWork(),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(mockParseHarnessWorkConfig).toHaveBeenCalledWith(fake.env);
    expect(mockIsHarnessWorkLeaseActive).toHaveBeenCalledWith(
      sessionState,
      expect.any(Date),
      { leaseMs: 120_000, maxDurationMs: 1_800_000 }
    );
  });

  it('renews keepalive when active work deadline has not passed', async () => {
    const fake = makeFake({
      activeWork: makeActiveWork({
        status: 'active',
        deadlineAt: Date.now() + 60_000,
      }),
      launchConfig,
    });

    await callOnActivityExpired.call(fake);

    expect(fake.renewActiveWorkKeepalive).toHaveBeenCalledOnce();
    expect(fake.storagePut).not.toHaveBeenCalledWith(
      'lifecycleStatus',
      expect.anything()
    );
    expect(fake.markRuntimeSleeping).not.toHaveBeenCalled();
  });
});
