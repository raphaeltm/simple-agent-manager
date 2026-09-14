import { Hono } from 'hono';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { projectEventChannelRoutes } from '../../../src/routes/project-event-channels';

/** Substitute browser authentication only; route authorization and storage stay real. */
export function channelBrowserRequest(env: Env, projectId: string, userId: string, suffix = '') {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: userId,
        email: `${userId}@test.com`,
        name: null,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toJSON(), error.statusCode as 400);
    throw error;
  });
  app.route('/api/projects/:projectId/event-channels', projectEventChannelRoutes);
  return app.request(`https://api.test/api/projects/${projectId}/event-channels${suffix}`, {}, env);
}
