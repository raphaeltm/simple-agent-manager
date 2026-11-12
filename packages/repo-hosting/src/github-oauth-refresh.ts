/**
 * GitHub OAuth user-token refresh, used when a stored user access token expires.
 * Re-exported from `../auth` for existing callers.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { getGitHubOAuthConfig } from './platform-config';

const log = createModuleLogger('auth');

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const githubRefreshTokenSuccessSchema = v.object({
  access_token: v.string(),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  refresh_token_expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  token_type: v.optional(v.string()),
  id_token: v.optional(v.string()),
});

const githubRefreshTokenErrorSchema = v.object({
  error: v.string(),
  error_description: v.optional(v.string()),
});

function expiresAtFromSeconds(seconds: number | undefined): Date | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
}

export async function refreshGitHubAccessToken(env: Env, refreshToken: string) {
  const githubOAuth = await getGitHubOAuthConfig(env);
  if (!githubOAuth) {
    throw new Error('GitHub OAuth is not configured');
  }

  const requestBody = new URLSearchParams();
  requestBody.set('client_id', githubOAuth.clientId);
  requestBody.set('client_secret', githubOAuth.clientSecret);
  requestBody.set('grant_type', 'refresh_token');
  requestBody.set('refresh_token', refreshToken);

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SAM-Auth',
    },
    body: requestBody,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    log.warn('github_oauth_refresh_failed', { status: response.status });
    throw new Error('GitHub OAuth refresh failed');
  }

  const errorResult = v.safeParse(githubRefreshTokenErrorSchema, body);
  if (errorResult.success) {
    log.warn('github_oauth_refresh_error_body', {
      status: response.status,
      error: errorResult.output.error,
    });
    throw new Error('GitHub OAuth refresh failed');
  }

  const data = v.parse(githubRefreshTokenSuccessSchema, body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: expiresAtFromSeconds(data.expires_in),
    refreshTokenExpiresAt: expiresAtFromSeconds(data.refresh_token_expires_in),
    scopes: data.scope ? data.scope.split(/[,\s]+/).filter(Boolean) : [],
    tokenType: data.token_type,
    idToken: data.id_token,
    raw: data,
  };
}
