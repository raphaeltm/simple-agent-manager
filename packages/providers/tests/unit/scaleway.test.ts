import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScalewayProvider } from '../../src/scaleway';
import { ProviderError } from '../../src/types';
import type { VMConfig } from '../../src/types';
import { createMockScalewayServer, createScalewayFetchMock } from '../fixtures/scaleway-mocks';

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

      // Should have made at least 4 calls: resolve image, create server, set cloud-init, poweron
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Call 1: GET images (resolve image ID)
      const call1Url = mockFetch.mock.calls[0]![0] as string;
      expect(call1Url).toContain('/images');

      // Call 2: POST /servers (create)
      const call2Url = mockFetch.mock.calls[1]![0] as string;
      const call2Init = mockFetch.mock.calls[1]![1] as RequestInit;
      expect(call2Url).toContain('/servers');
      expect(call2Init.method).toBe('POST');

      // Call 3: PATCH cloud-init
      const call3Url = mockFetch.mock.calls[2]![0] as string;
      const call3Init = mockFetch.mock.calls[2]![1] as RequestInit;
      expect(call3Url).toContain('/user_data/cloud-init');
      expect(call3Init.method).toBe('PATCH');
      expect(call3Init.body).toBe(vmConfig.userData);

      // Call 4: POST action (poweron)
      const call4Url = mockFetch.mock.calls[3]![0] as string;
      const call4Init = mockFetch.mock.calls[3]![1] as RequestInit;
      expect(call4Url).toContain('/action');
      expect(call4Init.method).toBe('POST');
      const actionBody = JSON.parse(call4Init.body as string);
      expect(actionBody.action).toBe('poweron');
    });

    it('should send correct server creation payload', async () => {
      globalThis.fetch = createScalewayFetchMock();

      await provider.createVM(vmConfig);

      // The create server call is the second one (after image resolution)
      const createCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1]!;
      const body = JSON.parse((createCall[1] as RequestInit).body as string);
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

      const createCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1]!;
      const headers = (createCall[1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Auth-Token']).toBe('test-secret-key');
    });

    it('should use config.location for the zone in API URL', async () => {
      globalThis.fetch = createScalewayFetchMock();

      await provider.createVM({ ...vmConfig, location: 'nl-ams-1' });

      const createUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
      expect(createUrl).toContain('/zones/nl-ams-1/servers');
    });

    it('should return mapped VMInstance', async () => {
      globalThis.fetch = createScalewayFetchMock({
        createServer: createMockScalewayServer({
          id: 'new-id',
          name: 'my-vm',
          state: 'stopped',
          public_ip: { address: '5.6.7.8' },
          public_ips: [{ address: '5.6.7.8' }],
          commercial_type: 'DEV1-XL',
          creation_date: '2024-06-01T00:00:00Z',
          tags: ['node=n1'],
        }),
      });

      const result = await provider.createVM(vmConfig);

      expect(result).toEqual({
        id: 'new-id',
        name: 'my-vm',
        ip: '5.6.7.8',
        status: 'off', // 'stopped' maps to 'off' — server is created in stopped state before poweron
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
      const createUrl = mockFetch.mock.calls[0]![0] as string;
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

  describe('deleteVM', () => {
    it('should call terminate action', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ task: {} }), { status: 202 }),
      );
      globalThis.fetch = mockFetch;

      await provider.deleteVM('server-id');

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/servers/server-id/action');
      const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.action).toBe('terminate');
    });

    it('should not throw on 404 (idempotent)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
      );

      await expect(provider.deleteVM('server-id')).resolves.not.toThrow();
    });

    it('should fall back to DELETE when terminate returns 400', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Invalid state' }), { status: 400 }),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 204 }),
        );
      globalThis.fetch = mockFetch;

      await provider.deleteVM('server-id');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const deleteUrl = mockFetch.mock.calls[1]![0] as string;
      expect(deleteUrl).toContain('/servers/server-id');
      expect((mockFetch.mock.calls[1]![1] as RequestInit).method).toBe('DELETE');
    });

    it('should handle 404 on fallback DELETE (idempotent)', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Invalid state' }), { status: 400 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
        );
      globalThis.fetch = mockFetch;

      await expect(provider.deleteVM('server-id')).resolves.not.toThrow();
    });

    it('should throw ProviderError on non-400/404 errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );

      await expect(provider.deleteVM('server-id')).rejects.toThrow(ProviderError);
    });
  });

  describe('getVM', () => {
    it('should return VM instance if found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockScalewayServer({
            tags: ['node=n1', 'managed=sam'],
          }),
        }), { status: 200 }),
      );

      const result = await provider.getVM('server-id');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result!.status).toBe('running');
      expect(result!.ip).toBe('1.2.3.4');
      expect(result!.labels).toEqual({ node: 'n1', managed: 'sam' });
    });

    it('should return null if VM not found (404)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
      );

      const result = await provider.getVM('non-existent');
      expect(result).toBeNull();
    });

    it('should extract IP from public_ips when public_ip is null', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockScalewayServer({
            public_ip: null,
            public_ips: [{ address: '9.8.7.6' }],
          }),
        }), { status: 200 }),
      );

      const result = await provider.getVM('server-id');
      expect(result!.ip).toBe('9.8.7.6');
    });

    it('should return empty IP when no public IP available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockScalewayServer({
            public_ip: null,
            public_ips: [],
          }),
        }), { status: 200 }),
      );

      const result = await provider.getVM('server-id');
      expect(result!.ip).toBe('');
    });
  });

  describe('listVMs', () => {
    it('should return list of VMs', async () => {
      const servers = [
        createMockScalewayServer({ id: 'id-1', name: 's1', tags: ['managed=sam'] }),
        createMockScalewayServer({ id: 'id-2', name: 's2', state: 'stopped', tags: ['managed=sam'] }),
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers }), { status: 200 }),
      );

      const result = await provider.listVMs();
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('id-1');
      expect(result[1]!.id).toBe('id-2');
      expect(result[1]!.status).toBe('off');
    });

    it('should pass label filters as tags query params', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      await provider.listVMs({ 'managed-by': 'simple-agent-manager', node: 'n1' });

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toContain('tags=');
      expect(decodeURIComponent(url)).toContain('managed-by=simple-agent-manager');
      expect(decodeURIComponent(url)).toContain('node=n1');
    });

    it('should return empty array when no VMs match', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      const result = await provider.listVMs({ nonexistent: 'label' });
      expect(result).toEqual([]);
    });

    it('should not include query params when no labels provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      await provider.listVMs();

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toMatch(/\/servers$/);
    });
  });

  describe('powerOff', () => {
    it('should call poweroff action endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ task: {} }), { status: 202 }),
      );

      await provider.powerOff('server-id');

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toContain('/servers/server-id/action');
      const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
      expect(body.action).toBe('poweroff');
    });

    it('should throw ProviderError on failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Error', { status: 500 }),
      );

      await expect(provider.powerOff('server-id')).rejects.toThrow(ProviderError);
    });
  });

  describe('powerOn', () => {
    it('should call poweron action endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ task: {} }), { status: 202 }),
      );

      await provider.powerOn('server-id');

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toContain('/servers/server-id/action');
      const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
      expect(body.action).toBe('poweron');
    });
  });

  describe('validateToken', () => {
    it('should return true for valid token', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      const result = await provider.validateToken();
      expect(result).toBe(true);
    });

    it('should call Instance API with X-Auth-Token and project filter', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      await provider.validateToken();

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toContain('api.scaleway.com/instance/v1/zones/fr-par-1/servers');
      expect(url).toContain('per_page=1');
      expect(url).toContain('project=test-project-id');
      const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
      expect((headers.headers as Record<string, string>)['X-Auth-Token']).toBe('test-secret-key');
    });

    it('should throw ProviderError for invalid token', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
      );

      await expect(provider.validateToken()).rejects.toThrow(ProviderError);
    });
  });

  describe('status mapping', () => {
    const testCases: Array<{ scalewayState: string; expectedStatus: string }> = [
      { scalewayState: 'running', expectedStatus: 'running' },
      { scalewayState: 'stopped', expectedStatus: 'off' },
      { scalewayState: 'stopping', expectedStatus: 'stopping' },
      { scalewayState: 'starting', expectedStatus: 'starting' },
      { scalewayState: 'locked', expectedStatus: 'initializing' },
      { scalewayState: 'unknown-state', expectedStatus: 'initializing' },
    ];

    for (const { scalewayState, expectedStatus } of testCases) {
      it(`should map '${scalewayState}' to '${expectedStatus}'`, async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            server: createMockScalewayServer({ state: scalewayState }),
          }), { status: 200 }),
        );

        const result = await provider.getVM('server-id');
        expect(result!.status).toBe(expectedStatus);
      });
    }
  });

  describe('tag/label conversion', () => {
    it('should convert labels to tags in createVM', async () => {
      globalThis.fetch = createScalewayFetchMock();

      await provider.createVM({
        name: 'test',
        size: 'small',
        location: 'fr-par-1',
        userData: '',
        labels: { env: 'prod', team: 'backend' },
      });

      const createCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1]!;
      const body = JSON.parse((createCall[1] as RequestInit).body as string);
      expect(body.tags).toContain('env=prod');
      expect(body.tags).toContain('team=backend');
    });

    it('should convert tags back to labels in getVM', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockScalewayServer({
            tags: ['env=prod', 'team=backend', 'key=value=with=equals'],
          }),
        }), { status: 200 }),
      );

      const result = await provider.getVM('server-id');
      expect(result!.labels).toEqual({
        env: 'prod',
        team: 'backend',
        key: 'value=with=equals',
      });
    });

    it('should skip malformed tags without equals sign', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockScalewayServer({
            tags: ['valid=tag', 'no-equals', '=empty-key'],
          }),
        }), { status: 200 }),
      );

      const result = await provider.getVM('server-id');
      expect(result!.labels).toEqual({ valid: 'tag' });
    });
  });

  describe('network errors', () => {
    it('should wrap network errors in ProviderError', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

      await expect(provider.getVM('server-id')).rejects.toThrow(ProviderError);
    });
  });
});
