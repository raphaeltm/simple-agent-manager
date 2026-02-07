import { Hono } from 'hono';
import { createAuth } from '../auth';
import type { Env } from '../index';
import { errors } from '../middleware/error';

const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * BetterAuth handler - handles all auth routes:
 * - GET /api/auth/signin/github - Start GitHub OAuth
 * - GET /api/auth/callback/github - GitHub OAuth callback
 * - POST /api/auth/signout - Sign out
 * - GET /api/auth/session - Get current session
 */
authRoutes.on(['GET', 'POST'], '/*', async (c) => {
  try {
    const auth = createAuth(c.env);
    const response = await auth.handler(c.req.raw);

    // Log errors from BetterAuth for debugging
    if (response.status >= 400) {
      const body = await response.clone().text();
      console.error(`BetterAuth ${response.status}: ${body || '(empty body)'}`);
      console.error(`Request: ${c.req.method} ${c.req.url}`);
      // Return error body for debugging (BetterAuth sometimes returns empty 500s)
      if (!body && response.status === 500) {
        return c.json({ error: 'AUTH_ERROR', message: 'BetterAuth returned 500 with no details. Check Worker logs.' }, 500);
      }
    }
    return response;
  } catch (err) {
    console.error('BetterAuth exception:', err instanceof Error ? err.message : err);
    console.error('BetterAuth stack:', err instanceof Error ? err.stack : 'no stack');
    return c.json({ error: 'AUTH_ERROR', message: err instanceof Error ? err.message : 'Unknown auth error' }, 500);
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

  return c.json({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    avatarUrl: session.user.image,
    createdAt: session.user.createdAt,
  });
});

export { authRoutes };
