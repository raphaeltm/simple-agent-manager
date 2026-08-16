import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authHandler: vi.fn(),
  getSession: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../../src/auth', () => ({
  createAuth: vi.fn(async () => ({
    api: { getSession: mocks.getSession },
    handler: mocks.authHandler,
  })),
}));

vi.mock('../../../src/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/logger')>();
  return {
    ...actual,
    log: {
      ...actual.log,
      error: mocks.logError,
    },
  };
});

vi.mock('../../../src/services/trial/oauth-hook', () => ({
  maybeAttachTrialClaimCookie: vi.fn(async (_env, _request, response) => response),
}));

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { authRoutes } from '../../../src/routes/auth';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/auth', authRoutes);
  return app;
}

describe('auth route logging', () => {
  beforeEach(() => {
    mocks.authHandler.mockReset();
    mocks.getSession.mockReset();
    mocks.logError.mockReset();
  });

  it('logs BetterAuth error metadata without raw response bodies', async () => {
    const app = buildApp();
    mocks.authHandler.mockResolvedValue(
      new Response(JSON.stringify({ token: 'sam_secret_token', cookie: 'session=secret' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await app.request('/api/auth/sign-in/social', { method: 'POST' }, {} as Env);

    expect(res.status).toBe(400);
    expect(mocks.logError).toHaveBeenCalledWith('auth.better_auth_error', {
      status: 400,
      statusText: 'Bad Request',
    });
    const logged = JSON.stringify(mocks.logError.mock.calls);
    expect(logged).not.toContain('sam_secret_token');
    expect(logged).not.toContain('session=secret');
    expect(logged).not.toContain('body');
  });

  it('/me rejects suspended users using a database-backed session read', async () => {
    const app = buildApp();
    mocks.getSession.mockResolvedValue({
      user: {
        id: 'user-suspended',
        email: 'suspended@example.com',
        name: 'Suspended User',
        status: 'suspended',
        role: 'admin',
      },
      session: { id: 'session-1', expiresAt: new Date('2030-01-01T00:00:00Z') },
    });

    const res = await app.request('/api/auth/me', { method: 'GET' }, {} as Env);

    expect(res.status).toBe(403);
    expect(mocks.getSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true } })
    );
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });
});
