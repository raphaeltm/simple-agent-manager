import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { ScalewayProvider } from '../../src/scaleway';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';
import { createMockScalewayServer, createScalewayFetchMock } from '../fixtures/scaleway-mocks';
import { fetchCall, jsonBody } from './test-helpers';

describe('ScalewayProvider', () => {
  let provider: ScalewayProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new ScalewayProvider('test-secret-key', 'test-project-id', 'fr-par-1');
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor and properties', () => {
    it('should set provider name to scaleway', () => {
      expect(provider.name).toBe('scaleway');
    });

    it('should expose locations', () => {
      expect(provider.locations).toContain('fr-par-1');
      expect(provider.locations).toContain('nl-ams-1');
      expect(provider.locations).toContain('pl-waw-1');
      expect(provider.locations.length).toBeGreaterThan(0);
    });

    it('should expose sizes for all tiers', () => {
      expect(provider.sizes.small).toBeDefined();
      expect(provider.sizes.medium).toBeDefined();
      expect(provider.sizes.large).toBeDefined();
    });

    it('should use default zone if not provided', () => {
      const p = new ScalewayProvider('key', 'proj');
      expect(p.name).toBe('scaleway');
    });
  });

  describe('locationMetadata', () => {
    it('should have metadata for all 8 zones', () => {
      expect(Object.keys(provider.locationMetadata)).toHaveLength(8);
    });

    it('should have correct metadata for fr-par-1', () => {
      expect(provider.locationMetadata['fr-par-1']).toEqual({ name: 'Paris 1', country: 'FR' });
    });

    it('should have correct metadata for fr-par-2', () => {
      expect(provider.locationMetadata['fr-par-2']).toEqual({ name: 'Paris 2', country: 'FR' });
    });

    it('should have correct metadata for fr-par-3', () => {
      expect(provider.locationMetadata['fr-par-3']).toEqual({ name: 'Paris 3', country: 'FR' });
    });

    it('should have correct metadata for nl-ams-1', () => {
      expect(provider.locationMetadata['nl-ams-1']).toEqual({ name: 'Amsterdam 1', country: 'NL' });
    });

    it('should have correct metadata for nl-ams-2', () => {
      expect(provider.locationMetadata['nl-ams-2']).toEqual({ name: 'Amsterdam 2', country: 'NL' });
    });

    it('should have correct metadata for nl-ams-3', () => {
      expect(provider.locationMetadata['nl-ams-3']).toEqual({ name: 'Amsterdam 3', country: 'NL' });
    });

    it('should have correct metadata for pl-waw-1', () => {
      expect(provider.locationMetadata['pl-waw-1']).toEqual({ name: 'Warsaw 1', country: 'PL' });
    });

    it('should have correct metadata for pl-waw-2', () => {
      expect(provider.locationMetadata['pl-waw-2']).toEqual({ name: 'Warsaw 2', country: 'PL' });
    });

    it('should have metadata entries matching the locations array', () => {
      for (const loc of provider.locations) {
        expect(provider.locationMetadata[loc]).toBeDefined();
      }
    });
  });

  describe('defaultLocation', () => {
    it('should default to constructor zone parameter', () => {
      const p = new ScalewayProvider('key', 'proj', 'nl-ams-1');
      expect(p.defaultLocation).toBe('nl-ams-1');
    });

    it('should default to DEFAULT_SCALEWAY_ZONE when no zone is provided', () => {
      const p = new ScalewayProvider('key', 'proj');
      expect(p.defaultLocation).toBe('fr-par-1');
    });
  });

  describe('sizes', () => {
    it('should return correct small size config', () => {
      expect(provider.sizes.small).toEqual({
        type: 'DEV1-M',
        price: '~€0.024/hr',
        vcpu: 3,
        ramGb: 4,
        storageGb: 40,
      });
    });

    it('should return correct medium size config', () => {
      expect(provider.sizes.medium).toEqual({
        type: 'DEV1-XL',
        price: '~€0.048/hr',
        vcpu: 4,
        ramGb: 12,
        storageGb: 120,
      });
    });

    it('should return correct large size config', () => {
      expect(provider.sizes.large).toEqual({
        type: 'GP1-S',
        price: '~€0.084/hr',
        vcpu: 8,
        ramGb: 32,
        storageGb: 600,
      });
    });
  });

  describe('createVM', () => {
    const vmConfig: VMConfig = {
      name: 'test-server',
      size: 'medium',
      location: 'fr-par-1',
      userData: '#cloud-config\npackages:\n  - docker.io',
      labels: { node: 'node-123', managed: 'simple-agent-manager' },
    };

    it('should perform three-step creation: create server, set cloud-init, poweron', async () => {
      const mockFetch = createScalewayFetchMock();
      globalThis.fetch = mockFetch;

      await provider.createVM(vmConfig);

      // Should have made 4 calls: resolve image, create server, set cloud-init, poweron
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Call 1: GET images (resolve image ID)
      const call1Url = fetchCall(mockFetch, 0).url;
      expect(call1Url).toContain('/images');

      // Call 2: POST /servers (create)
      const { url: call2Url, init: call2Init } = fetchCall(mockFetch, 1);
      expect(call2Url).toContain('/servers');
      expect(call2Init.method).toBe('POST');

      // Call 3: PATCH cloud-init
      const { url: call3Url, init: call3Init } = fetchCall(mockFetch, 2);
      expect(call3Url).toContain('/user_data/cloud-init');
      expect(call3Init.method).toBe('PATCH');
      expect(call3Init.body).toBe(vmConfig.userData);

      // Call 4: POST action (poweron)
      const { url: call4Url, init: call4Init } = fetchCall(mockFetch, 3);
      expect(call4Url).toContain('/action');
      expect(call4Init.method).toBe('POST');
      const actionBody = JSON.parse(call4Init.body as string);
      expect(actionBody.action).toBe('poweron');
    });

    it('should send correct server creation payload', async () => {
      globalThis.fetch = createScalewayFetchMock();

      await provider.createVM(vmConfig);

      // The create server call is the second one (after image resolution)
      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 1).init);
      expect(body.name).toBe('test-server');
      expect(body.commercial_type).toBe('DEV1-XL');
      expect(body.image).toBe('img-uuid-1234');
      expect(body.project).toBe('test-project-id');
      expect(body.dynamic_ip_required).toBe(true);
      expect(body.tags).toEqual(['node=node-123', 'managed=simple-agent-manager']);
    });

    it('should use X-Auth-Token header', async () => {
      globalThis.fetch = createScalewayFetchMock();

      await provider.createVM(vmConfig);

      const headers = fetchCall(fetch as ReturnType<typeof vi.fn>, 1).init.headers as Record<string, string>;
      expect(headers['X-Auth-Token']).toBe('test-secret-key');
    });

    it('should use config.location for the zone in API URL', async () => {
      globalThis.fetch = createScalewayFetchMock();

      await provider.createVM({ ...vmConfig, location: 'nl-ams-1' });

      const createUrl = fetchCall(fetch as ReturnType<typeof vi.fn>, 1).url;
      expect(createUrl).toContain('/zones/nl-ams-1/servers');
    });

    it('should return mapped VMInstance with empty IP (allocated after boot)', async () => {
      globalThis.fetch = createScalewayFetchMock({
        createServer: createMockScalewayServer({
          id: 'new-id',
          name: 'my-vm',
          state: 'stopped',
          public_ip: null,
          public_ips: [],
          commercial_type: 'DEV1-XL',
          creation_date: '2024-06-01T00:00:00Z',
          tags: ['node=n1'],
        }),
      });

      const result = await provider.createVM(vmConfig);

      // IP is empty because Scaleway allocates it asynchronously after boot
      expect(result).toEqual({
        id: 'new-id',
        name: 'my-vm',
        ip: '',
        status: 'off',
        serverType: 'DEV1-XL',
        createdAt: '2024-06-01T00:00:00Z',
        labels: { node: 'n1' },
      });
    });

    it('should skip image resolution when a UUID is provided', async () => {
      const mockFetch = createScalewayFetchMock();
      globalThis.fetch = mockFetch;

      await provider.createVM({
        ...vmConfig,
        image: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });

      // Should be 3 calls (no image resolution): create, cloud-init, poweron
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const createUrl = fetchCall(mockFetch, 0).url;
      expect(createUrl).toContain('/servers');
    });

    it('should throw ProviderError when no image is found', async () => {
      globalThis.fetch = createScalewayFetchMock({ images: [] });

      await expect(provider.createVM(vmConfig)).rejects.toThrow(ProviderError);
    });

    it('should throw ProviderError on API failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
      );

      await expect(provider.createVM(vmConfig)).rejects.toThrow(ProviderError);
    });

  });
});
