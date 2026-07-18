import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authHandler: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../../src/auth', () => ({
  createAuth: vi.fn(async () => ({ handler: mocks.authHandler })),
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
import { authRoutes } from '../../../src/routes/auth';

describe('auth route logging', () => {
  beforeEach(() => {
    mocks.authHandler.mockReset();
    mocks.logError.mockReset();
  });

  it('logs BetterAuth error metadata without raw response bodies', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/auth', authRoutes);
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
});
