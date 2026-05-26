import { type Context } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getTokenType } from './github-route-helpers';

/**
 * Get the current user's GitHub access token from BetterAuth.
 * BetterAuth owns OAuth token encryption/refresh; callers should not read the
 * encrypted accounts table directly.
 */
export async function getGitHubUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string | null> {
  try {
    const auth = createAuth(c.env);
    const token = await auth.api.getAccessToken({
      headers: c.req.raw.headers,
      body: { providerId: 'github', userId },
    });
    log.info('github.user_access_token.lookup', {
      userId,
      tokenPresent: Boolean(token.accessToken),
      tokenType: getTokenType(token),
      scopes: token.scopes,
    });
    return token.accessToken || null;
  } catch (err) {
    log.warn('github.user_access_token_unavailable', {
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
