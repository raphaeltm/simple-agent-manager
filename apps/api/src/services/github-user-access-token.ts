import { type Context } from 'hono';
import * as v from 'valibot';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { getTokenType } from './github-route-helpers';

const lockedTokenResponseSchema = v.object({
  accessToken: v.nullable(v.string()),
  accessTokenExpiresAt: v.nullable(v.string()),
  scopes: v.optional(v.array(v.string())),
});

type GitHubAccessTokenResult = {
  accessToken: string | null | undefined;
  accessTokenExpiresAt?: Date | string | null;
  scopes?: string[];
};

function isExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function availableAccessToken(
  token: GitHubAccessTokenResult,
  flow: string,
  userId: string
): string | null {
  if (!token.accessToken) {
    return null;
  }
  if (isExpired(token.accessTokenExpiresAt)) {
    log.warn('github.user_access_token_expired', {
      flow,
      userId,
      tokenPresent: true,
      accessTokenExpiresAt: token.accessTokenExpiresAt
        ? new Date(token.accessTokenExpiresAt).toISOString()
        : null,
    });
    return null;
  }
  return token.accessToken;
}

async function getDirectGitHubUserAccessTokenWithHeaders(
  env: Env,
  headers: Headers,
  userId: string,
  flow: string
): Promise<string | null> {
  try {
    const auth = createAuth(env);
    const token = await auth.api.getAccessToken({
      headers,
      body: { providerId: 'github', userId },
    });
    log.info('github.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      tokenType: getTokenType(token),
      scopes: token.scopes,
    });
    return availableAccessToken(token, flow, userId);
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
  headers: Headers,
  userId: string,
  flow: string
): Promise<string | null> {
  if (!env.GITHUB_USER_ACCESS_TOKEN_LOCK) {
    return getDirectGitHubUserAccessTokenWithHeaders(env, headers, userId, flow);
  }

  try {
    const id = env.GITHUB_USER_ACCESS_TOKEN_LOCK.idFromName(userId);
    const stub = env.GITHUB_USER_ACCESS_TOKEN_LOCK.get(id);
    const response = await stub.fetch('https://github-user-access-token-lock/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        flow,
        headers: Array.from(headers.entries()),
      }),
    });

    if (!response.ok) {
      log.warn('github.user_access_token_unavailable', {
        flow,
        userId,
        tokenPresent: false,
        status: response.status,
      });
      return null;
    }

    const token = await readResponseJson(response, lockedTokenResponseSchema, 'github.user_access_token.locked');
    log.info('github.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      tokenType: getTokenType(token),
      scopes: token.scopes,
    });
    return availableAccessToken(token, flow, userId);
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
 * cookies. BetterAuth still owns OAuth token refresh/decryption; the empty
 * headers simply make this an owner-id lookup instead of a session lookup.
 */
export async function getGitHubUserAccessTokenForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<string | null> {
  return getGitHubUserAccessTokenWithHeaders(env, new Headers(), userId, flow);
}
