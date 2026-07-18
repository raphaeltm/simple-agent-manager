import { Hono } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { expectJsonRecord } from '../lib/runtime-validation';
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
    const auth = await createAuth(c.env);
    const response = await auth.handler(c.req.raw);

    // Log auth error metadata only. BetterAuth response bodies may include
    // upstream OAuth data or request-specific values that do not belong in
    // normal Worker logs.
    if (response.status >= 400) {
      log.error('auth.better_auth_error', {
        status: response.status,
        statusText: response.statusText || undefined,
      });
    }
    // Trial claim hook: if this is a successful OAuth callback and the user
    // has an active trial fingerprint cookie, attach a claim cookie + redirect
    // to the trial landing page. No-op when no fingerprint is present.
    return await maybeAttachTrialClaimCookie(c.env, c.req.raw, response);
  } catch (err) {
    log.error('auth.better_auth_exception', serializeError(err));
    return c.json({ error: 'AUTH_ERROR', message: 'Internal auth error' }, 500);
  }
});

/**
 * GET /api/auth/me - Get current authenticated user
 * Returns user profile with GitHub info
 */
authRoutes.get('/me', async (c) => {
  const auth = await createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const user = expectJsonRecord(session.user, 'auth.me.session.user');
  return c.json({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    avatarUrl: session.user.image,
    role: typeof user.role === 'string' ? user.role : 'user',
    status: typeof user.status === 'string' ? user.status : 'active',
    createdAt: session.user.createdAt,
  });
});

export { authRoutes };
