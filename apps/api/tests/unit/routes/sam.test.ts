/**
 * Tests for the SAM chat REST route (apps/api/src/routes/sam.ts POST /chat).
 *
 * Covers the jsonValidator migration: a valid body reaches the SamSession DO
 * with the exact payload, a malformed body is rejected with the standard 400
 * shape before the DO is called, and the pre-existing handler-level
 * "Message is required" check (with its non-standard response shape) is
 * preserved for a missing/blank message. This route-level test is distinct
 * from tests/workers/sam-session-do.test.ts, which exercises the SamSession
 * Durable Object directly and bypasses this Hono route entirely.
 */
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  doFetch: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: Context, next: Next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'u@test.dev', name: 'U', role: 'user', status: 'active' },
    });
    await next();
  },
}));

import { samRoutes } from '../../../src/routes/sam';

const BASE = 'https://api.test.example.com/api/sam';

function makeEnv(): Env {
  return {
    SAM_SESSION: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({ fetch: mocks.doFetch }),
    },
  } as unknown as Env;
}

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json(
        { error: appError.error, message: appError.message },
        appError.statusCode as 400
      );
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/sam', samRoutes);
  return app;
}

describe('sam chat route', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  it('forwards a valid chat message to the SamSession DO with the exact payload', async () => {
    mocks.doFetch.mockResolvedValueOnce(
      new Response('data: hi\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const res = await app.request(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conv-1', message: 'Hello SAM' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(200);
    expect(mocks.doFetch).toHaveBeenCalledWith(
      'https://sam-session/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversationId: 'conv-1', message: 'Hello SAM', userId: 'user-1' }),
      })
    );
  });

  it('rejects a malformed body (wrong-type conversationId array with wrong-type message) with the standard 400 shape', async () => {
    const res = await app.request(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { nested: true } }),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(mocks.doFetch).not.toHaveBeenCalled();
  });

  it('preserves the "Message is required" response for a missing message', async () => {
    const res = await app.request(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'Message is required' });
    expect(mocks.doFetch).not.toHaveBeenCalled();
  });
});
