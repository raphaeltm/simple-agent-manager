import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedGitRepo } from '../../../src/selfhost/hosted-git/hosted-git-repo';
import { DEFAULT_HOSTED_GIT_LIMITS } from '../../../src/selfhost/hosted-git/limits';
const mocks = vi.hoisted(() => ({
  pending: '1',
  attempts: '0',
  gc: vi.fn(async () => ({ removed: 1, kept: 2 })),
  setAlarm: vi.fn(async () => undefined),
}));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
  },
}));
vi.mock('../../../src/selfhost/hosted-git/policy', () => ({
  resolveHostedGitLimits: async () => DEFAULT_HOSTED_GIT_LIMITS,
}));
vi.mock('../../../src/vendor/dgit/git/store', () => ({
  GitStore: class {
    packs = { cleanupOrphans: async () => undefined };
    getMeta(key: string) {
      return key === 'gc-attempts' ? mocks.attempts : mocks.pending;
    }
    setMeta(key: string, value: string) {
      if (key === 'gc-attempts') mocks.attempts = value;
      else mocks.pending = value;
    }
  },
}));
vi.mock('../../../src/selfhost/hosted-git/hosted-git-gc', () => ({ runHostedGitGc: mocks.gc }));
beforeEach(() => {
  mocks.pending = '1';
  mocks.attempts = '0';
  mocks.gc.mockReset().mockResolvedValue({ removed: 1, kept: 2 });
  vi.clearAllMocks();
});
describe('hosted git GC admission', () => {
  it('rechecks uploads after waiting behind a push, and runs once after the upload leaves', async () => {
    const ctx = {
      storage: { setAlarm: mocks.setAlarm },
      blockConcurrencyWhile: async (action: () => Promise<void>) => action(),
    };
    const repo = new HostedGitRepo(ctx as unknown as DurableObjectState, {});
    // Hold the same promise-chain slot that receive-pack owns, exercising alarm's real queue.
    let releasePush = () => {};
    const state = repo as unknown as { receiveChain: Promise<void>; activeUploads: number };
    state.receiveChain = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const alarm = repo.alarm();
    await Promise.resolve();
    await Promise.resolve();
    state.activeUploads = 1;
    releasePush();
    await alarm;
    expect(mocks.gc).not.toHaveBeenCalled();
    expect(mocks.pending).toBe('1');
    expect(mocks.setAlarm).toHaveBeenCalledOnce();
    state.activeUploads = 0;
    await repo.alarm();
    expect(mocks.gc).toHaveBeenCalledOnce();
    expect(mocks.pending).toBe('0');
    await repo.alarm();
    expect(mocks.gc).toHaveBeenCalledOnce();
  });
  it('retries a transient failed sweep and resets its attempt budget after success', async () => {
    const ctx = { storage: { setAlarm: mocks.setAlarm }, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() };
    const repo = new HostedGitRepo(ctx as unknown as DurableObjectState, {});
    for (let cycle = 0; cycle < 4; cycle++) {
      mocks.pending = '1';
      mocks.gc.mockRejectedValueOnce(new Error('transient read failure'));
      await repo.alarm();
      expect(mocks.pending).toBe('1'); expect(mocks.attempts).toBe('1');
      expect(mocks.setAlarm).toHaveBeenCalledTimes(cycle + 1);
      await repo.alarm();
      expect(mocks.pending).toBe('0'); expect(mocks.attempts).toBe('0');
    }
    const calls = mocks.gc.mock.calls.length;
    await repo.alarm(); expect(mocks.gc).toHaveBeenCalledTimes(calls);
  });
  it('stops automatic retries after the configured consecutive failure budget', async () => {
    const repo = new HostedGitRepo({ storage: { setAlarm: mocks.setAlarm }, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState, {});
    mocks.gc.mockRejectedValue(new Error('permanent failure'));
    for (let tick = 0; tick < 5; tick++) await repo.alarm();
    expect(mocks.gc).toHaveBeenCalledTimes(3);
    expect(mocks.setAlarm).toHaveBeenCalledTimes(2);
    expect(mocks.pending).toBe('failed');
  });

});
