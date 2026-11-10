/** GitLab user access tokens (BetterAuth account tokens, refreshed under a per-user lock). */
import { type Context } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { AppError } from '../middleware/error';
import {
  availableUserAccessToken,
  getBetterAuthAccessTokenForProvider,
  requestLockedUserAccessToken,
  userAccessTokenExpiryIso,
  type UserAccessTokenResult,
} from './user-access-token';

export type GitLabAccessTokenResult = {
  accessToken: string;
  /** ISO timestamp of access-token expiry, or null when the provider did not report one. */
  accessTokenExpiresAt: string | null;
};

function availableGitLabAccessToken(
  token: UserAccessTokenResult,
  flow: string,
  userId: string
): GitLabAccessTokenResult | null {
  const accessToken = availableUserAccessToken(token, (accessTokenExpiresAt) => {
    log.warn('gitlab.user_access_token_expired', {
      flow,
      userId,
      tokenPresent: true,
      accessTokenExpiresAt,
    });
  });
  return accessToken
    ? { accessToken, accessTokenExpiresAt: userAccessTokenExpiryIso(token.accessTokenExpiresAt) }
    : null;
}

async function getDirectGitLabUserAccessTokenResultWithHeaders(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  flow: string
): Promise<GitLabAccessTokenResult | null> {
  try {
    const token = await getBetterAuthAccessTokenForProvider(env, headers, userId, 'gitlab');
    if (!token) {
      log.warn('gitlab.user_access_token_account_missing', {
        flow,
        userId,
        tokenPresent: false,
      });
      return null;
    }
    log.info('gitlab.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      scopes: token.scopes,
    });
    return availableGitLabAccessToken(token, flow, userId);
  } catch (err) {
    log.warn('gitlab.user_access_token_unavailable', {
      flow,
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the user's GitLab OAuth access token, serializing lookup/refresh per
 * user through the GitLabUserAccessTokenLock Durable Object. GitLab refresh
 * tokens are rotating and single-use — two concurrent refreshes replay a
 * consumed refresh token and revoke the whole token family upstream, so the
 * entire BetterAuth getAccessToken call must run inside the per-user lock.
 * Falls back to the direct (unlocked) path only when the DO binding is absent
 * (local dev / Miniflare without the binding configured).
 */
export async function getGitLabUserAccessTokenResultWithHeaders(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  flow: string
): Promise<GitLabAccessTokenResult | null> {
  if (!env.GITLAB_USER_ACCESS_TOKEN_LOCK) {
    // Without the DO lock, concurrent refreshes can replay a consumed rotating
    // refresh token and revoke the token family upstream. Acceptable only in
    // local dev / test harnesses that lack the binding — never in deployment.
    log.warn('gitlab.user_access_token_lock_binding_absent', {
      flow,
      userId,
      action: 'unserialized_direct_lookup',
    });
    return getDirectGitLabUserAccessTokenResultWithHeaders(env, headers, userId, flow);
  }
  try {
    const { token, status } = await requestLockedUserAccessToken(
      env.GITLAB_USER_ACCESS_TOKEN_LOCK,
      'https://gitlab-user-access-token-lock/token',
      headers,
      userId,
      flow,
      'gitlab.user_access_token.locked'
    );
    if (!token) {
      log.warn('gitlab.user_access_token_unavailable', {
        flow,
        userId,
        tokenPresent: false,
        status,
      });
      return null;
    }
    log.info('gitlab.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      scopes: token.scopes,
    });
    return availableGitLabAccessToken(token, flow, userId);
  } catch (err) {
    log.warn('gitlab.user_access_token_unavailable', {
      flow,
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getGitLabUserAccessTokenWithHeaders(
  env: Env,
  headers: Headers | undefined,
  userId: string,
  flow: string
): Promise<string | null> {
  const result = await getGitLabUserAccessTokenResultWithHeaders(env, headers, userId, flow);
  return result?.accessToken ?? null;
}

export async function getGitLabUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string | null> {
  return getGitLabUserAccessTokenWithHeaders(c.env, c.req.raw.headers, userId, 'request');
}

export async function getGitLabUserAccessTokenForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<string | null> {
  return getGitLabUserAccessTokenWithHeaders(env, undefined, userId, flow);
}

export async function requireGitLabUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string> {
  const accessToken = await getGitLabUserAccessToken(c, userId);
  if (!accessToken) {
    throw new AppError(
      401,
      'GITLAB_REAUTH_REQUIRED',
      'Your GitLab authorization has expired - please sign out and back in'
    );
  }
  return accessToken;
}

export async function requireGitLabUserAccessTokenForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<string> {
  const result = await requireGitLabUserAccessTokenResultForOwner(env, userId, flow);
  return result.accessToken;
}

export async function requireGitLabUserAccessTokenResultForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<GitLabAccessTokenResult> {
  const result = await getGitLabUserAccessTokenResultWithHeaders(env, undefined, userId, flow);
  if (!result) {
    throw new AppError(
      401,
      'GITLAB_REAUTH_REQUIRED',
      'Your GitLab authorization has expired - please sign out and back in'
    );
  }
  return result;
}
