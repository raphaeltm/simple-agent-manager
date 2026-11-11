import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  expectBetterAuthTokenLookup,
  expectTrustedOwnerTokenLookup,
  makeAccessTokenLockRequest,
  makeBetterAuthAccountEnv,
  makeLockState,
} from './access-token-lock-test-helpers';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const mocks = vi.hoisted(() => ({
  createAuth: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../../src/auth', () => ({
  createAuth: mocks.createAuth,
}));

vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: {
    info: vi.fn(),
    warn: mocks.logWarn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { GitHubUserAccessTokenLock } =
  await import('../../../src/durable-objects/github-user-access-token-lock');

describe('GitHubUserAccessTokenLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Records when a response settles; read it after advancing the fake clock. */
  function track(promise: Promise<Response>): { response: Response | null } {
    const tracked: { response: Response | null } = { response: null };
    void promise.then((response) => {
      tracked.response = response;
    });
    return tracked;
  }

  /** A getAccessToken mock whose lookups take `ms` of fake time and record overlap. */
  function timedLookups(ms: number) {
    const stats = { active: 0, maxActive: 0, calls: 0 };
    const lookup = async () => {
      stats.calls += 1;
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      stats.active -= 1;
      return { accessToken: `token-${stats.calls}` };
    };
    return { stats, lookup };
  }

  it('lets a waiter take over when the holder was abandoned and its timers never fire', async () => {
    vi.useFakeTimers();
    // celld cancels a Durable Object event when its caller disconnects and drops the event's
    // pending I/O (D1, fetch, timers) without settling it. Reproduce that for the first call:
    // its lookup never settles and every timer it creates is discarded.
    const realSetTimeout = globalThis.setTimeout;
    let dropTimers = true;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) =>
      dropTimers ? 0 : realSetTimeout(callback, ms)) as typeof setTimeout);
    const getAccessToken = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ accessToken: 'fresh-access', scopes: ['read:user'] });
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });

    // No settings row: the deadline comes from the real admin-setting resolver's default.
    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);
    const abandoned = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    dropTimers = false;

    const next = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    await vi.advanceTimersByTimeAsync(59_900);
    expect(next.response).toBeNull();
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(next.response?.status).toBe(200);
    await expect(next.response!.json()).resolves.toMatchObject({ accessToken: 'fresh-access' });
    expect(mocks.logWarn).toHaveBeenCalledWith('github.user_access_token_lock.stale_holder', {
      flow: 'test',
      userId: 'user-1',
      timeoutMs: 60_000,
      action: 'took_over',
    });
    // The abandoned caller is gone; its response never matters, and it stays unsettled.
    expect(abandoned.response).toBeNull();
  });

  it('answers 503 to a caller whose own lookup hangs, and the queued lookup then runs', async () => {
    vi.useFakeTimers();
    const getAccessToken = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ accessToken: 'fresh-access', scopes: ['read:user'] });
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });

    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);
    const hung = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    const queued = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));

    await vi.advanceTimersByTimeAsync(59_900);
    expect(hung.response).toBeNull();
    expect(queued.response).toBeNull();
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(hung.response?.status).toBe(503);
    await expect(hung.response!.json()).resolves.toEqual({ error: 'token_lock_timeout' });
    expect(mocks.logWarn).toHaveBeenCalledWith('github.user_access_token_lock.timeout', {
      flow: 'test',
      userId: 'user-1',
      timeoutMs: 60_000,
      action: 'answered_503',
    });
    expect(queued.response?.status).toBe(200);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('never overlaps healthy slow lookups, even when the queue outlasts the deadline', async () => {
    vi.useFakeTimers();
    // Four callers at once, 25 s each: the last one waits 75 s, longer than the 60 s deadline,
    // but every holder finishes inside its own deadline, so nobody may run concurrently.
    const { stats, lookup } = timedLookups(25_000);
    mocks.createAuth.mockReturnValue({ api: { getAccessToken: vi.fn(lookup) } });
    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);

    const callers = Array.from({ length: 4 }, () =>
      track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')))
    );
    await vi.advanceTimersByTimeAsync(110_000);

    expect(callers.map((caller) => caller.response?.status)).toEqual([200, 200, 200, 200]);
    expect(stats.calls).toBe(4);
    expect(stats.maxActive).toBe(1);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('hands a stuck holder over to exactly one waiter at a time', async () => {
    vi.useFakeTimers();
    const { stats, lookup } = timedLookups(5_000);
    const getAccessToken = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(lookup);
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });
    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);

    track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    const waiters = Array.from({ length: 3 }, () =>
      track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')))
    );
    await vi.advanceTimersByTimeAsync(80_000);

    expect(waiters.map((waiter) => waiter.response?.status)).toEqual([200, 200, 200]);
    expect(stats.calls).toBe(3);
    // The waiters released together by the stuck holder still run one after another.
    expect(stats.maxActive).toBe(1);
    const takeovers = mocks.logWarn.mock.calls.filter(
      ([event]) => event === 'github.user_access_token_lock.stale_holder'
    );
    expect(takeovers).toHaveLength(1);
  });

  it('does not let a stuck holder that wakes after a takeover release the new holder', async () => {
    vi.useFakeTimers();
    const { stats, lookup } = timedLookups(30_000);
    let wakeStuck: (value: unknown) => void = () => {};
    const getAccessToken = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            wakeStuck = resolve;
          })
      )
      .mockImplementation(lookup);
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });
    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);

    track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    const takeover = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));

    // At 60 s the waiter takes over and starts a 30 s lookup; at 70 s the stuck lookup wakes.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(stats.calls).toBe(1);
    wakeStuck({ accessToken: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    // A caller arriving now must queue behind the takeover holder, not start beside it.
    const last = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    await vi.advanceTimersByTimeAsync(0);
    expect(stats.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(takeover.response?.status).toBe(200);
    expect(last.response?.status).toBe(200);
    expect(stats.maxActive).toBe(1);
  });

  it('keeps each lookup alive past its caller with waitUntil', async () => {
    const getAccessToken = vi.fn(async () => ({ accessToken: 'token' }));
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });
    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const state = makeLockState();
    const lock = new GitHubUserAccessTokenLock(state as never, env as never);

    const res = await lock.fetch(makeAccessTokenLockRequest('https://do-internal/token'));

    expect(res.status).toBe(200);
    expect(state.waitUntil).toHaveBeenCalledTimes(1);
    // The registered promise is the lock chain itself: it settles once the lookup is done.
    await expect(state.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  it('keeps serializing a slow lookup that finishes inside the deadline', async () => {
    vi.useFakeTimers();
    let finishFirst: (value: unknown) => void = () => {};
    const getAccessToken = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValue({ accessToken: 'second-access' });
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });

    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);
    const first = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));
    const second = track(lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')));

    await vi.advanceTimersByTimeAsync(45_000);
    // The second lookup must not start while the first still holds the lock.
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    finishFirst({ accessToken: 'first-access' });
    await vi.advanceTimersByTimeAsync(0);

    expect(first.response?.status).toBe(200);
    expect(second.response?.status).toBe(200);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(mocks.logWarn).not.toHaveBeenCalledWith(
      'github.user_access_token_lock.timeout',
      expect.anything()
    );
  });

  it('serializes overlapping expired-token refreshes per user', async () => {
    let storedToken = {
      accessToken: 'expired-access',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    };
    let githubRefreshPosts = 0;

    const getAccessToken = vi.fn(async () => {
      const snapshot = { ...storedToken };
      if (snapshot.accessTokenExpiresAt.getTime() <= Date.now()) {
        githubRefreshPosts += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        storedToken = {
          accessToken: 'fresh-access',
          refreshToken: 'refresh-2',
          accessTokenExpiresAt: new Date(Date.now() + 28_800_000),
        };
        return {
          accessToken: storedToken.accessToken,
          accessTokenExpiresAt: storedToken.accessTokenExpiresAt,
          scopes: ['read:user'],
        };
      }
      return {
        accessToken: snapshot.accessToken,
        accessTokenExpiresAt: snapshot.accessTokenExpiresAt,
        scopes: ['read:user'],
      };
    });
    mocks.createAuth.mockReturnValue({
      api: {
        getAccessToken,
      },
    });

    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);
    const [first, second] = await Promise.all([
      lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')),
      lock.fetch(makeAccessTokenLockRequest('https://do-internal/token')),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ accessToken: 'fresh-access' });
    await expect(second.json()).resolves.toMatchObject({ accessToken: 'fresh-access' });
    expect(githubRefreshPosts).toBe(1);
    expectBetterAuthTokenLookup(getAccessToken, 'github-account-row');
  });

  it('returns 401 when BetterAuth cannot produce a token', async () => {
    mocks.createAuth.mockReturnValue({
      api: {
        getAccessToken: vi.fn().mockRejectedValue(new Error('FAILED_TO_GET_ACCESS_TOKEN')),
      },
    });

    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);
    const res = await lock.fetch(makeAccessTokenLockRequest('https://do-internal/token'));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'token_unavailable' });
    expect(mocks.logWarn).toHaveBeenCalledWith('github.user_access_token_lock.unavailable', {
      flow: 'test',
      userId: 'user-1',
      error: 'FAILED_TO_GET_ACCESS_TOKEN',
    });
  });

  it('preserves the trusted owner context by omitting headers for Better Auth', async () => {
    const getAccessToken = vi.fn(async () => ({ accessToken: 'owner-token' }));
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });
    const { env } = makeBetterAuthAccountEnv('github-account-row');
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);

    const res = await lock.fetch(
      makeAccessTokenLockRequest('https://do-internal/token', { includeHeaders: false })
    );

    expect(res.status).toBe(200);
    expectTrustedOwnerTokenLookup(getAccessToken, 'github-account-row');
  });

  it('returns 401 before BetterAuth when the user has no linked GitHub account row', async () => {
    const getAccessToken = vi.fn();
    mocks.createAuth.mockReturnValue({ api: { getAccessToken } });

    const { env } = makeBetterAuthAccountEnv(null);
    const lock = new GitHubUserAccessTokenLock(makeLockState() as never, env as never);
    const res = await lock.fetch(makeAccessTokenLockRequest('https://do-internal/token'));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'token_unavailable' });
    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith('github.user_access_token_lock.account_missing', {
      flow: 'test',
      userId: 'user-1',
    });
  });
});
