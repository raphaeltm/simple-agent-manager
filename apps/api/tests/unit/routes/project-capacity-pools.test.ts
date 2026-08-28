import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const authState = vi.hoisted(() => ({
  userId: 'user-1',
  role: 'user',
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  getUserId: () => authState.userId,
  getAuth: () => ({
    user: {
      id: authState.userId,
      email: `${authState.userId}@example.com`,
      name: authState.userId,
      avatarUrl: null,
      role: authState.role,
      status: 'active',
    },
    session: { id: 'session-1', token: null, expiresAt: new Date() },
  }),
}));

const { capacityPoolRoutes } = await import('../../../src/routes/projects/capacity-pools');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', capacityPoolRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectMembers,
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

function seedProjectMember(
  sqlite: Database.Database,
  input: { projectId: string; userId: string; role: string }
) {
  sqlite
    .prepare(
      `INSERT INTO projects (
        id, user_id, name, normalized_name, installation_id, repository,
        default_branch, status, created_by
       )
       VALUES (?, ?, 'Capacity Project', 'capacity-project', 'installation-1',
        'acme/capacity-project', 'main', 'active', ?)`
    )
    .run(input.projectId, input.userId, input.userId);
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status)
       VALUES (?, ?, ?, 'active')`
    )
    .run(input.projectId, input.userId, input.role);
}

function seedCloudCredential(
  sqlite: Database.Database,
  input: {
    id: string;
    userId: string;
    projectId?: string | null;
    provider?: string;
    active?: boolean;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO credentials (
        id, user_id, project_id, provider, credential_type, credential_kind,
        is_active, encrypted_token, iv, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'cloud-provider', 'api-key', ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.userId,
      input.projectId ?? null,
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

describe('project capacity pool routes', () => {
  beforeEach(() => {
    authState.userId = 'user-1';
    authState.role = 'user';
  });

  it('returns the project default as effective and hides installation details for non-superadmins', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedUser(sqlite, 'superadmin-1', 'superadmin');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'maintainer' });
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });
    seedPlatformCloudCredential(sqlite);

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('encrypted-token-for-project-cloud-1');
    expect(text).not.toContain('iv-for-project-cloud-1');
    expect(text).not.toContain('platform-encrypted-token-for-platform-cloud-1');

    const body = JSON.parse(text);
    expect(body.effectiveScope).toBe('project');
    expect(body.effective.pool).toMatchObject({
      scope: 'project',
      ownerProjectId: 'project-1',
      strategy: 'balanced',
      exhaustionPolicy: 'queue',
    });
    expect(body.effective.sources[0]).toMatchObject({
      credentialSource: 'project',
      credentialReference: 'credentials:project-cloud-1',
    });
    expect(body.effective.candidates[0]).toMatchObject({
      provider: 'hetzner',
      workloadRole: 'workspace',
      runtime: 'vm',
      machineClass: 'shared-vm',
      status: 'active',
    });
    expect(body.effective.activeCandidateCount).toBeGreaterThan(0);
    expect(body.defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'project', visibility: 'visible' }),
        expect.objectContaining({ scope: 'user', visibility: 'visible' }),
        expect.objectContaining({
          scope: 'installation',
          visibility: 'hidden',
          summary: null,
        }),
      ])
    );

    const installationPoolCount = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM capacity_pools WHERE scope = 'installation'`)
      .get() as { count: number };
    expect(installationPoolCount.count).toBe(0);
  });

  it('exposes installation defaults to superadmins with project access', async () => {
    authState.userId = 'superadmin-1';
    authState.role = 'superadmin';
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'superadmin-1', 'superadmin');
    seedProjectMember(sqlite, {
      projectId: 'project-1',
      userId: 'superadmin-1',
      role: 'owner',
    });
    seedPlatformCloudCredential(sqlite);

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('platform-encrypted-token-for-platform-cloud-1');
    expect(text).not.toContain('platform-iv-for-platform-cloud-1');

    const body = JSON.parse(text);
    expect(body.effectiveScope).toBe('installation');
    expect(body.effective.pool).toMatchObject({
      scope: 'installation',
      strategy: 'balanced',
      exhaustionPolicy: 'queue',
    });
    expect(body.effective.sources[0]).toMatchObject({
      credentialSource: 'platform',
      credentialReference: 'platform_credentials:platform-cloud-1',
    });
    expect(body.defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'installation',
          visibility: 'visible',
          summary: expect.any(Object),
        }),
      ])
    );
  });

  it('uses the user default when no active project default exists', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1', provider: 'scaleway' });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      effectiveScope: 'user',
      effective: {
        pool: {
          scope: 'user',
          ownerUserId: 'user-1',
        },
        sources: [
          expect.objectContaining({
            credentialSource: 'user',
            credentialReference: 'credentials:user-cloud-1',
          }),
        ],
      },
    });
  });

  it('requires project secret-read capability', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'viewer' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
    });
  });

  it('reconciles idempotently through the explicit POST path', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });

    const first = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    const second = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      effectiveScope: 'project',
      reconciledScopes: ['project', 'user'],
    });

    const poolCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM capacity_pools`).get() as {
      count: number;
    };
    const candidateCount = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM capacity_pool_candidates`)
      .get() as { count: number };
    expect(poolCount.count).toBe(1);
    expect(candidateCount.count).toBeGreaterThan(0);
  });

  it('supports read-only inspection with ensure=false', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=false',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      effective: null,
      effectiveScope: null,
      reconciledScopes: [],
    });

    const poolCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM capacity_pools`).get() as {
      count: number;
    };
    expect(poolCount.count).toBe(0);
  });

  it('is read-only by default: GET without ensure does not reconcile', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      effectiveScope: null,
      reconciledScopes: [],
    });

    const poolCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM capacity_pools`).get() as {
      count: number;
    };
    expect(poolCount.count).toBe(0);
  });

  it('sets Cache-Control: private, no-store on identity-varying GET responses', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
