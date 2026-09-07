import { Buffer } from 'node:buffer';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { encrypt } from '../../../src/services/encryption';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { seedUser } from './capacity-pool-test-seeds';

const TEST_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const originalFetch = globalThis.fetch;

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  getUserId: () => 'user-1',
}));

const { capacityPoolsRoutes } = await import('../../../src/routes/capacity-pools');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/capacity-pools', capacityPoolsRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.credentials,
    schema.ccCredentials,
    schema.ccConfigurations,
    schema.ccAttachments,
    schema.platformSettings,
    schema.capacitySources,
    schema.capacityPools,
    schema.capacityPoolCandidates,
  ]);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    } as Env,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('default capacity pool route real provider fallback contract', () => {
  it('does not resurrect static Hetzner candidates when server_types refresh fails', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    const encrypted = await encrypt('live-hetzner-token-canary', TEST_ENCRYPTION_KEY);
    sqlite
      .prepare(
        `INSERT INTO credentials (
          id, user_id, provider, credential_type, credential_kind, is_active,
          encrypted_token, iv, created_at, updated_at
        )
        VALUES (
          'hetzner-api-failure', 'user-1', 'hetzner', 'cloud-provider', 'api-key', 1,
          ?, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
        )`
      )
      .run(encrypted.ciphertext, encrypted.iv);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'server types unavailable' } }), {
        status: 503,
      })
    ) as typeof fetch;

    const res = await createApp().request(
      '/api/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('live-hetzner-token-canary');
    const body = JSON.parse(text);
    expect(body.effectiveSummary).toEqual({
      scope: 'user',
      state: 'configured-empty',
      strategy: 'balanced',
      exhaustionPolicy: 'queue',
      availableCandidateCount: 0,
      reason: 'configured-default-pool-has-no-active-candidates',
    });
    expect(body.effective.candidates).toEqual([]);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM capacity_pool_candidates
           WHERE provider_instance_type = 'cx23'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT status, source_generation
           FROM capacity_sources
           WHERE credential_id = 'hetzner-api-failure'`
        )
        .get()
    ).toEqual({ status: 'active', source_generation: 1 });
    expect(warnSpy.mock.calls.map(([payload]) => String(payload)).join('\n')).toContain(
      'hetzner catalog API unavailable'
    );
  });
});
