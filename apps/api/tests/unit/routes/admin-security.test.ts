/**
 * Behavioral tests for admin security hardening:
 * - Self-suspension protection (PATCH /api/admin/users/:userId)
 * - Admin health details endpoint (GET /api/admin/health/details)
 *
 * Uses real adminRoutes with mocked auth/DB, following the pattern
 * in admin-observability.test.ts.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// --- Auth mock ---
const SUPERADMIN_USER_ID = 'user-superadmin-123';
const mockGetUserId = vi.fn().mockReturnValue(SUPERADMIN_USER_ID);

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  requireSuperadmin: () => vi.fn((_c: any, next: any) => next()),
  getUserId: (...args: unknown[]) => mockGetUserId(...args),
  getAuth: () => ({
    user: {
      id: SUPERADMIN_USER_ID,
      role: 'superadmin',
      status: 'active',
      email: 'admin@test.com',
      name: 'Admin',
      avatarUrl: null,
    },
    session: { id: 'sess-1', expiresAt: new Date() },
  }),
}));

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
    toJSON() {
      return { error: this.error, message: this.message };
    }
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

// --- DB mock ---
const mockGet = vi.fn();
const mockAll = vi.fn();
const mockUpdate = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: (...args: unknown[]) => mockGet(...args),
          all: (...args: unknown[]) => mockAll(...args),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockUpdate(...args),
      }),
    }),
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
  getRuntimeLimits: () => ({
    maxNodesPerUser: 5,
    maxProjectsPerUser: 10,
  }),
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

describe('Admin security hardening (route-level)', () => {
  let app: Hono<{ Bindings: Env }>;

  function createEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: {} as D1Database,
      KV: {} as KVNamespace,
      PROJECT_DATA: {} as DurableObjectNamespace,
      NODE_LIFECYCLE: {} as DurableObjectNamespace,
      TASK_RUNNER: {} as DurableObjectNamespace,
      ADMIN_LOGS: {} as DurableObjectNamespace,
      NOTIFICATION: {} as DurableObjectNamespace,
      VERSION: '1.0.0-test',
      ...overrides,
    } as Env;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserId.mockReturnValue(SUPERADMIN_USER_ID);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/admin', adminRoutes);
  });

  // =========================================================================
  // Self-suspension protection
  // =========================================================================
  describe('PATCH /api/admin/users/:userId — self-suspension protection', () => {
    it('returns 400 when superadmin tries to modify their own account', async () => {
      const env = createEnv();

      const res = await app.request(
        `/api/admin/users/${SUPERADMIN_USER_ID}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'suspend' }),
        },
        env
      );

      const body = await res.json() as any;
      expect(res.status).toBe(400);
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toBe('Cannot modify your own account');
      // DB should NOT have been called — the guard fires before the lookup
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('does not reject when target userId differs from current user', async () => {
      const env = createEnv();
      // The request targets a different user — the self-modification guard should NOT fire.
      // The route will proceed past the guard and hit the DB lookup.
      // We don't need to fully mock the DB chain for this — we just verify the guard
      // does not throw 400 for a different user.
      const res = await app.request(
        '/api/admin/users/user-other',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'suspend' }),
        },
        env
      );

      // Should NOT be 400 "Cannot modify your own account"
      const body = await res.json() as any;
      expect(body.message).not.toBe('Cannot modify your own account');
      // It may be 500 (DB mock incomplete) or 404 (user not found) — that's fine,
      // the security property we're testing is that the self-mod guard passes.
      expect(res.status).not.toBe(400);
    });
  });

  // =========================================================================
  // Admin health details endpoint
  // =========================================================================
  describe('GET /api/admin/health/details', () => {
    it('returns detailed health info with bindings and limits', async () => {
      const env = createEnv();

      const res = await app.request('/api/admin/health/details', {}, env);

      const body = await res.json() as any;
      expect(res.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.version).toBe('1.0.0-test');
      expect(body.timestamp).toBeDefined();
      // Must include detailed info that the public endpoint does NOT expose
      expect(body.limits).toBeDefined();
      expect(body.limits.maxNodesPerUser).toBe(5);
      expect(body.bindings).toBeDefined();
      expect(body.bindings.DATABASE).toBe(true);
      expect(body.bindings.KV).toBe(true);
      expect(body.bindings.ADMIN_LOGS).toBe(true);
      expect(body.bindings.NOTIFICATION).toBe(true);
      // No missing bindings when all are present
      expect(body.missingBindings).toBeUndefined();
    });

    it('reports degraded status and missing bindings when some are absent', async () => {
      const env = createEnv({ ADMIN_LOGS: undefined as any, NOTIFICATION: undefined as any });

      const res = await app.request('/api/admin/health/details', {}, env);

      const body = await res.json() as any;
      expect(res.status).toBe(200);
      expect(body.status).toBe('degraded');
      expect(body.missingBindings).toContain('ADMIN_LOGS');
      expect(body.missingBindings).toContain('NOTIFICATION');
      expect(body.bindings.ADMIN_LOGS).toBe(false);
      expect(body.bindings.NOTIFICATION).toBe(false);
    });
  });
});
