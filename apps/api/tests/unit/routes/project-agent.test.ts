/**
 * Tests for the project agent chat REST route (apps/api/src/routes/project-agent.ts
 * POST /chat).
 *
 * Covers the jsonValidator migration: a valid body reaches the ProjectAgent DO
 * with the exact payload, a malformed body is rejected with the standard 400
 * shape before the DO is called, and the pre-existing handler-level
 * "Message is required" check (with its non-standard response shape) is
 * preserved for a missing/blank message.
 */
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
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
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));

import { projectAgentRoutes } from '../../../src/routes/project-agent';

const ROUTE_PATH = '/api/projects/:projectId/agent';
const BASE = 'https://api.test.example.com/api/projects/project-1/agent';

function makeEnv(): Env {
  return {
    DATABASE: {} as unknown,
    PROJECT_AGENT: {
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
  app.route(ROUTE_PATH, projectAgentRoutes);
  return app;
}

describe('project agent chat route', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectAccess.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1', userId: 'owner-1' });
    app = makeApp();
  });

  it('forwards a valid chat message to the ProjectAgent DO with the exact payload', async () => {
    mocks.doFetch.mockResolvedValueOnce(
      new Response('data: hello\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const res = await app.request(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conv-1', message: 'Hello agent' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(200);
    expect(mocks.doFetch).toHaveBeenCalledWith(
      'https://project-agent/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          conversationId: 'conv-1',
          message: 'Hello agent',
          userId: 'user-1',
          projectId: 'project-1',
        }),
      })
    );
  });

  it('rejects a malformed body (wrong-type message) with the standard 400 shape before calling the DO', async () => {
    const res = await app.request(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 42 }),
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
        body: JSON.stringify({ conversationId: 'conv-1' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'Message is required' });
    expect(mocks.doFetch).not.toHaveBeenCalled();
  });

  it('preserves the "Message is required" response for a whitespace-only message (tolerating explicit null)', async () => {
    const res = await app.request(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      },
      makeEnv()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'Message is required' });
    expect(mocks.doFetch).not.toHaveBeenCalled();
  });
});
