import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedGitRepo } from '../../../src/selfhost/hosted-git/hosted-git-repo';
import { DEFAULT_HOSTED_GIT_LIMITS } from '../../../src/selfhost/hosted-git/limits';
const mocks = vi.hoisted(() => ({
  pending: '1',
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
    getMeta() {
      return mocks.pending;
    }
    setMeta(_key: string, value: string) {
      mocks.pending = value;
    }
  },
}));
vi.mock('../../../src/selfhost/hosted-git/hosted-git-gc', () => ({ runHostedGitGc: mocks.gc }));
beforeEach(() => {
  mocks.pending = '1';
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
    await vi.waitFor(() => expect(mocks.pending).toBe('0'));
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
});
