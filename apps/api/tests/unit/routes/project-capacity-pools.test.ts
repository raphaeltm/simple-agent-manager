import type { CredentialProvider } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import {
  createSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedPlatformCloudCredential,
  seedProjectWithMember as seedProjectMember,
  seedUser,
} from './capacity-pool-test-seeds';

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

vi.mock('../../../src/services/provider-catalogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/provider-catalogs')>();

  return {
    ...actual,
    buildProviderCatalogForCredential: vi.fn(
      async (input: { seed: { provider: CredentialProvider } }) => ({
        offerings: actual.getStaticProviderCatalogOfferings(input.seed.provider),
        refreshStatus: {
          succeeded: true,
          origin: 'static',
          complete: false,
          reason: 'static-catalog',
        },
      })
    ),
  };
});

const { drizzle } = await import('drizzle-orm/d1');
const { capacityPoolRoutes } = await import('../../../src/routes/projects/capacity-pools');
const { readDefaultCapacityPoolSummaries } =
  await import('../../../src/services/default-capacity-pools');
const providerCatalogs = await import('../../../src/services/provider-catalogs');

const CATALOG_ADDITION_BIND_LIMIT_TEST_TIMEOUT_MS = 15_000;

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

function createEnv(options: { bindLimit?: number } = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectMembers,
    schema.credentials,
    schema.platformCredentials,
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
      DATABASE: options.bindLimit
        ? createSqliteD1WithBindLimit(sqlite, options.bindLimit)
        : createSqliteD1(sqlite),
    } as Env,
  };
}

function seedProjectCredentialFixture(
  sqlite: Database.Database,
  options: {
    userId?: string;
    memberRole?: string;
    credentialId?: string;
    provider?: string;
    projectId?: string;
  } = {}
) {
  const userId = options.userId ?? 'user-1';
  const projectId = options.projectId ?? 'project-1';
  seedUser(sqlite, userId);
  seedProjectMember(sqlite, { projectId, userId, role: options.memberRole ?? 'owner' });
  seedCloudCredential(sqlite, {
    id: options.credentialId ?? 'project-cloud-1',
    userId,
    projectId,
    provider: options.provider ?? 'hetzner',
  });
}

function requestProjectDefaults(
  env: Env,
  pathSuffix = '/capacity-pools/defaults/reconcile',
  init: RequestInit = { method: 'POST' }
) {
  return createApp().request(`/api/projects/project-1${pathSuffix}`, init, env);
}

function expectSafePlacementSettings(body: Record<string, any>) {
  expect(body.placementSettings).toMatchObject({
    version: 1,
    legacyWorkloadAdapterVersion: 1,
    source: {
      legacyWorkloadMapping: 'default',
      platformDefaults: 'default',
      selection: 'default',
    },
    resourceDefaults: {
      legacyWorkloadMapping: {
        small: {
          minVcpu: 1,
          minMemoryGb: 2,
          minDiskGb: 20,
          exclusiveNode: false,
          maxCoTenants: 4,
        },
      },
      platformDefaults: {
        minVcpu: 2,
        minMemoryGb: 4,
        minDiskGb: 40,
        exclusiveNode: false,
        maxCoTenants: 4,
      },
    },
  });
  expect(body.placementSettings.sourceGeneration).toEqual(expect.any(Number));
  expect(body.placementSettings).not.toHaveProperty('diagnostics');
}

function countRows(sqlite: Database.Database, tableName: string, whereSql: string) {
  return (
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereSql}`).get() as {
      count: number;
    }
  ).count;
}

function catalogCredentialSources() {
  return vi
    .mocked(providerCatalogs.buildProviderCatalogForCredential)
    .mock.calls.map((call) => call[0].seed.credentialSource);
}

async function reconcileExistingDefaults(
  env: Env,
  input: {
    userId?: string;
    projectId?: string;
    includeInstallation?: boolean;
  } = {}
) {
  await readDefaultCapacityPoolSummaries(drizzle(env.DATABASE, { schema }), {
    userId: input.userId ?? 'user-1',
    projectId: input.projectId ?? 'project-1',
    includeInstallation: input.includeInstallation ?? false,
    ensure: true,
    includeDisabled: true,
    env,
  });
}

describe('project capacity pool routes', () => {
  beforeEach(() => {
    authState.userId = 'user-1';
    authState.role = 'user';
    vi.mocked(providerCatalogs.buildProviderCatalogForCredential).mockClear();
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
    expectSafePlacementSettings(body);
    expect(body.policyMutationSupported).toBe(false);
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
    expect(catalogCredentialSources()).toEqual(['user', 'project']);
  });

  it('does not reconcile installation defaults for non-superadmin project ensure or reconcile calls', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, {
      projectId: 'project-1',
      userId: 'user-1',
      role: 'maintainer',
    });
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });
    seedPlatformCloudCredential(sqlite, 'platform-cloud-canary');

    const ensured = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );
    expect(ensured.status).toBe(200);
    const ensuredBody = await ensured.json();
    expect(ensuredBody).toMatchObject({
      effectiveScope: 'project',
      reconciledScopes: ['project', 'user'],
      defaults: expect.arrayContaining([
        expect.objectContaining({
          scope: 'installation',
          visibility: 'hidden',
          canReconcile: false,
          summary: null,
        }),
      ]),
    });
    expectSafePlacementSettings(ensuredBody);

    const reconciled = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(reconciled.status).toBe(200);
    const reconciledBody = await reconciled.json();
    expect(reconciledBody).toMatchObject({
      effectiveScope: 'project',
      reconciledScopes: ['project', 'user'],
      policyMutationSupported: false,
    });

    expect(catalogCredentialSources()).toEqual(['user', 'project', 'user', 'project']);
    expect(countRows(sqlite, 'capacity_pools', "scope = 'installation'")).toBe(0);
    expect(countRows(sqlite, 'capacity_sources', "scope = 'installation'")).toBe(0);
  });

  it('GET ensure=true reconciles project defaults without exceeding D1 bind limits', async () => {
    const { sqlite, env } = createEnv({ bindLimit: 100 });
    seedProjectCredentialFixture(sqlite);

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      effectiveScope: 'project',
      reconciledScopes: ['project', 'user'],
      effective: {
        pool: { scope: 'project', ownerProjectId: 'project-1' },
        sources: [
          expect.objectContaining({
            credentialSource: 'project',
            credentialReference: 'credentials:project-cloud-1',
          }),
        ],
      },
    });
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

  it('keeps a zero-active project default editable while falling back to the user pool', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1', provider: 'vultr' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
      provider: 'hetzner',
    });

    const reconcile = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(reconcile.status).toBe(200);
    const initial = await reconcile.json();
    expect(initial.effectiveScope).toBe('project');
    const projectDefault = initial.defaults.find(
      (item: { scope: string }) => item.scope === 'project'
    )?.summary;
    if (!projectDefault) throw new Error('Expected project default summary');
    expect(projectDefault?.candidates.length).toBeGreaterThan(0);

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: projectDefault.candidates.map((candidate: { id: string }) => ({
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
    expect(body.effectiveScope).toBe('project');
    expect(body.effectiveState).toBe('configured-empty');
    expect(body.effective.pool).toMatchObject({ scope: 'project', status: 'active' });
    expect(body.defaults.find((item: { scope: string }) => item.scope === 'project')).toMatchObject(
      {
        visibility: 'visible',
        summary: {
          pool: { scope: 'project', status: 'active', configurationState: 'configured-empty' },
          effectiveState: 'configured-empty',
          activeCandidateCount: 0,
          candidates: expect.arrayContaining([
            expect.objectContaining({ id: projectDefault.candidates[0].id, status: 'deleted' }),
          ]),
        },
      }
    );
  });

  it('lets project readers see only the safe effective summary without secret-read', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'viewer' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });
    await reconcileExistingDefaults(env);

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('project-cloud-1');
    expect(text).not.toContain('encrypted-token-for-project-cloud-1');
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      effective: null,
      effectiveScope: null,
      effectiveSummary: {
        scope: 'project',
        state: 'configured-ready',
        strategy: 'balanced',
        exhaustionPolicy: 'queue',
      },
      defaults: expect.arrayContaining([
        expect.objectContaining({ scope: 'project', visibility: 'hidden', summary: null }),
        expect.objectContaining({ scope: 'user', visibility: 'hidden', summary: null }),
        expect.objectContaining({ scope: 'installation', visibility: 'hidden', summary: null }),
      ]),
    });
    expect(body.effectiveSummary.availableCandidateCount).toBeGreaterThan(0);
  });

  it('returns installation-funded safe summary to ordinary project members without admin metadata', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'viewer' });
    seedPlatformCloudCredential(sqlite, 'platform-cloud-canary');
    await reconcileExistingDefaults(env, { includeInstallation: true });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('platform-cloud-canary');
    expect(text).not.toContain('platform-encrypted-token-for-platform-cloud-canary');
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      effective: null,
      effectiveScope: null,
      effectiveSummary: {
        scope: 'installation',
        state: 'configured-ready',
        strategy: 'balanced',
        exhaustionPolicy: 'queue',
      },
    });
    expect(body.effectiveSummary.availableCandidateCount).toBeGreaterThan(0);
  });

  it('does not widen safe summary to installation when the project pool is configured-empty', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'viewer' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-canary',
      userId: 'user-1',
      projectId: 'project-1',
      provider: 'vultr',
    });
    seedPlatformCloudCredential(sqlite, 'platform-cloud-canary');
    await reconcileExistingDefaults(env, { includeInstallation: true });
    sqlite
      .prepare(
        `UPDATE capacity_pool_candidates
         SET status = 'deleted'
         WHERE pool_id = 'cap-pool-default:project:project-1'`
      )
      .run();
    sqlite
      .prepare(
        `UPDATE capacity_pools
         SET configuration_state = 'configured-empty'
         WHERE id = 'cap-pool-default:project:project-1'`
      )
      .run();

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('project-cloud-canary');
    expect(text).not.toContain('platform-cloud-canary');
    const body = JSON.parse(text);
    expect(body.effectiveSummary).toEqual({
      scope: 'project',
      state: 'configured-empty',
      strategy: 'balanced',
      exhaustionPolicy: 'queue',
      availableCandidateCount: 0,
      nativeOfferings: [],
      reason: 'configured-default-pool-has-no-active-candidates',
    });
  });

  it('still requires project read capability for safe effective summaries', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedUser(sqlite, 'user-2');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-2', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-2',
      projectId: 'project-1',
    });

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
  });

  it('reconciles idempotently through the explicit POST path', async () => {
    const { sqlite, env } = createEnv();
    seedProjectCredentialFixture(sqlite);

    const first = await requestProjectDefaults(env);
    const second = await requestProjectDefaults(env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(second.headers.get('cache-control')).toBe('private, no-store');
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

  it('updates only the project-owned default pool for owners and admins', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'user-cloud-1',
      userId: 'user-1',
    });
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });

    const reconcile = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    const initial = await reconcile.json();
    expect(initial.policyMutationSupported).toBe(true);
    const projectCandidate = initial.effective.candidates.find(
      (candidate: { location: string; machineSize: string }) =>
        candidate.location === 'ash' && candidate.machineSize === 'medium'
    );
    expect(projectCandidate).toBeTruthy();

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          policy: { strategy: 'spread' },
          candidates: [{ id: projectCandidate.id, status: 'deleted' }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.effective.pool).toMatchObject({
      scope: 'project',
      ownerProjectId: 'project-1',
      strategy: 'spread',
      revision: 2,
    });
    expect(
      body.effective.candidates.find(
        (candidate: { id: string }) => candidate.id === projectCandidate.id
      )
    ).toMatchObject({ status: 'deleted' });

    expect(
      sqlite
        .prepare(`SELECT strategy FROM capacity_pools WHERE scope = 'user' AND owner_user_id = ?`)
        .get('user-1')
    ).toEqual({ strategy: 'balanced' });
  });

  it('re-adds a removed project catalog offering through the PATCH catalogAdditions path', async () => {
    const { sqlite, env } = createEnv();
    seedProjectCredentialFixture(sqlite);

    const reconcile = await requestProjectDefaults(env);
    expect(reconcile.status).toBe(200);
    const initial = await reconcile.json();
    const candidate = initial.effective.candidates.find(
      (item: { location: string; providerInstanceType: string | null }) =>
        item.location === 'ash' && item.providerInstanceType
    );
    expect(candidate).toBeTruthy();
    const source = initial.effective.sources.find(
      (item: { id: string }) => item.id === candidate.capacitySourceId
    );
    expect(source).toBeTruthy();

    const remove = await requestProjectDefaults(env, '/capacity-pools/defaults', {
      method: 'PATCH',
      body: JSON.stringify({
        candidates: [{ id: candidate.id, status: 'deleted' }],
      }),
    });
    expect(remove.status).toBe(200);

    const addBack = await requestProjectDefaults(env, '/capacity-pools/defaults', {
      method: 'PATCH',
      body: JSON.stringify({
        catalogAdditions: [
          {
            sourceId: source.id,
            provider: candidate.provider,
            location: candidate.location,
            providerInstanceType: candidate.providerInstanceType,
            providerInstanceSku: candidate.providerInstanceSku ?? null,
          },
        ],
      }),
    });

    expect(addBack.status).toBe(200);
    const body = await addBack.json();
    expect(
      body.effective.candidates.find((item: { id: string }) => item.id === candidate.id)
    ).toMatchObject({ status: 'active' });
    expect(
      sqlite.prepare(`SELECT status FROM capacity_pool_candidates WHERE id = ?`).get(candidate.id)
    ).toEqual({ status: 'active' });
  });

  it('rejects catalog additions outside the project default pool', async () => {
    const { sqlite, env } = createEnv();
    seedProjectCredentialFixture(sqlite);

    const reconcile = await requestProjectDefaults(env);
    expect(reconcile.status).toBe(200);

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          catalogAdditions: [
            {
              sourceId: 'source-from-another-pool',
              provider: 'hetzner',
              location: 'ash',
              providerInstanceType: 'cx43',
              providerInstanceSku: null,
            },
          ],
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      details: {
        missingCatalogAdditions: ['source-from-another-pool:hetzner:ash:cx43'],
      },
    });
  });

  it(
    'chunks catalog addition source reads below the D1 bind limit',
    async () => {
      const { sqlite, env } = createEnv({ bindLimit: 100 });
      seedUser(sqlite, 'user-1');
      seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
      for (let index = 0; index < 99; index += 1) {
        seedCloudCredential(sqlite, {
          id: `project-cloud-${index}`,
          userId: 'user-1',
          projectId: 'project-1',
          provider: 'hetzner',
        });
      }

      const reconcile = await createApp().request(
        '/api/projects/project-1/capacity-pools/defaults/reconcile',
        { method: 'POST' },
        env
      );
      expect(reconcile.status).toBe(200);
      const initial = await reconcile.json();
      const candidateBySourceId = new Map(
        initial.effective.candidates
          .filter(
            (candidate: { providerInstanceType: string | null }) => candidate.providerInstanceType
          )
          .map((candidate: { capacitySourceId: string }) => [candidate.capacitySourceId, candidate])
      );
      const additions = initial.effective.sources.map((source: { id: string }) => {
        const candidate = candidateBySourceId.get(source.id) as
          | {
              provider: string;
              location: string;
              providerInstanceType: string;
              providerInstanceSku?: string | null;
            }
          | undefined;
        if (!candidate) throw new Error(`Missing candidate for source ${source.id}`);
        return {
          sourceId: source.id,
          provider: candidate.provider,
          location: candidate.location,
          providerInstanceType: candidate.providerInstanceType,
          providerInstanceSku: candidate.providerInstanceSku ?? null,
        };
      });
      expect(additions).toHaveLength(99);

      const res = await createApp().request(
        '/api/projects/project-1/capacity-pools/defaults',
        {
          method: 'PATCH',
          body: JSON.stringify({ catalogAdditions: additions }),
        },
        env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        effectiveScope: 'project',
        effective: {
          pool: { scope: 'project', ownerProjectId: 'project-1' },
        },
      });
    },
    CATALOG_ADDITION_BIND_LIMIT_TEST_TIMEOUT_MS
  );

  it('preserves edited project candidate statuses during GET ensure=true reconciliation', async () => {
    const { sqlite, env } = createEnv({ bindLimit: 100 });
    seedProjectCredentialFixture(sqlite);

    const initialRes = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );
    expect(initialRes.status).toBe(200);
    const initial = await initialRes.json();
    const candidate = initial.effective.candidates.find(
      (item: { location: string; machineSize: string }) =>
        item.location === 'ash' && item.machineSize === 'large'
    );
    expect(candidate).toBeTruthy();

    const patchRes = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: [{ id: candidate.id, status: 'disabled' }],
        }),
      },
      env
    );
    expect(patchRes.status).toBe(200);

    const reconciledRes = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );
    expect(reconciledRes.status).toBe(200);
    const reconciled = await reconciledRes.json();

    expect(
      reconciled.effective.candidates.find((item: { id: string }) => item.id === candidate.id)
    ).toMatchObject({ status: 'disabled' });
    expect(
      sqlite.prepare(`SELECT status FROM capacity_pool_candidates WHERE id = ?`).get(candidate.id)
    ).toEqual({ status: 'disabled' });
  });

  it('requires project secret-write capability for project default edits', async () => {
    const { sqlite, env } = createEnv();
    seedProjectCredentialFixture(sqlite, { memberRole: 'maintainer' });

    const reconcile = await requestProjectDefaults(env);
    expect(reconcile.status).toBe(200);
    const initial = await reconcile.json();
    const candidate = initial.effective.candidates[0];

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: [{ id: candidate.id, status: 'disabled' }],
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
    });
  });

  it('does not let project edits mutate user fallbacks when no project default exists', async () => {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, { id: 'user-cloud-1', userId: 'user-1' });

    const reconcile = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    const initial = await reconcile.json();
    expect(initial.effectiveScope).toBe('user');
    const fallbackCandidate = initial.effective.candidates[0];

    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      {
        method: 'PATCH',
        body: JSON.stringify({
          candidates: [{ id: fallbackCandidate.id, status: 'deleted' }],
        }),
      },
      env
    );

    expect(res.status).toBe(404);
    expect(
      sqlite
        .prepare(`SELECT status FROM capacity_pool_candidates WHERE id = ?`)
        .get(fallbackCandidate.id)
    ).toEqual({ status: 'active' });
  });

  it('supports read-only inspection with ensure=false', async () => {
    const { sqlite, env } = createEnv();
    seedProjectCredentialFixture(sqlite);

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
    seedProjectCredentialFixture(sqlite);

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
    seedUser(sqlite, 'superadmin-1', 'superadmin');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES ('project-1', 'superadmin-1', 'owner', 'active')`
      )
      .run();
    seedCloudCredential(sqlite, {
      id: 'project-cloud-1',
      userId: 'user-1',
      projectId: 'project-1',
    });
    seedPlatformCloudCredential(sqlite);

    const userRes = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );
    expect(userRes.status).toBe(200);
    expect(userRes.headers.get('cache-control')).toBe('private, no-store');
    const userBody = await userRes.json();
    expect(
      userBody.defaults.find((item: { scope: string }) => item.scope === 'installation')
    ).toMatchObject({
      visibility: 'hidden',
      summary: null,
    });

    authState.userId = 'superadmin-1';
    authState.role = 'superadmin';
    const superadminRes = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults?ensure=true',
      { method: 'GET' },
      env
    );
    expect(superadminRes.status).toBe(200);
    expect(superadminRes.headers.get('cache-control')).toBe('private, no-store');
    const superadminBody = await superadminRes.json();
    expect(
      superadminBody.defaults.find((item: { scope: string }) => item.scope === 'installation')
    ).toMatchObject({
      visibility: 'visible',
      summary: expect.any(Object),
    });
  });
});
