import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { ScalewayProvider } from '../../src/scaleway';
import { ProviderError } from '../../src/types';
import { createMockScalewayServer, createScalewayFetchMock } from '../fixtures/scaleway-mocks';
import { expectDefined, fetchCall, jsonBody } from './test-helpers';

describe('ScalewayProvider lifecycle', () => {
  let provider: ScalewayProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new ScalewayProvider('test-secret-key', 'test-project-id', 'fr-par-1');
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('deleteVM', () => {
    it('should call terminate action', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ task: {} }), { status: 202 }));
      globalThis.fetch = mockFetch;

      await provider.deleteVM('server-id');

      const url = fetchCall(mockFetch, 1).url;
      expect(url).toContain('/servers/server-id/action');
      const body = jsonBody(fetchCall(mockFetch, 1).init);
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
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Invalid state' }), { status: 400 }),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 204 }),
        );
      globalThis.fetch = mockFetch;

      await provider.deleteVM('server-id');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const deleteUrl = fetchCall(mockFetch, 2).url;
      expect(deleteUrl).toContain('/servers/server-id');
      expect(fetchCall(mockFetch, 2).init.method).toBe('DELETE');
    });

    it('should handle 404 on fallback DELETE (idempotent)', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
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
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

      await expect(provider.deleteVM('server-id')).rejects.toThrow(ProviderError);
    });

    it('should terminate a server in the zone where it is found', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'GET' && url.includes('/zones/fr-par-1/servers/server-id')) {
          return Promise.resolve(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));
        }
        if (method === 'GET' && url.includes('/zones/fr-par-2/servers/server-id')) {
          return Promise.resolve(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }));
        }
        if (method === 'POST' && url.includes('/zones/fr-par-2/servers/server-id/action')) {
          return Promise.resolve(new Response(JSON.stringify({ task: {} }), { status: 202 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ message: 'Unexpected URL' }), { status: 500 }));
      });
      globalThis.fetch = mockFetch;

      await provider.deleteVM('server-id');

      const actionUrl = fetchCall(mockFetch, 2).url;
      expect(actionUrl).toContain('/zones/fr-par-2/servers/server-id/action');
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
      const vm = expectDefined(result);
      expect(vm.id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(vm.status).toBe('running');
      expect(vm.ip).toBe('1.2.3.4');
      expect(vm.labels).toEqual({ node: 'n1', managed: 'sam' });
    });

    it('should return null if VM not found (404)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
      );

      const result = await provider.getVM('non-existent');
      expect(result).toBeNull();
    });

    it('should fail fast on malformed provider payloads', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ server: { id: 'server-id', name: 'missing-fields' } }), { status: 200 }),
      );

      await expect(provider.getVM('server-id')).rejects.toThrow(/response validation failed/);
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
      expect(expectDefined(result).ip).toBe('9.8.7.6');
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
      expect(expectDefined(result).ip).toBe('');
    });
  });

  describe('listVMs', () => {
    it('should return list of VMs', async () => {
      const servers = [
        createMockScalewayServer({ id: 'id-1', name: 's1', tags: ['managed=sam'] }),
        createMockScalewayServer({ id: 'id-2', name: 's2', state: 'stopped', tags: ['managed=sam'] }),
      ];
      globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(
        new Response(JSON.stringify({ servers: url.includes('/zones/fr-par-1/') ? servers : [] }), { status: 200 }),
      ));

      const result = await provider.listVMs();
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('id-1');
      expect(result[1]?.id).toBe('id-2');
      expect(result[1]?.status).toBe('off');
    });

    it('should pass label filters as tags query params', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      ));

      await provider.listVMs({ 'managed-by': 'simple-agent-manager', node: 'n1' });

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 0).url;
      expect(url).toContain('tags=');
      expect(decodeURIComponent(url)).toContain('managed-by=simple-agent-manager');
      expect(decodeURIComponent(url)).toContain('node=n1');
    });

    it('should return empty array when no VMs match', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      ));

      const result = await provider.listVMs({ nonexistent: 'label' });
      expect(result).toEqual([]);
    });

    it('should not include query params when no labels provided', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      ));

      await provider.listVMs();

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 0).url;
      expect(url).toMatch(/\/servers$/);
    });
  });

  describe('powerOff', () => {
    it('should call poweroff action endpoint', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ task: {} }), { status: 202 }));

      await provider.powerOff('server-id');

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 1).url;
      expect(url).toContain('/servers/server-id/action');
      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 1).init);
      expect(body.action).toBe('poweroff');
    });

    it('should throw ProviderError on failure', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
        .mockResolvedValueOnce(new Response('Error', { status: 500 }));

      await expect(provider.powerOff('server-id')).rejects.toThrow(ProviderError);
    });
  });

  describe('powerOn', () => {
    it('should call poweron action endpoint', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: createMockScalewayServer() }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ task: {} }), { status: 202 }));

      await provider.powerOn('server-id');

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 1).url;
      expect(url).toContain('/servers/server-id/action');
      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 1).init);
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

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 0).url;
      expect(url).toContain('api.scaleway.com/instance/v1/zones/fr-par-1/servers');
      expect(url).toContain('per_page=1');
      expect(url).toContain('project=test-project-id');
      const headers = fetchCall(fetch as ReturnType<typeof vi.fn>, 0).init;
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
        expect(expectDefined(result).status).toBe(expectedStatus);
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

      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 1).init);
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
      expect(expectDefined(result).labels).toEqual({
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
      expect(expectDefined(result).labels).toEqual({ valid: 'tag' });
    });
  });

  describe('network errors', () => {
    it('should wrap network errors in ProviderError', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

      await expect(provider.getVM('server-id')).rejects.toThrow(ProviderError);
    });
  });
});
