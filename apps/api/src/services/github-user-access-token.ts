import { type Context } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getTokenType } from './github-route-helpers';

async function getGitHubUserAccessTokenWithHeaders(
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
    return token.accessToken || null;
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
