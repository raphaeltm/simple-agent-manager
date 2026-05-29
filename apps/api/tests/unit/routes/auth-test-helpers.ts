import { Hono } from 'hono';
import { vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

export function createMockAuth() {
  const mockGetSession = vi.fn();
  const mockCreateSession = vi.fn();
  const mockAuth = {
    api: { getSession: mockGetSession },
    $context: Promise.resolve({ internalAdapter: { createSession: mockCreateSession } }),
  };
  return { mockGetSession, mockCreateSession, mockAuth };
}

export function buildAuthTestApp(
  routes: Hono<{ Bindings: Env }>,
  routePath: string,
  envOverrides: Record<string, unknown> = {},
) {
  const env: Record<string, unknown> = {
    BASE_DOMAIN: 'test.example.com',
    ENCRYPTION_KEY: 'test-secret-key-for-hmac-signing',
    DATABASE: {},
    KV: {},
    ...envOverrides,
  };
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = { ...(c.env || {}), ...env };
    await next();
  });
  app.route(routePath, routes);
  return app;
}
