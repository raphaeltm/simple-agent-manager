import { describe, expect, it, vi } from 'vitest';

import { refreshGitHubAccessToken } from '../../src/auth';
import type { Env } from '../../src/env';

describe('refreshGitHubAccessToken', () => {
  const env = {
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
  } as Env;

  it('throws when GitHub returns HTTP 200 with an OAuth error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({ error: 'bad_refresh_token', error_description: 'The refresh token is invalid' })
    ));

    await expect(refreshGitHubAccessToken(env, 'refresh-token')).rejects.toThrow('GitHub OAuth refresh failed');
  });

  it('maps successful GitHub refresh responses into BetterAuth token fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 28_800,
      refresh_token_expires_in: 15_768_000,
      scope: 'read:user,user:email,read:org',
      token_type: 'bearer',
    })));

    const result = await refreshGitHubAccessToken(env, 'refresh-token');

    expect(result).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenType: 'bearer',
      scopes: ['read:user', 'user:email', 'read:org'],
    });
    expect(result.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(result.refreshTokenExpiresAt).toBeInstanceOf(Date);
  });
});
