import { type Context } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getTokenType } from './github-route-helpers';
import {
  availableUserAccessToken,
  getBetterAuthAccessTokenForProvider,
  requestLockedUserAccessToken,
  type UserAccessTokenResult,
} from './user-access-token';

function availableGitHubAccessToken(
  token: UserAccessTokenResult,
  flow: string,
  userId: string
): string | null {
  return availableUserAccessToken(token, (accessTokenExpiresAt) => {
    log.warn('github.user_access_token_expired', {
      flow,
      userId,
      tokenPresent: true,
      accessTokenExpiresAt,
    });
  });
}

async function getDirectGitHubUserAccessTokenWithHeaders(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  flow: string
): Promise<string | null> {
  try {
    const token = await getBetterAuthAccessTokenForProvider(env, headers, userId, 'github');
    if (!token) {
      log.warn('github.user_access_token_account_missing', {
        flow,
        userId,
        tokenPresent: false,
      });
      return null;
    }
    log.info('github.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      tokenType: getTokenType(token),
      scopes: token.scopes,
    });
    return availableGitHubAccessToken(token, flow, userId);
  } catch (err) {
    log.warn('github.user_access_token_unavailable', {
      flow,
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getGitHubUserAccessTokenWithHeaders(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  flow: string
): Promise<string | null> {
  if (!env.GITHUB_USER_ACCESS_TOKEN_LOCK) {
    return getDirectGitHubUserAccessTokenWithHeaders(env, headers, userId, flow);
  }

  try {
    const { token, status } = await requestLockedUserAccessToken(
      env.GITHUB_USER_ACCESS_TOKEN_LOCK,
      'https://github-user-access-token-lock/token',
      headers,
      userId,
      flow,
      'github.user_access_token.locked'
    );
    if (!token) {
      log.warn('github.user_access_token_unavailable', {
        flow,
        userId,
        tokenPresent: false,
        status,
      });
      return null;
    }

    log.info('github.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      tokenType: getTokenType(token),
      scopes: token.scopes,
    });
    return availableGitHubAccessToken(token, flow, userId);
  } catch (err) {
    log.warn('github.user_access_token_unavailable', {
      flow,
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Get the current user's GitHub access token from BetterAuth.
 * BetterAuth owns OAuth token encryption/refresh; callers should not read the
 * encrypted accounts table directly.
 */
export async function getGitHubUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string | null> {
  return getGitHubUserAccessTokenWithHeaders(c.env, c.req.raw.headers, userId, 'request');
}

/**
 * Resolve a user's GitHub OAuth token without relying on a browser session.
 *
 * VM-agent callback routes know the owning SAM user from persisted workspace
 * state, but they authenticate with callback JWTs rather than BetterAuth
 * cookies. BetterAuth still owns OAuth token refresh/decryption. Omitting the
 * headers property marks this as a trusted server-side user-id lookup; Better
 * Auth 1.7 treats even an empty Headers object as an unauthenticated request.
 */
export async function getGitHubUserAccessTokenForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<string | null> {
  return getGitHubUserAccessTokenWithHeaders(env, undefined, userId, flow);
}
