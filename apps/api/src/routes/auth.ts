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
 *
 * TODO: Remove DEBUG_AUTH verbose error responses once auth flow is stable
 */
authRoutes.on(['GET', 'POST'], '/*', async (c) => {
  const debugAuth = c.env.DEBUG_AUTH === 'true';

  try {
    const auth = createAuth(c.env);
    const response = await auth.handler(c.req.raw);

    // Log and surface errors from BetterAuth for debugging
    if (response.status >= 400) {
      const body = await response.clone().text();
      console.error(`BetterAuth ${response.status}: ${body || '(empty body)'}`);
      console.error(`Request: ${c.req.method} ${c.req.url}`);

      // In debug mode, surface empty 500s with request context
      if (!body && response.status === 500) {
        const detail = debugAuth
          ? {
              error: 'AUTH_ERROR',
              message: 'BetterAuth returned 500 with no details',
              debug: {
                method: c.req.method,
                url: c.req.url,
                headers: Object.fromEntries(c.req.raw.headers.entries()),
                hint: 'Enable Worker real-time logs (wrangler tail) for onAPIError output',
              },
            }
          : { error: 'AUTH_ERROR', message: 'Internal auth error' };
        return c.json(detail, 500);
      }
    }
    return response;
  } catch (err) {
    // With onAPIError.throw=true, BetterAuth throws instead of returning empty 500s
    console.error('BetterAuth exception:', err instanceof Error ? err.message : err);
    console.error('BetterAuth stack:', err instanceof Error ? err.stack : 'no stack');

    const detail = debugAuth
      ? {
          error: 'AUTH_ERROR',
          message: err instanceof Error ? err.message : 'Unknown auth error',
          stack: err instanceof Error ? err.stack : undefined,
          name: err instanceof Error ? err.name : undefined,
        }
      : { error: 'AUTH_ERROR', message: 'Internal auth error' };

    return c.json(detail, 500);
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
