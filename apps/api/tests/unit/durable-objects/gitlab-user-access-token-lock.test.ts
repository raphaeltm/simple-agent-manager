import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAuthMock, logWarnMock } = vi.hoisted(() => ({
  createAuthMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
  },
}));

vi.mock('../../../src/auth', () => ({
  createAuth: createAuthMock,
}));

vi.mock('../../../src/lib/logger', () => ({
  log: {
    warn: logWarnMock,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { GitLabUserAccessTokenLock } from '../../../src/durable-objects/gitlab-user-access-token-lock';

function makeRequest(): Request {
  return new Request('https://gitlab-user-access-token-lock/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'user-1',
      flow: 'test',
      headers: [['cookie', 'session=abc']],
    }),
  });
}

function makeEnv(accountId: string | null = 'gitlab-account-row') {
  const first = vi.fn(async () => (accountId ? { id: accountId } : null));
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: { DATABASE: { prepare } },
    prepare,
    bind,
    first,
  };
}

describe('GitLabUserAccessTokenLock', () => {
  beforeEach(() => {
    createAuthMock.mockReset();
    logWarnMock.mockReset();
  });

  it('serializes overlapping expired-token refreshes per user (exactly one upstream refresh)', async () => {
    // Model GitLab's rotating single-use refresh tokens: the stored access
    // token starts expired; the first getAccessToken call performs the
    // upstream refresh (rotating the token); a properly serialized second
    // call re-reads the post-rotation state and does NOT refresh again.
    let storedToken = {
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      scopes: ['api'],
    };
    let refreshCount = 0;

    const getAccessToken = vi.fn(async () => {
      const isExpired = storedToken.accessTokenExpiresAt.getTime() <= Date.now();
      if (isExpired) {
        refreshCount += 1;
        // Simulate upstream refresh latency so an unserialized second caller
        // would observe the still-expired token and refresh again.
        await new Promise((resolve) => setTimeout(resolve, 25));
        storedToken = {
          accessToken: 'fresh-access',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          scopes: ['api'],
        };
      }
      return storedToken;
    });

    createAuthMock.mockReturnValue({ api: { getAccessToken } });

    const { env } = makeEnv();
    const lock = new GitLabUserAccessTokenLock({} as never, env as never);

    const [res1, res2] = await Promise.all([lock.fetch(makeRequest()), lock.fetch(makeRequest())]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body1 = (await res1.json()) as { accessToken: string | null };
    const body2 = (await res2.json()) as { accessToken: string | null };
    expect(body1.accessToken).toBe('fresh-access');
    expect(body2.accessToken).toBe('fresh-access');
    expect(refreshCount).toBe(1);
    expect(getAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { accountId: 'gitlab-account-row', userId: 'user-1' },
      })
    );
  });

  it('returns 401 token_unavailable when BetterAuth cannot produce a token', async () => {
    const getAccessToken = vi.fn(async () => {
      throw new Error('FAILED_TO_GET_ACCESS_TOKEN');
    });
    createAuthMock.mockReturnValue({ api: { getAccessToken } });

    const { env } = makeEnv();
    const lock = new GitLabUserAccessTokenLock({} as never, env as never);
    const res = await lock.fetch(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'token_unavailable' });
    expect(logWarnMock).toHaveBeenCalledWith(
      'gitlab.user_access_token_lock.unavailable',
      expect.objectContaining({ flow: 'test', userId: 'user-1' })
    );
  });

  it('returns 401 before BetterAuth when the user has no linked GitLab account row', async () => {
    const getAccessToken = vi.fn();
    createAuthMock.mockReturnValue({ api: { getAccessToken } });

    const { env } = makeEnv(null);
    const lock = new GitLabUserAccessTokenLock({} as never, env as never);
    const res = await lock.fetch(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'token_unavailable' });
    expect(createAuthMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith('gitlab.user_access_token_lock.account_missing', {
      flow: 'test',
      userId: 'user-1',
    });
  });

  it('rejects non-POST requests', async () => {
    createAuthMock.mockReturnValue({ api: { getAccessToken: vi.fn() } });
    const lock = new GitLabUserAccessTokenLock({} as never, {} as never);
    const res = await lock.fetch(new Request('https://gitlab-user-access-token-lock/token'));
    expect(res.status).toBe(405);
  });

  it('rejects malformed payloads', async () => {
    createAuthMock.mockReturnValue({ api: { getAccessToken: vi.fn() } });
    const lock = new GitLabUserAccessTokenLock({} as never, {} as never);
    const res = await lock.fetch(
      new Request('https://gitlab-user-access-token-lock/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });
});
