import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { GitHubUserAccessTokenLock } = await import(
  '../../../src/durable-objects/github-user-access-token-lock'
);

function makeRequest(userId = 'user-1'): Request {
  return new Request('https://do-internal/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      flow: 'test',
      headers: [['cookie', 'session=abc']],
    }),
  });
}

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

    mocks.createAuth.mockReturnValue({
      api: {
        getAccessToken: vi.fn(async () => {
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
        }),
      },
    });

    const lock = new GitHubUserAccessTokenLock({}, {} as never);
    const [first, second] = await Promise.all([
      lock.fetch(makeRequest()),
      lock.fetch(makeRequest()),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ accessToken: 'fresh-access' });
    await expect(second.json()).resolves.toMatchObject({ accessToken: 'fresh-access' });
    expect(githubRefreshPosts).toBe(1);
  });

  it('returns 401 when BetterAuth cannot produce a token', async () => {
    mocks.createAuth.mockReturnValue({
      api: {
        getAccessToken: vi.fn().mockRejectedValue(new Error('FAILED_TO_GET_ACCESS_TOKEN')),
      },
    });

    const lock = new GitHubUserAccessTokenLock({}, {} as never);
    const res = await lock.fetch(makeRequest());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'token_unavailable' });
    expect(mocks.logWarn).toHaveBeenCalledWith('github.user_access_token_lock.unavailable', {
      flow: 'test',
      userId: 'user-1',
      error: 'FAILED_TO_GET_ACCESS_TOKEN',
    });
  });
});
