import { Hono } from 'hono';
import { createAuth } from '../auth';
import type { Env } from '../index';
import { errors } from '../middleware/error';

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
      console.error(`BetterAuth ${response.status}: ${body || '(empty body)'}`);
    }
    return response;
  } catch (err) {
    console.error('BetterAuth exception:', err instanceof Error ? err.message : err);
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
