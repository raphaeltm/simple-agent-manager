import type { ProviderCatalogResponse, SizeInfo, VMSize } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const authState = vi.hoisted(() => ({
  userId: 'test-user-id',
  role: 'user',
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  getUserId: () => authState.userId,
  getAuth: () => ({
    user: {
      id: authState.userId,
      role: authState.role,
    },
  }),
}));

const mockRequireProjectCapability = vi.fn();
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: (...args: unknown[]) => mockRequireProjectCapability(...args),
}));

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(async (ciphertext: string) => `decrypted:${ciphertext}`),
}));

const mockCreateProvider = vi.fn();
vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  return {
    ...original,
    createProvider: (...args: unknown[]) => mockCreateProvider(...args),
  };
});

const { providersRoutes } = await import('../../../src/routes/providers');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/providers', providersRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users, schema.credentials, schema.platformCredentials]);
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY: 'test-encryption-key',
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
  input: {
    id: string;
    userId: string;
    provider?: string;
    projectId?: string | null;
    active?: boolean;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO credentials (
        id, user_id, project_id, provider, credential_type, credential_kind,
        is_active, encrypted_token, iv
       )
       VALUES (?, ?, ?, ?, 'cloud-provider', 'api-key', ?, ?, ?)`
    )
    .run(
      input.id,
      input.userId,
      input.projectId ?? null,
      input.provider ?? 'hetzner',
      input.active === false ? 0 : 1,
      `encrypted-token-for-${input.id}`,
      `iv-for-${input.id}`
    );
}

function seedPlatformCredential(
  sqlite: Database.Database,
  input: { id: string; provider?: string; enabled?: boolean }
) {
  sqlite
    .prepare(
      `INSERT INTO platform_credentials (
        id, credential_type, provider, agent_type, credential_kind, label,
        encrypted_token, iv, is_enabled, created_by
       )
       VALUES (?, 'cloud-provider', ?, NULL, 'api-key', ?, ?, ?, ?, 'admin-1')`
    )
    .run(
      input.id,
      input.provider ?? 'hetzner',
      `${input.provider ?? 'hetzner'} platform`,
      `platform-encrypted-token-for-${input.id}`,
      `platform-iv-for-${input.id}`,
      input.enabled === false ? 0 : 1
    );
}

function makeMockProvider(name: string) {
  const locations = ['fsn1'];
  const sizes = {
    small: { type: `${name}-small`, price: '€3.99/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
    medium: { type: `${name}-medium`, price: '€7.49/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
    large: { type: `${name}-large`, price: '€14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
  } as Record<VMSize, SizeInfo>;
  return {
    name,
    locations,
    locationMetadata: { fsn1: { name: 'Falkenstein', country: 'DE' } },
    sizes,
    defaultLocation: 'fsn1',
    listInstanceOfferings: vi.fn(async () => [
      {
        provider: name,
        location: 'fsn1',
        locationName: 'Falkenstein',
        country: 'DE',
        providerInstanceType: `${name}-catalog-only-large`,
        providerInstanceSku: null,
        displayName: `${name} catalog-only large`,
        sku: `${name}-catalog-only-large`,
        instanceType: `${name}-catalog-only-large`,
        type: `${name}-catalog-only-large`,
        name: `${name}-catalog-only-large`,
        vcpu: 16,
        ramGb: 64,
        memoryMb: 65_536,
        storageGb: 480,
        diskGb: 480,
        price: '€220.00/mo',
        currency: 'EUR',
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-29T00:00:00.000Z',
      },
    ]),
  };
}

function seedMixedCredentials(sqlite: Database.Database) {
  seedUser(sqlite, 'test-user-id');
  seedUser(sqlite, 'other-user-id');
  seedUser(sqlite, 'admin-1', 'superadmin');
  seedCloudCredential(sqlite, { id: 'user-active', userId: 'test-user-id', provider: 'hetzner' });
  seedCloudCredential(sqlite, {
    id: 'user-inactive',
    userId: 'test-user-id',
    provider: 'vultr',
    active: false,
  });
  seedCloudCredential(sqlite, {
    id: 'other-user-active',
    userId: 'other-user-id',
    provider: 'digitalocean',
  });
  seedCloudCredential(sqlite, {
    id: 'project-active',
    userId: 'test-user-id',
    projectId: 'project-1',
    provider: 'vultr',
  });
  seedCloudCredential(sqlite, {
    id: 'project-inactive',
    userId: 'test-user-id',
    projectId: 'project-1',
    provider: 'digitalocean',
    active: false,
  });
  seedCloudCredential(sqlite, {
    id: 'project-other',
    userId: 'test-user-id',
    projectId: 'project-2',
    provider: 'upcloud',
  });
  seedPlatformCredential(sqlite, { id: 'platform-enabled', provider: 'hetzner' });
  seedPlatformCredential(sqlite, { id: 'platform-disabled', provider: 'vultr', enabled: false });
}

describe('GET /api/providers/catalog scope filtering with real SQL', () => {
  beforeEach(() => {
    authState.userId = 'test-user-id';
    authState.role = 'user';
    mockRequireProjectCapability.mockResolvedValue({});
    mockCreateProvider.mockImplementation((config: { provider: string }) =>
      makeMockProvider(config.provider)
    );
    vi.clearAllMocks();
  });

  it('returns only active personal credentials for user scope', async () => {
    const { sqlite, env } = createEnv();
    seedMixedCredentials(sqlite);

    const res = await createApp().request('/api/providers/catalog?scope=user', {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs.map((catalog) => catalog.credentialId)).toEqual(['user-active']);
    expect(body.catalogs[0]).toMatchObject({
      provider: 'hetzner',
      credentialSource: 'user',
      platformCredentialId: null,
    });
    expect(JSON.stringify(body)).not.toContain('encrypted-token-for-user-active');
    expect(JSON.stringify(body)).not.toContain('iv-for-user-active');
  });

  it('returns only active project-scoped credentials after secret-read authorization', async () => {
    const { sqlite, env } = createEnv();
    seedMixedCredentials(sqlite);

    const res = await createApp().request(
      '/api/providers/catalog?scope=project&projectId=project-1',
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(mockRequireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'test-user-id',
      'secret:read'
    );
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs.map((catalog) => catalog.credentialId)).toEqual(['project-active']);
    expect(body.catalogs[0]).toMatchObject({
      provider: 'vultr',
      credentialSource: 'project',
      platformCredentialId: null,
    });
    expect(JSON.stringify(body)).not.toContain('encrypted-token-for-project-active');
    expect(JSON.stringify(body)).not.toContain('iv-for-project-active');
  });

  it('returns only enabled platform credentials for installation scope', async () => {
    authState.userId = 'admin-1';
    authState.role = 'superadmin';
    const { sqlite, env } = createEnv();
    seedMixedCredentials(sqlite);

    const res = await createApp().request('/api/providers/catalog?scope=installation', {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs.map((catalog) => catalog.platformCredentialId)).toEqual([
      'platform-enabled',
    ]);
    expect(body.catalogs[0]).toMatchObject({
      provider: 'hetzner',
      credentialSource: 'platform',
      credentialId: null,
    });
    expect(JSON.stringify(body)).not.toContain('platform-encrypted-token-for-platform-enabled');
    expect(JSON.stringify(body)).not.toContain('platform-iv-for-platform-enabled');
  });
});
