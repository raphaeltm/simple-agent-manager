import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';

/**
 * Behavioral tests for google-auth routes.
 *
 * Covers: OAuth callback redirect (no handle leak), oauth-result pickup endpoint.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));

const { googleAuthRoutes } = await import('../../../src/routes/google-auth');

// ─── Test Setup ─────────────────────────────────────────────────────────

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/auth/google', googleAuthRoutes);
  return app;
}

const mockKvGet = vi.fn();
const mockKvPut = vi.fn();
const mockKvDelete = vi.fn();

const mockEnv = {
  DATABASE: {} as any,
  KV: { get: mockKvGet, put: mockKvPut, delete: mockKvDelete } as any,
  BASE_DOMAIN: 'example.com',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
} as unknown as Env;

// ─── OAuth callback tests ───────────────────────────────────────────────

describe('GET /auth/google/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('REGRESSION: redirect URL never contains the OAuth handle', async () => {
    // KV state stores userId for verification
    mockKvGet.mockResolvedValue(JSON.stringify({ userId: 'test-user-id' }));

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'gcp-token-123' }), { status: 200 }),
    );

    const app = createTestApp();
    const res = await app.request(
      '/auth/google/callback?code=abc&state=11111111-1111-1111-1111-111111111111',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;

    // Must redirect with only a flag, not the handle
    expect(location).toContain('gcp_setup=ready');

    // No query param value should match a UUID pattern (the handle is a UUID)
    const url = new URL(location);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const [, value] of url.searchParams.entries()) {
      expect(UUID_RE.test(value)).toBe(false);
    }

    // Handle stored server-side for pickup
    expect(mockKvPut).toHaveBeenCalledWith(
      'gcp-oauth-result:test-user-id',
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );

    mockFetch.mockRestore();
  });

  it('redirects with error when user mismatch and preserves state token', async () => {
    mockKvGet.mockResolvedValue(JSON.stringify({ userId: 'different-user' }));

    const app = createTestApp();
    const res = await app.request(
      '/auth/google/callback?code=abc&state=11111111-1111-1111-1111-111111111111',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('gcp_error=');
    expect(location).toContain('user%20mismatch');

    // State token must NOT be deleted — legitimate user can retry
    expect(mockKvDelete).not.toHaveBeenCalled();
  });
});

// ─── OAuth result pickup endpoint ───────────────────────────────────────

describe('GET /auth/google/oauth-result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the handle when a pending result exists', async () => {
    mockKvGet.mockResolvedValue('test-handle-uuid');

    const app = createTestApp();
    const res = await app.request(
      '/auth/google/oauth-result',
      { method: 'GET' },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ handle: 'test-handle-uuid' });

    expect(mockKvGet).toHaveBeenCalledWith('gcp-oauth-result:test-user-id');
    expect(mockKvDelete).toHaveBeenCalledWith('gcp-oauth-result:test-user-id');
  });

  it('returns 404 when no pending result exists', async () => {
    mockKvGet.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request(
      '/auth/google/oauth-result',
      { method: 'GET' },
      mockEnv,
    );
    expect(res.status).toBe(404);
  });
});
