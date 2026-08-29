/**
 * Behavioral tests for the provider catalog route.
 *
 * GET /api/providers/catalog — returns available instance types, locations,
 *   and sizes for each cloud provider the user has credentials for.
 *
 * Mocking strategy:
 * - drizzle-orm/d1 is mocked so DB calls are controlled per test
 * - Auth middleware is bypassed (returns a fixed test user)
 * - Encryption decrypt is mocked to return controlled plaintext
 * - @simple-agent-manager/providers createProvider is mocked so we control
 *   the provider instances returned (locations, sizes, locationMetadata, defaultLocation)
 */
import type { ProviderCatalogResponse, SizeInfo, VMSize } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { providersRoutes } from '../../../src/routes/providers';

vi.mock('drizzle-orm/d1');

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));

vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'encrypted', iv: 'iv' }),
  decrypt: vi.fn().mockResolvedValue('decrypted-token'),
}));

// Mock createProvider to return controlled provider instances
const mockCreateProvider = vi.fn();
vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  return {
    ...original,
    createProvider: (...args: unknown[]) => mockCreateProvider(...args),
  };
});

// Mock buildProviderConfig to return a pass-through config
vi.mock('../../../src/services/provider-credentials', () => ({
  buildProviderConfig: vi.fn((provider: string, _token: string) => ({
    provider,
    apiToken: 'mock-token',
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  app.route('/api/providers', providersRoutes);
  return app;
}

function createMockDB(
  rows: Array<{
    id?: string;
    projectId?: string | null;
    provider: string;
    encryptedToken: string;
    iv: string;
  }>
) {
  const selectedRows = rows.map((row, index) => ({
    ...row,
    id: row.id ?? `credential-${index + 1}`,
    projectId: row.projectId ?? null,
  }));
  const mockDB: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(selectedRows),
  };
  (drizzle as any).mockReturnValue(mockDB);
  return mockDB;
}

function makeEnv(): Env {
  return {
    DATABASE: {} as any,
    ENCRYPTION_KEY: 'test-encryption-key',
  } as Env;
}

function makeMockProvider(overrides: {
  name?: string;
  locations?: readonly string[];
  locationMetadata?: Record<string, { name: string; country: string }>;
  sizes?: Record<string, any>;
  defaultLocation?: string;
}) {
  const name = overrides.name ?? 'hetzner';
  const locations = overrides.locations ?? ['fsn1', 'nbg1'];
  const locationMetadata = overrides.locationMetadata ?? {
    fsn1: { name: 'Falkenstein', country: 'DE' },
    nbg1: { name: 'Nuremberg', country: 'DE' },
  };
  const sizes = (overrides.sizes ?? {
    small: { type: 'cx23', price: '€3.99/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
    medium: { type: 'cx33', price: '€7.49/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
    large: { type: 'cx43', price: '€14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
  }) as Record<VMSize, SizeInfo>;

  return {
    name,
    locations,
    locationMetadata,
    sizes,
    defaultLocation: overrides.defaultLocation ?? 'fsn1',
    listInstanceOfferings: vi.fn(async () =>
      locations.flatMap((location) =>
        (Object.entries(sizes) as Array<[VMSize, SizeInfo]>).map(([machineSize, size]) => {
          const meta = locationMetadata[location];
          return {
            provider: name,
            location,
            locationName: meta?.name,
            country: meta?.country,
            providerInstanceType: size.type,
            providerInstanceSku: null,
            displayName: `${size.type} · ${size.vcpu} vCPU · ${size.ramGb} GB RAM · ${size.storageGb} GB disk`,
            sku: size.type,
            instanceType: size.type,
            type: size.type,
            name: size.type,
            vcpu: size.vcpu,
            ramGb: size.ramGb,
            memoryMb: size.ramGb * 1024,
            storageGb: size.storageGb,
            diskGb: size.storageGb,
            price: size.price,
            currency: size.price.includes('$') ? 'USD' : size.price.includes('€') ? 'EUR' : null,
            catalogSource: 'static',
            catalogLastSeenAt: null,
            machineSize,
          };
        })
      )
    ),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/providers/catalog', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  it('should return empty catalogs array when user has no cloud-provider credentials', async () => {
    createMockDB([]);

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toEqual([]);
    expect(body.credentialSetupRequired).toBe(true);
    expect(body.credentialSetupMessage).toContain('cloud-provider credential');
  });

  it('should return catalog with correct locations and sizes for a single provider credential', async () => {
    createMockDB([{ provider: 'hetzner', encryptedToken: 'enc-token', iv: 'test-iv' }]);

    const mockProvider = makeMockProvider({
      name: 'hetzner',
      locations: ['fsn1', 'nbg1', 'hel1'],
      locationMetadata: {
        fsn1: { name: 'Falkenstein', country: 'DE' },
        nbg1: { name: 'Nuremberg', country: 'DE' },
        hel1: { name: 'Helsinki', country: 'FI' },
      },
      defaultLocation: 'fsn1',
    });
    mockCreateProvider.mockReturnValue(mockProvider);

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toHaveLength(1);

    const catalog = body.catalogs[0]!;
    expect(catalog.provider).toBe('hetzner');
    expect(catalog.credentialSource).toBe('user');
    expect(catalog.credentialId).toBe('credential-1');
    expect(catalog.defaultLocation).toBe('fsn1');
    expect(catalog.locations).toEqual([
      { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
      { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
      { id: 'hel1', name: 'Helsinki', country: 'FI' },
    ]);
    expect(catalog.sizes).toEqual(mockProvider.sizes);
    expect(catalog.offerings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          providerInstanceSku: null,
          catalogSource: 'static',
          machineSize: 'small',
        }),
      ])
    );
    expect(mockProvider.listInstanceOfferings).toHaveBeenCalledWith({ preferApi: true });
  });

  it('identifies project-scoped provider catalogs separately from user credentials', async () => {
    createMockDB([
      {
        id: 'project-credential-1',
        projectId: 'project-1',
        provider: 'hetzner',
        encryptedToken: 'enc-token',
        iv: 'test-iv',
      },
    ]);

    const mockProvider = makeMockProvider({
      name: 'hetzner',
      locations: ['ash'],
      locationMetadata: { ash: { name: 'Ashburn', country: 'US' } },
      defaultLocation: 'ash',
    });
    mockCreateProvider.mockReturnValue(mockProvider);

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]).toMatchObject({
      provider: 'hetzner',
      credentialSource: 'project',
      credentialId: 'project-credential-1',
    });
  });

  it('should return catalogs for multiple provider credentials', async () => {
    createMockDB([
      { provider: 'hetzner', encryptedToken: 'enc-hetzner', iv: 'iv-1' },
      { provider: 'scaleway', encryptedToken: 'enc-scaleway', iv: 'iv-2' },
    ]);

    mockCreateProvider
      .mockReturnValueOnce(
        makeMockProvider({
          name: 'hetzner',
          locations: ['fsn1'],
          locationMetadata: { fsn1: { name: 'Falkenstein', country: 'DE' } },
          defaultLocation: 'fsn1',
        })
      )
      .mockReturnValueOnce(
        makeMockProvider({
          name: 'scaleway',
          locations: ['fr-par-1'],
          locationMetadata: { 'fr-par-1': { name: 'Paris 1', country: 'FR' } },
          sizes: {
            small: { type: 'DEV1-M', price: '~€0.024/hr', vcpu: 3, ramGb: 4, storageGb: 40 },
            medium: { type: 'DEV1-XL', price: '~€0.048/hr', vcpu: 4, ramGb: 12, storageGb: 120 },
            large: { type: 'GP1-S', price: '~€0.084/hr', vcpu: 8, ramGb: 32, storageGb: 600 },
          },
          defaultLocation: 'fr-par-1',
        })
      );

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toHaveLength(2);
    expect(body.catalogs[0]!.provider).toBe('hetzner');
    expect(body.catalogs[1]!.provider).toBe('scaleway');
  });

  it('includes a vultr catalog when the user has a vultr credential', async () => {
    createMockDB([{ provider: 'vultr', encryptedToken: 'enc-vultr', iv: 'iv-v' }]);
    mockCreateProvider.mockReturnValue(
      makeMockProvider({
        name: 'vultr',
        locations: ['fra', 'ewr'],
        locationMetadata: {
          fra: { name: 'Frankfurt', country: 'DE' },
          ewr: { name: 'New Jersey', country: 'US' },
        },
        sizes: {
          small: { type: 'vc2-2c-4gb', price: '~$20/mo', vcpu: 2, ramGb: 4, storageGb: 80 },
          medium: { type: 'vc2-4c-8gb', price: '~$40/mo', vcpu: 4, ramGb: 8, storageGb: 160 },
          large: { type: 'vc2-6c-16gb', price: '~$80/mo', vcpu: 6, ramGb: 16, storageGb: 320 },
        },
        defaultLocation: 'fra',
      })
    );

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]!.provider).toBe('vultr');
    expect(body.catalogs[0]!.defaultLocation).toBe('fra');
    expect(body.catalogs[0]!.sizes.small.type).toBe('vc2-2c-4gb');
  });

  it('omits vultr from the catalog when the user has no vultr credential', async () => {
    createMockDB([{ provider: 'hetzner', encryptedToken: 'enc-hetzner', iv: 'iv-1' }]);
    mockCreateProvider.mockReturnValue(makeMockProvider({ name: 'hetzner' }));

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs.map((c) => c.provider)).not.toContain('vultr');
  });

  it('includes a DigitalOcean catalog when the user has a DigitalOcean credential', async () => {
    createMockDB([{ provider: 'digitalocean', encryptedToken: 'enc-digitalocean', iv: 'iv-do' }]);
    mockCreateProvider.mockReturnValue(
      makeMockProvider({
        name: 'digitalocean',
        locations: ['fra1', 'nyc3'],
        locationMetadata: {
          fra1: { name: 'Frankfurt 1', country: 'DE' },
          nyc3: { name: 'New York 3', country: 'US' },
        },
        sizes: {
          small: { type: 's-2vcpu-4gb', price: '~/mo', vcpu: 2, ramGb: 4, storageGb: 80 },
          medium: { type: 's-4vcpu-8gb', price: '~/mo', vcpu: 4, ramGb: 8, storageGb: 160 },
          large: { type: 's-8vcpu-16gb', price: '~/mo', vcpu: 8, ramGb: 16, storageGb: 320 },
        },
        defaultLocation: 'fra1',
      })
    );
    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]!.provider).toBe('digitalocean');
    expect(body.catalogs[0]!.defaultLocation).toBe('fra1');
    expect(body.catalogs[0]!.sizes.small.type).toBe('s-2vcpu-4gb');
  });

  it('omits DigitalOcean from the catalog when the user has no DigitalOcean credential', async () => {
    createMockDB([{ provider: 'hetzner', encryptedToken: 'enc-hetzner', iv: 'iv-1' }]);
    mockCreateProvider.mockReturnValue(makeMockProvider({ name: 'hetzner' }));
    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs.map((c) => c.provider)).not.toContain('digitalocean');
  });

  it('should skip providers with invalid credentials (catch-and-continue behavior)', async () => {
    createMockDB([
      { provider: 'hetzner', encryptedToken: 'enc-bad', iv: 'iv-bad' },
      { provider: 'scaleway', encryptedToken: 'enc-good', iv: 'iv-good' },
    ]);

    // First provider throws during createProvider
    mockCreateProvider
      .mockImplementationOnce(() => {
        throw new Error('Invalid credential format');
      })
      .mockReturnValueOnce(
        makeMockProvider({
          name: 'scaleway',
          locations: ['fr-par-1'],
          locationMetadata: { 'fr-par-1': { name: 'Paris 1', country: 'FR' } },
          defaultLocation: 'fr-par-1',
        })
      );

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    // Only the successful provider should be in the result
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]!.provider).toBe('scaleway');
  });

  it('falls back to static offerings when live provider catalog enumeration fails', async () => {
    createMockDB([{ provider: 'hetzner', encryptedToken: 'enc-token', iv: 'test-iv' }]);

    const mockProvider = makeMockProvider({
      name: 'hetzner',
      locations: ['fsn1'],
      locationMetadata: { fsn1: { name: 'Falkenstein', country: 'DE' } },
      defaultLocation: 'fsn1',
    });
    const staticOfferings = await mockProvider.listInstanceOfferings({ preferApi: false });
    mockProvider.listInstanceOfferings
      .mockRejectedValueOnce(new Error('server_types timed out'))
      .mockResolvedValueOnce(staticOfferings);
    mockCreateProvider.mockReturnValue(mockProvider);

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.credentialSetupRequired).toBe(false);
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]).toMatchObject({
      provider: 'hetzner',
      credentialSource: 'user',
      credentialId: 'credential-1',
    });
    expect(body.catalogs[0]!.offerings).toEqual(staticOfferings);
    expect(mockProvider.listInstanceOfferings).toHaveBeenNthCalledWith(1, { preferApi: false });
    expect(mockProvider.listInstanceOfferings).toHaveBeenNthCalledWith(2, { preferApi: true });
    expect(mockProvider.listInstanceOfferings).toHaveBeenNthCalledWith(3, { preferApi: false });
  });

  it('should use location id as fallback name when metadata is missing', async () => {
    createMockDB([{ provider: 'hetzner', encryptedToken: 'enc-token', iv: 'test-iv' }]);

    // Provider with a location that has no metadata entry
    mockCreateProvider.mockReturnValue(
      makeMockProvider({
        name: 'hetzner',
        locations: ['fsn1', 'unknown-dc'],
        locationMetadata: {
          fsn1: { name: 'Falkenstein', country: 'DE' },
          // 'unknown-dc' intentionally missing
        },
        defaultLocation: 'fsn1',
      })
    );

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    const locations = body.catalogs[0]!.locations;
    expect(locations[1]).toEqual({ id: 'unknown-dc', name: 'unknown-dc', country: '' });
  });

  it('should return empty catalogs when all providers fail', async () => {
    createMockDB([{ provider: 'hetzner', encryptedToken: 'enc-bad', iv: 'iv-bad' }]);

    mockCreateProvider.mockImplementation(() => {
      throw new Error('All providers broken');
    });

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toEqual([]);
    expect(body.credentialSetupRequired).toBe(false);
    expect(body.credentialSetupMessage).toBeUndefined();
  });
});
