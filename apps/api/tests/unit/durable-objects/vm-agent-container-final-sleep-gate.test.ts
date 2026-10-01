import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: null as Record<string, unknown> | null,
  claim: vi.fn(),
  verify: vi.fn(),
  begin: vi.fn(),
  finalize: vi.fn(),
  fail: vi.fn(),
  defer: vi.fn(),
  sleepSession: vi.fn(),
  persistSleeping: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({ where: () => ({ get: async () => ({ id: 'agent-1' }) }) }),
    }),
  }),
}));
vi.mock('../../../src/services/session-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/session-snapshots')>()),
  getRestorableSessionSnapshot: async () => mocks.snapshot,
  // Deliberately model the broader recovery predicate: the container's own
  // pre-claim gate must reject degraded and in-flight final captures.
  isSessionSnapshotSleepReleasable: () => true,
  claimSessionSnapshotSleep: (...args: unknown[]) => mocks.claim(...args),
  verifySessionSnapshotArtifactsForSleep: (...args: unknown[]) => mocks.verify(...args),
  beginSessionSnapshotStopping: (...args: unknown[]) => mocks.begin(...args),
  finalizeSessionSnapshotSleeping: (...args: unknown[]) => mocks.finalize(...args),
  failSessionSnapshotSleepBeforeTeardown: (...args: unknown[]) => mocks.fail(...args),
  deferSessionSnapshotStopping: (...args: unknown[]) => mocks.defer(...args),
}));
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  sleepSession: (...args: unknown[]) => mocks.sleepSession(...args),
}));
vi.mock('../../../src/durable-objects/vm-agent-container-runtime', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/durable-objects/vm-agent-container-runtime')
  >()),
  persistRuntimeSleeping: (...args: unknown[]) => mocks.persistSleeping(...args),
}));

import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';

const launchConfig = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  chatSessionId: 'chat-1',
};
const completeSnapshot = {
  chatSessionId: 'chat-1',
  workspaceId: 'workspace-1',
  nodeId: 'node-1',
  runtime: 'cf-container',
  agentSessionId: 'agent-1',
  snapshotGeneration: 'final-1',
  captureGeneration: null,
  status: 'available',
  degradation: 'none',
  sleepStatus: 'scheduled',
  sleepingAt: null,
  sleepAttempts: 0,
};
const markRuntimeSleeping = (
  VmAgentContainer.prototype as unknown as {
    markRuntimeSleeping: (this: unknown, message: string) => Promise<string>;
  }
).markRuntimeSleeping;

function fakeContainer() {
  return {
    ctx: { storage: { get: vi.fn(async () => launchConfig) } },
    env: { DATABASE: {} },
    markActiveWorkEnded: vi.fn(async () => {}),
  };
}

describe('Instant final snapshot sleep claim gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot = { ...completeSnapshot };
    mocks.claim.mockImplementation(async () => {
      if (mocks.snapshot) {
        mocks.snapshot.sleepAttempts = Number(mocks.snapshot.sleepAttempts) + 1;
      }
      return { status: 'claimed', phase: 'preparing' };
    });
    mocks.verify.mockResolvedValue(true);
    mocks.begin.mockResolvedValue(true);
    mocks.finalize.mockResolvedValue(true);
  });

  it.each([
    ['degraded capture', { status: 'degraded', degradation: 'home-skipped' }],
    ['capture in flight', { captureGeneration: 'capture-2' }],
  ])('rejects repeated %s expiry before a sleep claim', async (_name, patch) => {
    mocks.snapshot = { ...completeSnapshot, ...patch };
    const container = fakeContainer();

    expect(await markRuntimeSleeping.call(container, 'idle')).toBe('aborted');
    expect(await markRuntimeSleeping.call(container, 'idle')).toBe('aborted');

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.sleepSession).not.toHaveBeenCalled();
    expect(mocks.persistSleeping).not.toHaveBeenCalled();
    expect(mocks.snapshot?.sleepAttempts).toBe(0);
  });

  it('claims and completes a verified complete final generation', async () => {
    const container = fakeContainer();

    expect(await markRuntimeSleeping.call(container, 'idle')).toBe('sleeping');

    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledWith(
      container.env,
      expect.objectContaining({ snapshotGeneration: 'final-1' })
    );
    expect(mocks.begin).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      expect.any(String),
      'final-1'
    );
    expect(mocks.sleepSession).toHaveBeenCalledWith(container.env, 'project-1', 'chat-1');
    expect(mocks.persistSleeping).toHaveBeenCalledOnce();
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.snapshot?.sleepAttempts).toBe(1);
  });
});
