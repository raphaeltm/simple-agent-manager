import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAuth: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('../../../src/auth', () => ({
  createAuth: mocks.createAuth,
}));

vi.mock('../../../src/lib/logger', () => ({
  log: {
    warn: mocks.logWarn,
    info: mocks.logInfo,
    error: vi.fn(),
  },
}));

import type { Env } from '../../../src/env';
import { getGitLabUserAccessTokenWithHeaders } from '../../../src/services/gitlab';

function makeLockBinding(response: Response) {
  const stubFetch = vi.fn(async () => response);
  const binding = {
    idFromName: vi.fn(() => 'do-id'),
    get: vi.fn(() => ({ fetch: stubFetch })),
  };
  return { binding, stubFetch };
}

describe('getGitLabUserAccessTokenWithHeaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes through the per-user DO lock when the binding is present', async () => {
    const { binding, stubFetch } = makeLockBinding(
      Response.json({
        accessToken: 'locked-access',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['api'],
      })
    );
    const env = { GITLAB_USER_ACCESS_TOKEN_LOCK: binding } as unknown as Env;
    const headers = new Headers({ cookie: 'session=abc' });

    const token = await getGitLabUserAccessTokenWithHeaders(env, headers, 'user-1', 'request');

    expect(token).toBe('locked-access');
    // The DO lock is keyed per user so overlapping refreshes serialize.
    expect(binding.idFromName).toHaveBeenCalledWith('user-1');
    expect(stubFetch).toHaveBeenCalledTimes(1);
    const [, init] = stubFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      userId: 'user-1',
      flow: 'request',
      headers: [['cookie', 'session=abc']],
    });
    // Proves the direct (unlocked) path was NOT used when the binding exists.
    expect(mocks.createAuth).not.toHaveBeenCalled();
  });

  it('falls back to the direct path only when the binding is absent', async () => {
    mocks.createAuth.mockResolvedValue({
      api: {
        getAccessToken: vi.fn(async () => ({
          accessToken: 'direct-access',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          scopes: ['api'],
        })),
      },
    });
    const env = {} as unknown as Env;

    const token = await getGitLabUserAccessTokenWithHeaders(
      env,
      new Headers(),
      'user-1',
      'request'
    );

    expect(token).toBe('direct-access');
    expect(mocks.createAuth).toHaveBeenCalledTimes(1);
  });

  it('returns null when the DO lock reports token_unavailable', async () => {
    const { binding } = makeLockBinding(
      Response.json({ error: 'token_unavailable' }, { status: 401 })
    );
    const env = { GITLAB_USER_ACCESS_TOKEN_LOCK: binding } as unknown as Env;

    const token = await getGitLabUserAccessTokenWithHeaders(
      env,
      new Headers(),
      'user-1',
      'request'
    );

    expect(token).toBeNull();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'gitlab.user_access_token_unavailable',
      expect.objectContaining({ userId: 'user-1', status: 401 })
    );
  });

  it('returns null for an expired token returned by the DO lock', async () => {
    const { binding } = makeLockBinding(
      Response.json({
        accessToken: 'stale-access',
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        scopes: ['api'],
      })
    );
    const env = { GITLAB_USER_ACCESS_TOKEN_LOCK: binding } as unknown as Env;

    const token = await getGitLabUserAccessTokenWithHeaders(
      env,
      new Headers(),
      'user-1',
      'request'
    );

    expect(token).toBeNull();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'gitlab.user_access_token_expired',
      expect.objectContaining({ userId: 'user-1' })
    );
  });
});
