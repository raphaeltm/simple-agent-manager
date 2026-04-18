import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider } from '../../src/hetzner';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';
import { createMockServer } from '../fixtures/hetzner-mocks';

describe('HetznerProvider', () => {
  let provider: HetznerProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new HetznerProvider('test-token', 'fsn1');
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  describe('constructor and properties', () => {
    it('should set provider name to hetzner', () => {
      expect(provider.name).toBe('hetzner');
    });

    it('should expose locations', () => {
      expect(provider.locations).toContain('fsn1');
      expect(provider.locations).toContain('nbg1');
      expect(provider.locations.length).toBeGreaterThan(0);
    });

    it('should expose sizes for all tiers', () => {
      expect(provider.sizes.small).toBeDefined();
      expect(provider.sizes.medium).toBeDefined();
      expect(provider.sizes.large).toBeDefined();
    });

    it('should use default datacenter if not provided', () => {
      const p = new HetznerProvider('test');
      expect(p.name).toBe('hetzner');
    });
  });

  describe('locationMetadata', () => {
    it('should have metadata for all 5 locations', () => {
      expect(Object.keys(provider.locationMetadata)).toHaveLength(5);
    });

    it('should have correct metadata for fsn1', () => {
      expect(provider.locationMetadata['fsn1']).toEqual({ name: 'Falkenstein', country: 'DE' });
    });

    it('should have correct metadata for nbg1', () => {
      expect(provider.locationMetadata['nbg1']).toEqual({ name: 'Nuremberg', country: 'DE' });
    });

    it('should have correct metadata for hel1', () => {
      expect(provider.locationMetadata['hel1']).toEqual({ name: 'Helsinki', country: 'FI' });
    });

    it('should have correct metadata for ash', () => {
      expect(provider.locationMetadata['ash']).toEqual({ name: 'Ashburn', country: 'US' });
    });

    it('should have correct metadata for hil', () => {
      expect(provider.locationMetadata['hil']).toEqual({ name: 'Hillsboro', country: 'US' });
    });

    it('should have metadata entries matching the locations array', () => {
      for (const loc of provider.locations) {
        expect(provider.locationMetadata[loc]).toBeDefined();
      }
    });
  });

  describe('defaultLocation', () => {
    it('should default to constructor datacenter parameter', () => {
      const p = new HetznerProvider('test-token', 'hel1');
      expect(p.defaultLocation).toBe('hel1');
    });

    it('should default to fsn1 when no datacenter is provided', () => {
      const p = new HetznerProvider('test-token');
      expect(p.defaultLocation).toBe('fsn1');
    });
  });

  describe('sizes', () => {
    it('should return correct small size config', () => {
      expect(provider.sizes.small).toEqual({
        type: 'cx23',
        price: '€3.99/mo',
        vcpu: 2,
        ramGb: 4,
        storageGb: 40,
      });
    });

    it('should return correct medium size config', () => {
      expect(provider.sizes.medium).toEqual({
        type: 'cx33',
        price: '€7.49/mo',
        vcpu: 4,
        ramGb: 8,
        storageGb: 80,
      });
    });

    it('should return correct large size config', () => {
      expect(provider.sizes.large).toEqual({
        type: 'cx43',
        price: '€14.49/mo',
        vcpu: 8,
        ramGb: 16,
        storageGb: 160,
      });
    });
  });

  describe('VMConfig has no secrets', () => {
    it('should not accept secret fields in VMConfig type', () => {
      // This is a compile-time check. If VMConfig had authPassword, apiToken, etc.,
      // this config would fail typechecking because those fields don't exist.
      const config: VMConfig = {
        name: 'test-server',
        size: 'medium',
        location: 'fsn1',
        userData: '#cloud-config\npackages:\n  - docker.io',
      };
      expect(config).not.toHaveProperty('authPassword');
      expect(config).not.toHaveProperty('apiToken');
      expect(config).not.toHaveProperty('baseDomain');
      expect(config).not.toHaveProperty('apiUrl');
      expect(config).not.toHaveProperty('githubToken');
      expect(config).not.toHaveProperty('workspaceId');
      expect(config).not.toHaveProperty('repoUrl');
    });
  });

  describe('no generateCloudInit method', () => {
    it('should not have generateCloudInit method', () => {
      expect((provider as Record<string, unknown>)['generateCloudInit']).toBeUndefined();
    });
  });

  describe('createVM', () => {
    const vmConfig: VMConfig = {
      name: 'test-server',
      size: 'medium',
      location: 'fsn1',
      userData: '#cloud-config\npackages:\n  - docker.io',
      labels: { node: 'node-123', managed: 'simple-agent-manager' },
    };

    it('should call Hetzner API with correct parameters', async () => {
      const mockResponse = {
        server: createMockServer({ status: 'initializing', labels: { node: 'node-123' } }),
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const result = await provider.createVM(vmConfig);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.hetzner.cloud/v1/servers',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );

      // Verify the body contains the correct fields
      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const body = JSON.parse((callArgs[1] as RequestInit).body as string);
      expect(body.name).toBe('test-server');
      expect(body.server_type).toBe('cx33');
      expect(body.user_data).toBe(vmConfig.userData);
      expect(body.labels).toEqual(vmConfig.labels);
      expect(body.start_after_create).toBe(true);

      expect(result).toEqual({
        id: '12345',
        name: 'test-server',
        ip: '1.2.3.4',
        status: 'initializing',
        serverType: 'cx33',
        createdAt: '2024-01-24T12:00:00Z',
        labels: { node: 'node-123' },
      });
    });

    it('should throw ProviderError on API failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 403 }),
      );

      await expect(provider.createVM(vmConfig)).rejects.toThrow(ProviderError);
    });

    it('should use docker-ce marketplace image by default', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockServer({ id: 1, name: 'test', status: 'initializing' }),
        }), { status: 200 }),
      );

      await provider.createVM(vmConfig);

      const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
      expect(body.image).toBe('docker-ce');
    });

    it('should honor explicit image override (e.g. rollback to ubuntu-24.04)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockServer({ id: 1, name: 'test', status: 'initializing' }),
        }), { status: 200 }),
      );

      await provider.createVM({ ...vmConfig, image: 'ubuntu-24.04' });

      const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
      expect(body.image).toBe('ubuntu-24.04');
    });

    it('should retry same location after delay on 412 before trying other locations', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'error during placement' } }),
            { status: 412 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ server: createMockServer({ status: 'initializing' }) }),
            { status: 200 },
          ),
        );

      globalThis.fetch = mockFetch;

      const promise = provider.createVM(vmConfig);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.id).toBe('12345');

      // Both calls should use the same primary location (fsn1)
      const firstBody = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
      const secondBody = JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string);
      expect(firstBody.location).toBe('fsn1');
      expect(secondBody.location).toBe('fsn1');
    });

    it('should wait the full delay before retrying the primary location', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'error during placement' } }),
            { status: 412 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ server: createMockServer({ status: 'initializing' }) }),
            { status: 200 },
          ),
        );

      globalThis.fetch = mockFetch;

      const promise = provider.createVM(vmConfig);

      // Drain microtasks so first fetch completes, but don't advance time
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance just under the delay — second call must NOT have happened
      await vi.advanceTimersByTimeAsync(2_999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Cross the threshold
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should fall back to other locations after primary retry fails', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'error during placement' } }),
            { status: 412 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'error during placement' } }),
            { status: 412 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ server: createMockServer({ status: 'initializing' }) }),
            { status: 200 },
          ),
        );

      globalThis.fetch = mockFetch;

      const promise = provider.createVM(vmConfig);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.id).toBe('12345');

      // First two calls should be primary, third should be different
      const firstBody = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
      const secondBody = JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string);
      const thirdBody = JSON.parse((mockFetch.mock.calls[2]![1] as RequestInit).body as string);
      expect(firstBody.location).toBe('fsn1');
      expect(secondBody.location).toBe('fsn1');
      expect(thirdBody.location).not.toBe('fsn1');
    });

    it('should throw after all locations exhausted on 412', async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'error during placement' } }),
          { status: 412 },
        ),
      );

      const promise = provider.createVM(vmConfig).catch((err) => err);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toBeInstanceOf(ProviderError);
      // primary (1) + primary retry (2) + 4 fallback locations = 6
      expect(fetch).toHaveBeenCalledTimes(6);
    });

    it('should never retry the primary location in the fallback phase', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'error during placement' } }),
          { status: 412 },
        ),
      );
      globalThis.fetch = mockFetch;

      const promise = provider.createVM(vmConfig).catch(() => {});
      await vi.runAllTimersAsync();
      await promise;

      // Calls after the first two (primary + primary retry) should not include fsn1
      const fallbackLocations = mockFetch.mock.calls.slice(2).map(
        (call) => JSON.parse((call[1] as RequestInit).body as string).location as string,
      );
      expect(fallbackLocations).not.toContain('fsn1');
    });

    it('should not retry on non-412 errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Quota exceeded' } }),
          { status: 403 },
        ),
      );

      await expect(provider.createVM(vmConfig)).rejects.toThrow(ProviderError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on network-level errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

      await expect(provider.createVM(vmConfig)).rejects.toThrow(ProviderError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should try primary location first', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ server: createMockServer({ status: 'initializing' }) }),
          { status: 200 },
        ),
      );

      await provider.createVM(vmConfig);

      const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
      expect(body.location).toBe('fsn1');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should use constructor datacenter when config.location is not set', async () => {
      const providerWithDc = new HetznerProvider('test-token', 'hel1');
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ server: createMockServer({ status: 'initializing' }) }),
          { status: 200 },
        ),
      );

      await providerWithDc.createVM({ name: 'test', size: 'small', userData: '' });

      const body = JSON.parse(((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
      expect(body.location).toBe('hel1');
    });

    it('should only retry primary when fallback is disabled', async () => {
      vi.useFakeTimers();
      const noFallbackProvider = new HetznerProvider('test-token', 'fsn1', undefined, false);
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'error during placement' } }),
          { status: 412 },
        ),
      );

      const promise = noFallbackProvider.createVM(vmConfig).catch((err) => err);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toBeInstanceOf(ProviderError);
      // primary (1) + primary retry (2), no fallback locations
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteVM', () => {
    it('should call Hetzner API to delete server', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      await provider.deleteVM('12345');

      expect(fetch).toHaveBeenCalledWith(
        'https://api.hetzner.cloud/v1/servers/12345',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    });

    it('should not throw on 404 (idempotent)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
      );

      await expect(provider.deleteVM('12345')).resolves.not.toThrow();
    });

    it('should throw ProviderError on other errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );

      await expect(provider.deleteVM('12345')).rejects.toThrow(ProviderError);
    });
  });

  describe('getVM', () => {
    it('should return VM instance if found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockServer({ name: 'test', server_type: { name: 'cx22' }, labels: { node: 'n1' } }),
        }), { status: 200 }),
      );

      const result = await provider.getVM('12345');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('12345');
      expect(result!.status).toBe('running');
    });

    it('should return null if VM not found (404)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
      );

      const result = await provider.getVM('99999');
      expect(result).toBeNull();
    });
  });

  describe('listVMs', () => {
    const mockServers = {
      servers: [
        createMockServer({ id: 1, name: 's1', public_net: { ipv4: { ip: '1.1.1.1' } }, server_type: { name: 'cx23' }, created: '2024-01-01T00:00:00Z', labels: { managed: 'sam' } }),
        createMockServer({ id: 2, name: 's2', status: 'off', public_net: { ipv4: { ip: '2.2.2.2' } }, server_type: { name: 'cx33' }, created: '2024-01-02T00:00:00Z', labels: { managed: 'sam' } }),
      ],
    };

    it('should return list of VMs without labels', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockServers), { status: 200 }),
      );

      const result = await provider.listVMs();
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('1');
      expect(result[1]!.id).toBe('2');
    });

    it('should pass label filters as label_selector', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      await provider.listVMs({ 'managed-by': 'simple-agent-manager', node: 'n1' });

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toContain('label_selector=');
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
  });

  describe('powerOff', () => {
    it('should call poweroff action endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

      await provider.powerOff('12345');

      expect(fetch).toHaveBeenCalledWith(
        'https://api.hetzner.cloud/v1/servers/12345/actions/poweroff',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should throw ProviderError on failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Error', { status: 500 }),
      );

      await expect(provider.powerOff('12345')).rejects.toThrow(ProviderError);
    });
  });

  describe('powerOn', () => {
    it('should call poweron action endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

      await provider.powerOn('12345');

      expect(fetch).toHaveBeenCalledWith(
        'https://api.hetzner.cloud/v1/servers/12345/actions/poweron',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('validateToken', () => {
    it('should return true for valid token', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ datacenters: [] }), { status: 200 }),
      );

      const result = await provider.validateToken();
      expect(result).toBe(true);
    });

    it('should throw ProviderError for invalid token', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
      );

      await expect(provider.validateToken()).rejects.toThrow(ProviderError);
    });
  });
});
