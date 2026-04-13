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
import type { ProviderCatalogResponse } from '@simple-agent-manager/shared';
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

function createMockDB(rows: Array<{ provider: string; encryptedToken: string; iv: string }>) {
  const mockDB: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
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
  return {
    name: overrides.name ?? 'hetzner',
    locations: overrides.locations ?? ['fsn1', 'nbg1'],
    locationMetadata: overrides.locationMetadata ?? {
      fsn1: { name: 'Falkenstein', country: 'DE' },
      nbg1: { name: 'Nuremberg', country: 'DE' },
    },
    sizes: overrides.sizes ?? {
      small: { type: 'cx23', price: '€3.99/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
      medium: { type: 'cx33', price: '€7.49/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
      large: { type: 'cx43', price: '€14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
    },
    defaultLocation: overrides.defaultLocation ?? 'fsn1',
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
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toEqual([]);
  });

  it('should return catalog with correct locations and sizes for a single provider credential', async () => {
    createMockDB([
      { provider: 'hetzner', encryptedToken: 'enc-token', iv: 'test-iv' },
    ]);

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
    expect(catalog.defaultLocation).toBe('fsn1');
    expect(catalog.locations).toEqual([
      { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
      { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
      { id: 'hel1', name: 'Helsinki', country: 'FI' },
    ]);
    expect(catalog.sizes).toEqual(mockProvider.sizes);
  });

  it('should return catalogs for multiple provider credentials', async () => {
    createMockDB([
      { provider: 'hetzner', encryptedToken: 'enc-hetzner', iv: 'iv-1' },
      { provider: 'scaleway', encryptedToken: 'enc-scaleway', iv: 'iv-2' },
    ]);

    mockCreateProvider
      .mockReturnValueOnce(makeMockProvider({
        name: 'hetzner',
        locations: ['fsn1'],
        locationMetadata: { fsn1: { name: 'Falkenstein', country: 'DE' } },
        defaultLocation: 'fsn1',
      }))
      .mockReturnValueOnce(makeMockProvider({
        name: 'scaleway',
        locations: ['fr-par-1'],
        locationMetadata: { 'fr-par-1': { name: 'Paris 1', country: 'FR' } },
        sizes: {
          small: { type: 'DEV1-M', price: '~€0.024/hr', vcpu: 3, ramGb: 4, storageGb: 40 },
          medium: { type: 'DEV1-XL', price: '~€0.048/hr', vcpu: 4, ramGb: 12, storageGb: 120 },
          large: { type: 'GP1-S', price: '~€0.084/hr', vcpu: 8, ramGb: 32, storageGb: 600 },
        },
        defaultLocation: 'fr-par-1',
      }));

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toHaveLength(2);
    expect(body.catalogs[0]!.provider).toBe('hetzner');
    expect(body.catalogs[1]!.provider).toBe('scaleway');
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
      .mockReturnValueOnce(makeMockProvider({
        name: 'scaleway',
        locations: ['fr-par-1'],
        locationMetadata: { 'fr-par-1': { name: 'Paris 1', country: 'FR' } },
        defaultLocation: 'fr-par-1',
      }));

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    // Only the successful provider should be in the result
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]!.provider).toBe('scaleway');
  });

  it('should use location id as fallback name when metadata is missing', async () => {
    createMockDB([
      { provider: 'hetzner', encryptedToken: 'enc-token', iv: 'test-iv' },
    ]);

    // Provider with a location that has no metadata entry
    mockCreateProvider.mockReturnValue({
      name: 'hetzner',
      locations: ['fsn1', 'unknown-dc'],
      locationMetadata: {
        fsn1: { name: 'Falkenstein', country: 'DE' },
        // 'unknown-dc' intentionally missing
      },
      sizes: {
        small: { type: 'cx23', price: '€3.99/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
        medium: { type: 'cx33', price: '€7.49/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
        large: { type: 'cx43', price: '€14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
      },
      defaultLocation: 'fsn1',
    });

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    const locations = body.catalogs[0]!.locations;
    expect(locations[1]).toEqual({ id: 'unknown-dc', name: 'unknown-dc', country: '' });
  });

  it('should return empty catalogs when all providers fail', async () => {
    createMockDB([
      { provider: 'hetzner', encryptedToken: 'enc-bad', iv: 'iv-bad' },
    ]);

    mockCreateProvider.mockImplementation(() => {
      throw new Error('All providers broken');
    });

    const res = await app.request('/api/providers/catalog', { method: 'GET' }, makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderCatalogResponse;
    expect(body.catalogs).toEqual([]);
  });
});
