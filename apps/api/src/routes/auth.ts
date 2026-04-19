import { Hono } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { maybeAttachTrialClaimCookie } from '../services/trial/oauth-hook';

const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * BetterAuth handler - handles all auth routes:
 * - GET /api/auth/sign-in/social - Start GitHub OAuth
 * - GET /api/auth/callback/github - GitHub OAuth callback
 * - POST /api/auth/sign-out - Sign out
 * - GET /api/auth/session - Get current session
 */
authRoutes.on(['GET', 'POST'], '/*', async (c) => {
  try {
    const auth = createAuth(c.env);
    const response = await auth.handler(c.req.raw);

    // Log auth errors to Worker logs for debugging
    if (response.status >= 400) {
      const body = await response.clone().text();
      log.error('auth.better_auth_error', { status: response.status, body: body || '(empty body)' });
    }
    // Trial claim hook: if this is a successful OAuth callback and the user
    // has an active trial fingerprint cookie, attach a claim cookie + redirect
    // to the trial landing page. No-op when no fingerprint is present.
    return await maybeAttachTrialClaimCookie(c.env, c.req.raw, response);
  } catch (err) {
    log.error('auth.better_auth_exception', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: 'AUTH_ERROR', message: 'Internal auth error' }, 500);
  }
});

/**
 * GET /api/auth/me - Get current authenticated user
 * Returns user profile with GitHub info
 */
authRoutes.get('/me', async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const user = session.user as Record<string, unknown>;
  return c.json({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    avatarUrl: session.user.image,
    role: (user.role as string) ?? 'user',
    status: (user.status as string) ?? 'active',
    createdAt: session.user.createdAt,
  });
});

export { authRoutes };
