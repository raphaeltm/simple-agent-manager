import { Hono } from 'hono';

import type { Env } from '../../../src/env';

export const createRouteTestApp = (
  routePath: string,
  routes: Hono<{ Bindings: Env }>
) => {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    return typeof appError.statusCode === 'number' && typeof appError.error === 'string'
      ? c.json({ error: appError.error, message: appError.message }, appError.statusCode)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route(routePath, routes);
  return app;
};
