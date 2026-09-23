import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAuth: vi.fn(),
}));

vi.mock('../../../src/auth', () => ({ createAuth: mocks.createAuth }));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

import type { Env } from '../../../src/env';
import {
  getGitHubUserAccessTokenForOwner,
  getGitHubUserAccessTokenWithHeaders,
} from '../../../src/services/github-user-access-token';

function makeEnv() {
  return {
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => ({ id: 'github-account-row' })) })),
      })),
    },
  } as unknown as Env;
}

describe('GitHub user access-token caller context', () => {
  beforeEach(() => vi.clearAllMocks());

  it('omits headers for a trusted owner lookup', async () => {
    const getAccessToken = vi.fn(async () => ({ accessToken: 'owner-token' }));
    mocks.createAuth.mockResolvedValue({ api: { getAccessToken } });

    await expect(getGitHubUserAccessTokenForOwner(makeEnv(), 'user-1')).resolves.toBe(
      'owner-token'
    );
    expect(getAccessToken).toHaveBeenCalledWith({
      body: { accountId: 'github-account-row', userId: 'user-1' },
    });
  });

  it('preserves session headers for a request lookup', async () => {
    const getAccessToken = vi.fn(async () => ({ accessToken: 'request-token' }));
    mocks.createAuth.mockResolvedValue({ api: { getAccessToken } });
    const headers = new Headers({ cookie: 'session=abc' });

    await expect(
      getGitHubUserAccessTokenWithHeaders(makeEnv(), headers, 'user-1', 'request')
    ).resolves.toBe('request-token');
    expect(getAccessToken).toHaveBeenCalledWith({
      headers,
      body: { accountId: 'github-account-row', userId: 'user-1' },
    });
  });
});
