import Database from 'better-sqlite3';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../../src/middleware/auth')>(
    '../../../src/middleware/auth'
  );
  return {
    ...actual,
    requireAuth: () => async (c: Context, next: Next) => {
      c.set('auth', {
        user: {
          id: 'admin-1',
          email: 'admin@example.com',
          name: 'Admin',
          avatarUrl: null,
          role: 'superadmin',
          status: 'active',
        },
        session: { id: 'session-1', expiresAt: new Date('2099-01-01T00:00:00.000Z') },
      });
      await next();
    },
    requireApproved: () => async (_c: Context, next: Next) => next(),
    requireSuperadmin: () => async (_c: Context, next: Next) => next(),
  };
});

const { adminQuotaRoutes } = await import('../../../src/routes/admin-quotas');

describe('admin quota routes', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // Handler service calls (resolveUserQuota, checkQuotaForUser -> node usage)
    // touch several incidental tables — materialize the whole schema so this
    // test tracks real WHERE-clause behavior without re-enumerating every table.
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare('INSERT INTO users (id, email) VALUES (?, ?)')
      .run('user-1', 'user1@example.com');

    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/admin/quotas', adminQuotaRoutes);
  });

  afterEach(() => {
    sqlite.close();
  });

  function bindings(): Env {
    return { DATABASE: createSqliteD1(sqlite) } as Env;
  }

  describe('PUT /default', () => {
    it('accepts a valid non-negative number', async () => {
      const res = await app.request(
        '/api/admin/quotas/default',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: 100 }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { monthlyVcpuHoursLimit: number | null };
      expect(body.monthlyVcpuHoursLimit).toBe(100);
    });

    it('accepts an explicit null (unlimited, unchanged edge case)', async () => {
      const res = await app.request(
        '/api/admin/quotas/default',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: null }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { monthlyVcpuHoursLimit: number | null };
      expect(body.monthlyVcpuHoursLimit).toBeNull();
    });

    it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
      const res = await app.request(
        '/api/admin/quotas/default',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
    });

    it('preserves the handler-produced message for a negative number', async () => {
      const res = await app.request(
        '/api/admin/quotas/default',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: -10 }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('monthlyVcpuHoursLimit must be a non-negative number or null');
    });

    it('preserves the handler-produced message for a wrong-type value', async () => {
      const res = await app.request(
        '/api/admin/quotas/default',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: 'unlimited' }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('monthlyVcpuHoursLimit must be a non-negative number or null');
    });

    it('preserves the handler-produced message when the field is missing entirely', async () => {
      const res = await app.request(
        '/api/admin/quotas/default',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('monthlyVcpuHoursLimit must be a non-negative number or null');
    });
  });

  describe('PUT /users/:userId', () => {
    it('accepts a valid non-negative number and returns the resolved quota', async () => {
      const res = await app.request(
        '/api/admin/quotas/users/user-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: 50 }),
        },
        bindings()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { monthlyVcpuHoursLimit: number | null; source: string };
      expect(body.monthlyVcpuHoursLimit).toBe(50);
      expect(body.source).toBe('user_override');
    });

    it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
      const res = await app.request(
        '/api/admin/quotas/users/user-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('BAD_REQUEST');
    });

    it('preserves the handler-produced message for a negative number', async () => {
      const res = await app.request(
        '/api/admin/quotas/users/user-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: -1 }),
        },
        bindings()
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe('monthlyVcpuHoursLimit must be a non-negative number or null');
    });

    it('returns 404 for an unknown user before validating the body', async () => {
      const res = await app.request(
        '/api/admin/quotas/users/does-not-exist',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyVcpuHoursLimit: -1 }),
        },
        bindings()
      );

      // User lookup happens before body validation in the handler — a bogus
      // negative value for a nonexistent user still surfaces as 404, not 400.
      expect(res.status).toBe(404);
    });
  });
});
