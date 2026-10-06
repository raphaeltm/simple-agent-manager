import { Hono } from 'hono';

import type { Env } from '../../../src/env';

/** Create a worker test app with only browser authentication substituted. */
export function authenticatedTestApp(userId: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: userId,
        email: `${userId}@example.com`,
        name: null,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  return app;
}
