import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

// Set up mocks before importing the route module
const mockGetSession = vi.fn();
const mockCreateSession = vi.fn();
const mockAuth = {
  api: { getSession: mockGetSession },
  $context: Promise.resolve({
    internalAdapter: {
      createSession: mockCreateSession,
    },
  }),
};

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => currentMockDB),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args: any[]) => ({ type: 'eq', args })),
    and: vi.fn((...args: any[]) => ({ type: 'and', args })),
    isNull: vi.fn((...args: any[]) => ({ type: 'isNull', args })),
  };
});

vi.mock('../../../src/auth', () => ({
  createAuth: vi.fn(() => mockAuth),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-123'),
}));

// Mock rate-limit middleware to be a passthrough in tests
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: vi.fn(() => async (_c: any, next: any) => next()),
}));

// Import route after mocks
import { smokeTestTokenRoutes } from '../../../src/routes/smoke-test-tokens';

let currentMockDB: any;

function createMockDB(options: {
  selectGetResults?: any[];
  selectAllResults?: any[][];
  updateChanges?: number;
}) {
  const getQueue = [...(options.selectGetResults || [])];
  const allQueue = [...(options.selectAllResults || [])];
  const changes = options.updateChanges ?? 1;

  return {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.all = vi.fn(() => Promise.resolve(allQueue.shift() || []));
      chain.get = vi.fn(() => Promise.resolve(getQueue.shift() ?? null));
      return chain;
    }),
    insert: vi.fn(() => {
      const chain: any = {};
      chain.values = vi.fn(() => Promise.resolve());
      return chain;
    }),
    update: vi.fn(() => {
      const chain: any = {};
      chain.set = vi.fn(() => chain);
      chain.where = vi.fn(() => Promise.resolve({ meta: { changes } }));
      return chain;
    }),
  };
}

function buildApp(envOverrides: Partial<Env> = {}) {
  const env: Record<string, any> = {
    BASE_DOMAIN: 'test.example.com',
    SMOKE_TEST_AUTH_ENABLED: 'true',
    ENCRYPTION_KEY: 'test-secret-key-for-hmac-signing',
    DATABASE: {} as any,
    ...envOverrides,
  };
  const app = new Hono<{ Bindings: Env }>();
  // Global error handler matching the real app
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as any);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  // Inject env bindings — c.env may be undefined in test context
  app.use('*', async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = { ...(c.env || {}), ...env };
    await next();
  });
  app.route('/api/auth', smokeTestTokenRoutes);
  return app;
}

describe('Smoke Test Token Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Feature Gate', () => {
    it('GET /smoke-test-status returns enabled:true when env var is set', async () => {
      currentMockDB = createMockDB({});
      const app = buildApp({ SMOKE_TEST_AUTH_ENABLED: 'true' });
      const res = await app.request('/api/auth/smoke-test-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
    });

    it('GET /smoke-test-status returns enabled:false when env var is unset', async () => {
      currentMockDB = createMockDB({});
      const app = buildApp({ SMOKE_TEST_AUTH_ENABLED: undefined });
      const res = await app.request('/api/auth/smoke-test-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
    });

    it('GET /smoke-test-tokens returns 404 when feature disabled', async () => {
      currentMockDB = createMockDB({});
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp({ SMOKE_TEST_AUTH_ENABLED: undefined });
      const res = await app.request('/api/auth/smoke-test-tokens');
      expect(res.status).toBe(404);
    });

    it('POST /smoke-test-tokens returns 404 when feature disabled', async () => {
      currentMockDB = createMockDB({});
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp({ SMOKE_TEST_AUTH_ENABLED: undefined });
      const res = await app.request('/api/auth/smoke-test-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      expect(res.status).toBe(404);
    });

    it('POST /token-login returns 404 when feature disabled', async () => {
      currentMockDB = createMockDB({});
      const app = buildApp({ SMOKE_TEST_AUTH_ENABLED: undefined });
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_abc' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Token CRUD', () => {
    it('GET /smoke-test-tokens returns empty list for new user', async () => {
      currentMockDB = createMockDB({ selectAllResults: [[]] });
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('GET /smoke-test-tokens returns 401 when not authenticated', async () => {
      currentMockDB = createMockDB({});
      mockGetSession.mockResolvedValue(null);
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens');
      expect(res.status).toBe(401);
    });

    it('POST /smoke-test-tokens creates token with sam_test_ prefix', async () => {
      currentMockDB = createMockDB({
        selectAllResults: [
          // Active tokens count (empty = under limit)
          [],
        ],
      });
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CI primary user' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token).toMatch(/^sam_test_/);
      expect(body.name).toBe('CI primary user');
      expect(body.id).toBe('test-ulid-123');
    });

    it('POST /smoke-test-tokens rejects empty name', async () => {
      currentMockDB = createMockDB({});
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /smoke-test-tokens rejects name exceeding max length', async () => {
      currentMockDB = createMockDB({});
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const longName = 'a'.repeat(101);
      const res = await app.request('/api/auth/smoke-test-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: longName }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('100 characters');
    });

    it('POST /smoke-test-tokens rejects when at token limit', async () => {
      const tenTokens = Array.from({ length: 10 }, (_, i) => ({ id: `token-${i}` }));
      currentMockDB = createMockDB({
        selectAllResults: [tenTokens],
      });
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'one more' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Maximum of 10');
    });

    it('DELETE /smoke-test-tokens/:id revokes token (updateChanges=1)', async () => {
      currentMockDB = createMockDB({ updateChanges: 1 });
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens/token-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
    });

    it('DELETE /smoke-test-tokens/:id returns 404 for unknown or other-user token', async () => {
      // Single UPDATE with ownership check returns 0 changes for both cases
      currentMockDB = createMockDB({ updateChanges: 0 });
      mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('DELETE /smoke-test-tokens/:id returns 401 when not authenticated', async () => {
      currentMockDB = createMockDB({});
      mockGetSession.mockResolvedValue(null);
      const app = buildApp();
      const res = await app.request('/api/auth/smoke-test-tokens/token-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Token Login', () => {
    it('POST /token-login returns 400 for missing token', async () => {
      currentMockDB = createMockDB({});
      const app = buildApp();
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /token-login returns 401 for invalid prefix', async () => {
      currentMockDB = createMockDB({});
      const app = buildApp();
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid_prefix_abc' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST /token-login returns 401 for unknown token', async () => {
      currentMockDB = createMockDB({
        selectGetResults: [null],
      });
      const app = buildApp();
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_unknown123' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST /token-login returns 401 for revoked token', async () => {
      currentMockDB = createMockDB({
        selectGetResults: [{ id: 'token-1', userId: 'user-1', revokedAt: new Date() }],
      });
      const app = buildApp();
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_validbutrevoked' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST /token-login creates session for valid token', async () => {
      mockCreateSession.mockResolvedValue({
        token: 'ba-session-token-abc',
        id: 'session-id-1',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 86400_000),
      });
      currentMockDB = createMockDB({
        selectGetResults: [
          // token lookup
          { id: 'token-1', userId: 'user-1', revokedAt: null },
          // user lookup (now before session creation for status check)
          { id: 'user-1', email: 'test@example.com', name: 'Test User', status: 'active', role: 'user' },
        ],
      });
      const app = buildApp();
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_validtoken123' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.sessionToken).toBeUndefined();
      expect(body.user.id).toBe('user-1');
      expect(body.user.email).toBe('test@example.com');

      // Verify session cookie format — SameSite=Lax, HttpOnly, Path=/
      const setCookie = res.headers.get('Set-Cookie') || '';
      expect(setCookie).toContain('better-auth.session_token=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');

      // Verify internalAdapter.createSession was called with correct args
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', false);
    });

    it('POST /token-login returns 403 for suspended user', async () => {
      currentMockDB = createMockDB({
        selectGetResults: [
          // token lookup
          { id: 'token-1', userId: 'user-1', revokedAt: null },
          // user lookup — suspended
          { id: 'user-1', email: 'test@example.com', name: 'Test User', status: 'suspended', role: 'user' },
        ],
      });
      const app = buildApp({ REQUIRE_APPROVAL: 'true' });
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_validtoken123' }),
      });
      expect(res.status).toBe(403);
    });

    it('POST /token-login returns 403 for pending user when approval required', async () => {
      currentMockDB = createMockDB({
        selectGetResults: [
          // token lookup
          { id: 'token-1', userId: 'user-1', revokedAt: null },
          // user lookup — pending
          { id: 'user-1', email: 'test@example.com', name: 'Test User', status: 'pending', role: 'user' },
        ],
      });
      const app = buildApp({ REQUIRE_APPROVAL: 'true' });
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_validtoken123' }),
      });
      expect(res.status).toBe(403);
    });

    it('POST /token-login allows admin even when pending approval', async () => {
      mockCreateSession.mockResolvedValue({
        token: 'ba-session-token-admin',
        id: 'session-id-admin',
        userId: 'admin-1',
        expiresAt: new Date(Date.now() + 86400_000),
      });
      currentMockDB = createMockDB({
        selectGetResults: [
          // token lookup
          { id: 'token-1', userId: 'admin-1', revokedAt: null },
          // user lookup — admin with pending status
          { id: 'admin-1', email: 'admin@example.com', name: 'Admin', status: 'pending', role: 'admin' },
        ],
      });
      const app = buildApp({ REQUIRE_APPROVAL: 'true' });
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_admintoken' }),
      });
      expect(res.status).toBe(200);
    });

    it('POST /token-login returns 401 when user not found', async () => {
      currentMockDB = createMockDB({
        selectGetResults: [
          // token lookup succeeds
          { id: 'token-1', userId: 'deleted-user', revokedAt: null },
          // user lookup returns null
          null,
        ],
      });
      const app = buildApp();
      const res = await app.request('/api/auth/token-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sam_test_orphanedtoken' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
