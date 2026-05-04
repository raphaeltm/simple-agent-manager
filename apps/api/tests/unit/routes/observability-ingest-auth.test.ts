/**
 * Regression tests for observability log ingest authentication.
 *
 * Verifies that:
 * 1. Service binding requests (synthetic hostname) succeed
 * 2. External unauthenticated requests are rejected (401)
 * 3. Query and stream routes still require superadmin auth
 *
 * Root cause: the ingest route was previously under adminRoutes which applies
 * blanket superadmin session auth. Service binding requests carry no session
 * cookie, causing 401 on every tail worker log forward.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// --- Auth mock (for adminRoutes superadmin middleware) ---
vi.mock('../../../src/middleware/auth', () => {
  const requireAuth = () => async (c: any, next: any) => {
    // Simulate real auth: check for a session header
    const hasSession = c.req.header('X-Test-Session');
    if (!hasSession) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }
    await next();
  };
  const requireApproved = () => async (_c: any, next: any) => next();
  const requireSuperadmin = () => async (c: any, next: any) => {
    const role = c.req.header('X-Test-Role');
    if (role !== 'superadmin') {
      return c.json({ error: 'FORBIDDEN', message: 'Superadmin required' }, 403);
    }
    await next();
  };
  return {
    requireAuth,
    requireApproved,
    requireSuperadmin,
    getUserId: () => 'user-test',
    getAuth: () => ({
      user: { id: 'user-test', role: 'superadmin', status: 'active', email: 'a@b.com', name: 'Test', avatarUrl: null },
      session: { id: 'sess-1', expiresAt: new Date() },
    }),
  };
});

// --- Error mock ---
vi.mock('../../../src/middleware/error', () => {
  class AppError extends Error {
    statusCode: number;
    error: string;
    constructor(statusCode: number, error: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.error = error;
    }
    toJSON() { return { error: this.error, message: this.message }; }
  }
  return {
    errors: {
      badRequest: (msg: string) => new AppError(400, 'BAD_REQUEST', msg),
      notFound: (entity: string) => new AppError(404, 'NOT_FOUND', `${entity} not found`),
      forbidden: (msg: string) => new AppError(403, 'FORBIDDEN', msg),
    },
    AppError,
  };
});

// --- Drizzle mock ---
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: vi.fn(), all: vi.fn() }) }) }),
    update: () => ({ set: () => ({ where: vi.fn() }) }),
  }),
}));

// --- Rate-limit mock ---
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => vi.fn((_c: any, next: any) => next()),
}));

// --- Observability mock ---
vi.mock('../../../src/services/observability', () => ({
  queryErrors: vi.fn(),
  getHealthSummary: vi.fn(),
  getErrorTrends: vi.fn(),
  queryCloudflareLogs: vi.fn(),
  getLogQueryRateLimit: () => 30,
  CfApiError: class extends Error { constructor(m: string) { super(m); } },
}));

// --- Limits mock ---
vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: () => ({ maxNodesPerUser: 5 }),
}));

// --- Schemas mock ---
vi.mock('../../../src/schemas', () => ({
  AdminUserActionSchema: {},
  AdminUserRoleSchema: {},
  AdminLogQuerySchema: {},
  jsonValidator: () => vi.fn((_c: any, next: any) => next()),
}));

// Import routes after mocks
const { adminRoutes } = await import('../../../src/routes/admin');
const { observabilityIngestRoutes } = await import('../../../src/routes/observability-ingest');

describe('Observability ingest auth regression', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDoFetch: ReturnType<typeof vi.fn>;

  function createEnv(): Env {
    return {
      DATABASE: {} as D1Database,
      KV: {} as KVNamespace,
      PROJECT_DATA: {} as DurableObjectNamespace,
      NODE_LIFECYCLE: {} as DurableObjectNamespace,
      TASK_RUNNER: {} as DurableObjectNamespace,
      ADMIN_LOGS: {
        idFromName: () => ({ toString: () => 'admin-logs-id' }),
        get: () => ({ fetch: mockDoFetch }),
      } as unknown as DurableObjectNamespace,
      NOTIFICATION: {} as DurableObjectNamespace,
      VERSION: '1.0.0-test',
    } as Env;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDoFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    // Mount exactly as in the real app: ingest route before admin routes
    app.route('/api/admin/observability/logs/ingest', observabilityIngestRoutes);
    app.route('/api/admin', adminRoutes);
  });

  // =========================================================================
  // Ingest endpoint — service binding access
  // =========================================================================
  describe('POST /api/admin/observability/logs/ingest', () => {
    it('succeeds when called via service binding (synthetic hostname)', async () => {
      const env = createEnv();

      // Service binding URL uses synthetic hostname without dots
      const res = await app.request(
        'https://internal/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: [{ type: 'log', entry: { level: 'info', message: 'test' } }] }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockDoFetch).toHaveBeenCalledTimes(1);
    });

    it('succeeds with alternative synthetic hostname (no dots)', async () => {
      const env = createEnv();

      const res = await app.request(
        'https://fake-host/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: [] }),
        },
        env,
      );

      expect(res.status).toBe(200);
    });

    it('rejects external requests with real hostname (401)', async () => {
      const env = createEnv();

      const res = await app.request(
        'https://api.simple-agent-manager.org/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: [] }),
        },
        env,
      );

      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('UNAUTHORIZED');
    });

    it('rejects staging hostname (401)', async () => {
      const env = createEnv();

      const res = await app.request(
        'https://api.sammy.party/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: [] }),
        },
        env,
      );

      expect(res.status).toBe(401);
    });

    it('does NOT require session auth headers for service binding calls', async () => {
      const env = createEnv();

      // No X-Test-Session or X-Test-Role headers — service binding doesn't have them
      const res = await app.request(
        'https://internal/api/admin/observability/logs/ingest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: [] }),
        },
        env,
      );

      // Should succeed without any session auth
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // Admin observability routes — superadmin auth preserved
  // =========================================================================
  describe('admin observability routes still require superadmin', () => {
    it('POST /api/admin/observability/logs/query returns 401 without auth', async () => {
      const env = createEnv();

      const res = await app.request(
        'https://api.example.com/api/admin/observability/logs/query',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeRange: { start: '2026-01-01', end: '2026-01-02' } }),
        },
        env,
      );

      expect(res.status).toBe(401);
    });

    it('GET /api/admin/observability/logs/stream returns 401 without auth', async () => {
      const env = createEnv();

      const res = await app.request(
        'https://api.example.com/api/admin/observability/logs/stream',
        { headers: { Upgrade: 'websocket' } },
        env,
      );

      expect(res.status).toBe(401);
    });

    it('POST /api/admin/observability/logs/query returns 403 without superadmin role', async () => {
      const env = createEnv();

      const res = await app.request(
        'https://api.example.com/api/admin/observability/logs/query',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Test-Session': 'true',
            'X-Test-Role': 'user',
          },
          body: JSON.stringify({ timeRange: { start: '2026-01-01', end: '2026-01-02' } }),
        },
        env,
      );

      expect(res.status).toBe(403);
    });
  });
});
