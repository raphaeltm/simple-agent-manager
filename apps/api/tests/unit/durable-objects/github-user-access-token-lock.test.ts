import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  expectBetterAuthTokenLookup,
  expectTrustedOwnerTokenLookup,
  makeAccessTokenLockRequest,
  makeBetterAuthAccountEnv,
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

vi.mock('../../../src/lib/logger', () => ({
  log: {
    warn: mocks.logWarn,
  },
}));

const { GitHubUserAccessTokenLock } =
  await import('../../../src/durable-objects/github-user-access-token-lock');

describe('GitHubUserAccessTokenLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const lock = new GitHubUserAccessTokenLock({}, env as never);
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
    const lock = new GitHubUserAccessTokenLock({}, env as never);
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
    const lock = new GitHubUserAccessTokenLock({}, env as never);

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
    const lock = new GitHubUserAccessTokenLock({}, env as never);
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
