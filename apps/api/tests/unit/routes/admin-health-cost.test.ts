/**
 * GET /api/admin/health-cost through the real route, the real `installationHealth` operation, the
 * real worker ports and a real SQL engine. Only the session middleware is stubbed (by role
 * header), so the operation's own superadmin check is exercised behind it.
 *
 * Also pins the I/O budget (`.claude/rules/60`, aggregation class: 15 round trips) by counting
 * every D1 statement the operation issues, with the lifecycle port running for real.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const auth = vi.hoisted(() => ({ userId: 'admin' }));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-test-role') === 'user') return c.json({ error: 'FORBIDDEN' }, 403);
    return next();
  },
  getUserId: () => auth.userId,
}));

const { adminHealthCostRoutes } = await import('../../../src/routes/admin-health-cost');

/** I/O budget for an aggregation endpoint (`.claude/rules/60`). */
const ROUND_TRIP_BUDGET = 15;
/** Session lookup, its second read and the signup-approval check in `requireAuth` (stubbed here). */
const MIDDLEWARE_ROUND_TRIPS = 3;

describe('GET /api/admin/health-cost', () => {
  let sqlite: Database.Database;
  let env: Env;
  let statements: string[];

  function app() {
    const hono = new Hono<{ Bindings: Env }>();
    hono.onError(handleAppError);
    hono.route('/api/admin/health-cost', adminHealthCostRoutes);
    return hono;
  }

  beforeEach(() => {
    auth.userId = 'admin';
    statements = [];
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users (id, name, email, role, status) VALUES
        ('admin', 'Admin', 'a@example.com', 'superadmin', 'active'),
        ('member', 'Member', 'm@example.com', 'user', 'active');
      INSERT INTO nodes (id, user_id, name, status, runtime, node_class, node_role, credential_source,
        cloud_provider, provider_instance_price_hourly_micros, provider_instance_price_currency, created_at, updated_at)
      VALUES ('n1', 'admin', 'n1', 'running', 'vm', 'managed', 'workspace', 'platform', 'hetzner', 10000, 'USD',
        '2026-11-01T00:00:00.000Z', '2026-11-16T11:00:00.000Z');
      INSERT INTO workspaces (id, node_id, project_id, user_id, name, status, created_at, updated_at)
      VALUES ('w1', 'n1', 'p', 'admin', 'w1', 'running', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
    `);
    const db = createSqliteD1(sqlite);
    const prepare = db.prepare.bind(db);
    db.prepare = (query: string) => {
      statements.push(query);
      return prepare(query);
    };
    env = { DATABASE: db, BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('serves a superadmin within the round-trip budget', async () => {
    const res = await app().request('/api/admin/health-cost?range=30d', {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: { range: string };
      compute: { totalUsd: number; byProvider: { provider: string }[] };
      latency: { states: unknown[] };
      unavailable: string[];
    };
    expect(body.window.range).toBe('30d');
    expect(body.compute.byProvider[0]?.provider).toBe('hetzner');
    expect(body.latency.states).toHaveLength(11); // the real lifecycle port ran
    expect(body.unavailable).toEqual([]);
    expect(statements.length + MIDDLEWARE_ROUND_TRIPS).toBeLessThanOrEqual(ROUND_TRIP_BUDGET);
  });

  it('refuses a caller the route middleware does not treat as superadmin', async () => {
    const res = await app().request(
      '/api/admin/health-cost',
      { headers: { 'x-test-role': 'user' } },
      env
    );
    expect(res.status).toBe(403);
    expect(statements).toEqual([]);
  });

  it('refuses a non-superadmin even when the route middleware lets it through', async () => {
    auth.userId = 'member';
    const res = await app().request('/api/admin/health-cost', {}, env);

    expect(res.status).toBe(403);
    // Only the superadmin check ran: no installation data was read.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("role = 'superadmin'");
  });

  it('rejects an unknown range before reading anything', async () => {
    const res = await app().request('/api/admin/health-cost?range=1y', {}, env);
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });
});
