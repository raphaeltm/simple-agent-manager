import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError, errors } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const authState = vi.hoisted(() => ({
  userId: 'user-1',
  role: 'user',
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  requireSuperadmin: () => async (_c: any, next: any) => {
    if (authState.role !== 'superadmin') {
      throw errors.forbidden('Superadmin access required');
    }
    await next();
  },
  getUserId: () => authState.userId,
}));

const { capacityPoolsRoutes } = await import('../../../src/routes/capacity-pools');
const { adminCapacityPoolsRoutes } = await import('../../../src/routes/admin-capacity-pools');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/capacity-pools', capacityPoolsRoutes);
  app.route('/api/admin/capacity-pools', adminCapacityPoolsRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.credentials,
    schema.platformCredentials,
    schema.capacitySources,
    schema.capacityPools,
    schema.capacityPoolCandidates,
  ]);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1(sqlite),
    } as Env,
  };
}

function seedUser(sqlite: Database.Database, id: string, role = 'user') {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, role, status)
       VALUES (?, ?, ?, 'active')`
    )
    .run(id, `${id}@example.com`, role);
}

function seedCloudCredential(
  sqlite: Database.Database,
  input: { id: string; userId: string; provider?: string; active?: boolean }
) {
  sqlite
    .prepare(
      `INSERT INTO credentials (
        id, user_id, project_id, provider, credential_type, credential_kind,
        is_active, encrypted_token, iv, created_at, updated_at
       )
       VALUES (?, ?, NULL, ?, 'cloud-provider', 'api-key', ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.userId,
      input.provider ?? 'hetzner',
      input.active === false ? 0 : 1,
      `encrypted-token-for-${input.id}`,
      `iv-for-${input.id}`,
      '2026-08-28T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z'
    );
}

function seedPlatformCloudCredential(sqlite: Database.Database, id = 'platform-cloud-1') {
  sqlite
    .prepare(
      `INSERT INTO platform_credentials (
        id, credential_type, provider, agent_type, credential_kind, label,
        encrypted_token, iv, is_enabled, created_by, created_at, updated_at
       )
       VALUES (?, 'cloud-provider', 'hetzner', NULL, 'api-key', 'Platform Hetzner',
        ?, ?, 1, 'superadmin-1', '2026-08-28T00:00:00.000Z',
        '2026-08-28T00:00:00.000Z')`
    )
    .run(id, `platform-encrypted-token-for-${id}`, `platform-iv-for-${id}`);
}

describe('default capacity pool routes', () => {
  beforeEach(() => {
    authState.userId = 'user-1';
    authState.role = 'user';
  });

  it('reconciles the authenticated user default pool from personal cloud credentials', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1', provider: 'scaleway' });

    const res = await createApp().request(
      '/api/capacity-pools/defaults/reconcile',
      {
        method: 'POST',
      },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('encrypted-token-for-user-cloud-1');
    const body = JSON.parse(text);
    expect(body.effectiveScope).toBe('user');
    expect(body.reconciledScopes).toEqual(['user']);
    expect(body.effective.pool).toMatchObject({
      scope: 'user',
      ownerUserId: 'user-1',
    });
    expect(body.effective.sources[0]).toMatchObject({
      credentialSource: 'user',
      credentialReference: 'credentials:user-cloud-1',
    });
    expect(body.defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'user', visibility: 'visible' }),
        expect.objectContaining({ scope: 'installation', visibility: 'hidden' }),
      ])
    );
  });

  it('requires superadmin access for installation default pool metadata', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedPlatformCloudCredential(sqlite);

    const res = await createApp().request('/api/admin/capacity-pools/defaults', {}, env);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
      message: 'Superadmin access required',
    });
  });

  it('reconciles installation defaults from platform cloud credentials for superadmins', async () => {
    authState.userId = 'superadmin-1';
    authState.role = 'superadmin';
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'superadmin-1', 'superadmin');
    seedPlatformCloudCredential(sqlite);

    const res = await createApp().request(
      '/api/admin/capacity-pools/defaults/reconcile',
      {
        method: 'POST',
      },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('platform-encrypted-token-for-platform-cloud-1');
    const body = JSON.parse(text);
    expect(body.effectiveScope).toBe('installation');
    expect(body.reconciledScopes).toEqual(['installation']);
    expect(body.effective.pool).toMatchObject({
      scope: 'installation',
      ownerUserId: null,
      ownerProjectId: null,
    });
    expect(body.effective.sources[0]).toMatchObject({
      credentialSource: 'platform',
      credentialReference: 'platform_credentials:platform-cloud-1',
    });
    expect(body.defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'installation', visibility: 'visible' }),
        expect.objectContaining({ scope: 'project', visibility: 'hidden' }),
        expect.objectContaining({ scope: 'user', visibility: 'hidden' }),
      ])
    );
  });
});
