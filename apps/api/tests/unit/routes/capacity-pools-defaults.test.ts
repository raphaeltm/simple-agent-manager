import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError, errors } from '../../../src/middleware/error';
import {
  createSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedPlatformCloudCredential } from './capacity-pool-test-seeds';

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

function createEnv(options: { bindLimit?: number } = {}) {
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
      DATABASE: options.bindLimit
        ? createSqliteD1WithBindLimit(sqlite, options.bindLimit)
        : createSqliteD1(sqlite),
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

type DefaultsVisibilityExpectation = {
  hiddenDefaults: string[];
  visibleDefaults: string[];
};

type DefaultsReconcileExpectation = DefaultsVisibilityExpectation & {
  effectivePool: Record<string, unknown>;
  effectiveScope: string;
  env: Env;
  path: string;
  reconciledScopes: string[];
  secretValue: string;
  source: Record<string, unknown>;
};

async function expectDefaultsReconciled({
  effectivePool,
  effectiveScope,
  env,
  hiddenDefaults,
  path,
  reconciledScopes,
  secretValue,
  source,
  visibleDefaults,
}: DefaultsReconcileExpectation) {
  const res = await createApp().request(path, { method: 'POST' }, env);

  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const text = await res.text();
  expect(text).not.toContain(secretValue);
  const body = JSON.parse(text);
  expect(body.effectiveScope).toBe(effectiveScope);
  expect(body.reconciledScopes).toEqual(reconciledScopes);
  expect(body.effective.pool).toMatchObject(effectivePool);
  expect(body.effective.sources[0]).toMatchObject(source);
  expect(body.defaults).toEqual(
    expect.arrayContaining([
      ...visibleDefaults.map((scope) => expect.objectContaining({ scope, visibility: 'visible' })),
      ...hiddenDefaults.map((scope) => expect.objectContaining({ scope, visibility: 'hidden' })),
    ])
  );
  return body;
}

type DefaultsEnsureExpectation = {
  effectivePool: Record<string, unknown>;
  effectiveScope: string;
  env: Env;
  path: string;
  reconciledScopes: string[];
  source: Record<string, unknown>;
};

async function expectDefaultsEnsured({
  effectivePool,
  effectiveScope,
  env,
  path,
  reconciledScopes,
  source,
}: DefaultsEnsureExpectation) {
  const res = await createApp().request(path, { method: 'GET' }, env);

  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  await expect(res.json()).resolves.toMatchObject({
    effectiveScope,
    reconciledScopes,
    effective: {
      pool: effectivePool,
      sources: [expect.objectContaining(source)],
    },
  });
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

    await expectDefaultsReconciled({
      effectivePool: {
        scope: 'user',
        ownerUserId: 'user-1',
      },
      effectiveScope: 'user',
      env,
      hiddenDefaults: ['installation'],
      path: '/api/capacity-pools/defaults/reconcile',
      reconciledScopes: ['user'],
      secretValue: 'encrypted-token-for-user-cloud-1',
      source: {
        credentialSource: 'user',
        credentialReference: 'credentials:user-cloud-1',
      },
      visibleDefaults: ['user'],
    });
  });

  it('GET ensure=true reconciles user defaults without exceeding D1 bind limits', async () => {
    const { sqlite, env } = createEnv({ bindLimit: 100 });
    seedUser(sqlite, 'user-1');
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1' });

    await expectDefaultsEnsured({
      effectivePool: { scope: 'user', ownerUserId: 'user-1' },
      effectiveScope: 'user',
      env,
      path: '/api/capacity-pools/defaults?ensure=true',
      reconciledScopes: ['user'],
      source: {
        credentialSource: 'user',
        credentialReference: 'credentials:user-cloud-1',
      },
    });
  });

  it('updates the authenticated user default pool policy and candidate status', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1', provider: 'hetzner' });

    const reconcile = await createApp().request(
      '/api/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    const initial = await reconcile.json();
    const ashCandidate = initial.effective.candidates.find(
      (candidate: { location: string; machineSize: string }) =>
        candidate.location === 'ash' && candidate.machineSize === 'large'
    );
    expect(ashCandidate).toBeTruthy();

    const res = await createApp().request(
      '/api/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          policy: { strategy: 'pack', exhaustionPolicy: 'fail' },
          candidates: [{ id: ashCandidate.id, status: 'deleted' }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const text = await res.text();
    expect(text).not.toContain('encrypted-token-for-user-cloud-1');
    const body = JSON.parse(text);
    expect(body.effective.pool).toMatchObject({
      scope: 'user',
      ownerUserId: 'user-1',
      strategy: 'pack',
      exhaustionPolicy: 'fail',
      revision: 2,
    });
    expect(
      body.effective.candidates.find(
        (candidate: { id: string }) => candidate.id === ashCandidate.id
      )
    ).toMatchObject({ status: 'deleted' });

    expect(
      sqlite
        .prepare(`SELECT strategy, exhaustion_policy FROM capacity_pools WHERE scope = 'user'`)
        .get()
    ).toEqual({ strategy: 'pack', exhaustion_policy: 'fail' });
  });

  it('keeps a zero-active user default visible to the editor but not effective', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1', provider: 'vultr' });

    const reconcile = await createApp().request(
      '/api/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(reconcile.status).toBe(200);
    const initial = await reconcile.json();
    expect(initial.effective.candidates.length).toBeGreaterThan(0);

    const res = await createApp().request(
      '/api/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: initial.effective.candidates.map((candidate: { id: string }) => ({
            id: candidate.id,
            status: 'deleted',
          })),
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.effective).toBeNull();
    expect(body.effectiveScope).toBeNull();
    expect(body.defaults.find((item: { scope: string }) => item.scope === 'user')).toMatchObject({
      visibility: 'visible',
      summary: {
        pool: { scope: 'user', status: 'disabled' },
        activeCandidateCount: 0,
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: initial.effective.candidates[0].id, status: 'deleted' }),
        ]),
      },
    });
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

    await expectDefaultsReconciled({
      effectivePool: {
        scope: 'installation',
        ownerUserId: null,
        ownerProjectId: null,
      },
      effectiveScope: 'installation',
      env,
      hiddenDefaults: ['project', 'user'],
      path: '/api/admin/capacity-pools/defaults/reconcile',
      reconciledScopes: ['installation'],
      secretValue: 'platform-encrypted-token-for-platform-cloud-1',
      source: {
        credentialSource: 'platform',
        credentialReference: 'platform_credentials:platform-cloud-1',
      },
      visibleDefaults: ['installation'],
    });
  });

  it('GET ensure=true reconciles installation defaults without exceeding D1 bind limits', async () => {
    authState.userId = 'superadmin-1';
    authState.role = 'superadmin';
    const { sqlite, env } = createEnv({ bindLimit: 100 });
    seedUser(sqlite, 'superadmin-1', 'superadmin');
    seedPlatformCloudCredential(sqlite);

    await expectDefaultsEnsured({
      effectivePool: { scope: 'installation' },
      effectiveScope: 'installation',
      env,
      path: '/api/admin/capacity-pools/defaults?ensure=true',
      reconciledScopes: ['installation'],
      source: {
        credentialSource: 'platform',
        credentialReference: 'platform_credentials:platform-cloud-1',
      },
    });
  });

  it('updates installation defaults only for superadmins', async () => {
    authState.userId = 'superadmin-1';
    authState.role = 'superadmin';
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'superadmin-1', 'superadmin');
    seedPlatformCloudCredential(sqlite);

    const reconcile = await createApp().request(
      '/api/admin/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    const initial = await reconcile.json();
    const hilCandidate = initial.effective.candidates.find(
      (candidate: { location: string; machineSize: string }) =>
        candidate.location === 'hil' && candidate.machineSize === 'small'
    );
    expect(hilCandidate).toBeTruthy();

    const res = await createApp().request(
      '/api/admin/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: [{ id: hilCandidate.id, status: 'disabled' }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.effective.pool.scope).toBe('installation');
    expect(
      body.effective.candidates.find(
        (candidate: { id: string }) => candidate.id === hilCandidate.id
      )
    ).toMatchObject({ status: 'disabled' });

    authState.userId = 'user-1';
    authState.role = 'user';
    seedUser(sqlite, 'user-1');
    const forbidden = await createApp().request(
      '/api/admin/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: [{ id: hilCandidate.id, status: 'active' }],
        }),
      },
      env
    );

    expect(forbidden.status).toBe(403);
  });
});
