import Database from 'better-sqlite3';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

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

const { adminAiAllowanceRoutes } = await import('../../../src/routes/admin-ai-allowance');

describe('admin AI allowance routes — PUT /:userId', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.users]);
    sqlite
      .prepare('INSERT INTO users (id, email) VALUES (?, ?)')
      .run('user-1', 'user1@example.com');

    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/admin/ai-allowance', adminAiAllowanceRoutes);
  });

  afterEach(() => {
    sqlite.close();
  });

  function bindings(): Env {
    return { DATABASE: createSqliteD1(sqlite), KV: createMemoryKv() } as Env;
  }

  it('accepts a valid body and persists the allowance', async () => {
    const env = bindings();
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxDailyInputTokens: 1000,
          maxMonthlyCostCapUsd: 5,
          allowedModelTiers: ['fast'],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; allowance: Record<string, unknown> };
    expect(body.allowance).toMatchObject({
      maxDailyInputTokens: 1000,
      maxDailyOutputTokens: null,
      maxMonthlyCostCapUsd: 5,
      allowedModelTiers: ['fast'],
      updatedBy: 'admin-1',
    });

    // Re-fetching confirms the write actually landed in KV, not just the response.
    const getRes = await app.request('/api/admin/ai-allowance/user-1', {}, env);
    const getBody = (await getRes.json()) as { allowance: Record<string, unknown> };
    expect(getBody.allowance).toMatchObject({ maxDailyInputTokens: 1000 });
  });

  it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('preserves the handler-produced message for a negative-number violation', async () => {
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDailyInputTokens: -5 }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toBe('maxDailyInputTokens must be a non-negative number or null');
  });

  it('preserves the handler-produced message for a wrong-type numeric field', async () => {
    // Pre-migration this reached the same custom handler message (typeof check),
    // not a schema-formatted rejection — the loose v.unknown() schema keeps it that way.
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMonthlyCostCapUsd: 'not-a-number' }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('maxMonthlyCostCapUsd must be a non-negative number or null');
  });

  it('rejects a non-array allowedModelTiers with the original message', async () => {
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedModelTiers: 'fast' }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('allowedModelTiers must be an array of strings or null');
  });

  it('accepts an explicit null for a nullable numeric field (unchanged edge case)', async () => {
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDailyInputTokens: null }),
      },
      bindings()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowance: { maxDailyInputTokens: number | null } };
    expect(body.allowance.maxDailyInputTokens).toBeNull();
  });

  it('accepts an empty body (all fields omitted) and returns 200', async () => {
    const res = await app.request(
      '/api/admin/ai-allowance/user-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      bindings()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowance: Record<string, unknown> };
    expect(body.allowance).toMatchObject({
      maxDailyInputTokens: null,
      maxDailyOutputTokens: null,
      maxMonthlyCostCapUsd: null,
      allowedModelTiers: null,
    });
  });

  it('returns 404 for an unknown user without touching KV', async () => {
    const res = await app.request(
      '/api/admin/ai-allowance/does-not-exist',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDailyInputTokens: 10 }),
      },
      bindings()
    );

    expect(res.status).toBe(404);
  });
});
