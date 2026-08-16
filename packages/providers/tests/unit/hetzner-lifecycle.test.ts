import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HETZNER_MAX_LIST_PAGES, HetznerProvider } from '../../src/hetzner';
import { ProviderError } from '../../src/types';
import { createMockServer } from '../fixtures/hetzner-mocks';
import { expectDefined, fetchCall, testIpv4 } from './test-helpers';

describe('HetznerProvider lifecycle', () => {
  let provider: HetznerProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new HetznerProvider('test-token', 'fsn1');
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
      const vm = expectDefined(result);
      expect(vm.id).toBe('12345');
      expect(vm.status).toBe('running');
    });

    it('should return null if VM not found (404)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
      );

      const result = await provider.getVM('99999');
      expect(result).toBeNull();
    });

    it('should fail fast on malformed provider payloads', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ server: { id: 12345, name: 'missing-fields' } }), { status: 200 }),
      );

      await expect(provider.getVM('12345')).rejects.toThrow(/response validation failed/);
    });
  });

  describe('listVMs', () => {
    const mockServers = {
      servers: [
        createMockServer({ id: 1, name: 's1', public_net: { ipv4: { ip: testIpv4(1, 1, 1, 1) } }, server_type: { name: 'cx23' }, created: '2024-01-01T00:00:00Z', labels: { managed: 'sam' } }),
        createMockServer({ id: 2, name: 's2', status: 'off', public_net: { ipv4: { ip: testIpv4(2, 2, 2, 2) } }, server_type: { name: 'cx33' }, created: '2024-01-02T00:00:00Z', labels: { managed: 'sam' } }),
      ],
    };

    it('should return list of VMs without labels', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockServers), { status: 200 }),
      );

      const result = await provider.listVMs();
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('1');
      expect(result[1]?.id).toBe('2');
    });

    it('should pass label filters as label_selector', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      await provider.listVMs({
        managed: 'simple-agent-manager',
        env: 'production',
        installation: '0123456789abcdef0123456789abcdef',
      });

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 0).url;
      expect(url).toContain('label_selector=');
      expect(decodeURIComponent(url)).toContain('managed=simple-agent-manager');
      expect(decodeURIComponent(url)).toContain('env=production');
      expect(decodeURIComponent(url)).toContain('installation=0123456789abcdef0123456789abcdef');
    });


    it('follows Hetzner server pagination and preserves label filters', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [createMockServer({ id: 1, name: 'page-1' })],
          meta: { pagination: { page: 1, per_page: 50, previous_page: null, next_page: 2, last_page: 2, total_entries: 2 } },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [createMockServer({ id: 2, name: 'page-2' })],
          meta: { pagination: { page: 2, per_page: 50, previous_page: 1, next_page: null, last_page: 2, total_entries: 2 } },
        }), { status: 200 }));
      globalThis.fetch = mockFetch;

      const result = await provider.listVMs({ 'managed-by': 'simple-agent-manager', node: 'n1' });

      expect(result.map((vm) => vm.id)).toEqual(['1', '2']);
      const firstUrl = new URL(fetchCall(mockFetch, 0).url);
      const secondUrl = new URL(fetchCall(mockFetch, 1).url);
      expect(firstUrl.searchParams.get('page')).toBeNull();
      expect(firstUrl.searchParams.get('label_selector')).toBe('managed-by=simple-agent-manager,node=n1');
      expect(secondUrl.searchParams.get('page')).toBe('2');
      expect(secondUrl.searchParams.get('label_selector')).toBe('managed-by=simple-agent-manager,node=n1');
    });

    it('continues after an empty Hetzner server page when next_page is present', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [],
          meta: { pagination: { page: 1, per_page: 50, previous_page: null, next_page: 2, last_page: 2, total_entries: 2 } },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [createMockServer({ id: 3, name: 'later' })],
          meta: { pagination: { page: 2, per_page: 50, previous_page: 1, next_page: null, last_page: 2, total_entries: 2 } },
        }), { status: 200 }));

      const result = await provider.listVMs();
      expect(result.map((vm) => vm.id)).toEqual(['3']);
    });

    it('collects VMs across three or more Hetzner server pages', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [createMockServer({ id: 1, name: 'page-1' })],
          meta: { pagination: { page: 1, next_page: 2 } },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [createMockServer({ id: 2, name: 'page-2' })],
          meta: { pagination: { page: 2, next_page: 3 } },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [createMockServer({ id: 3, name: 'page-3' })],
          meta: { pagination: { page: 3, next_page: null } },
        }), { status: 200 }));

      const result = await provider.listVMs();
      expect(result.map((vm) => vm.id)).toEqual(['1', '2', '3']);
    });

    it('rejects repeated Hetzner server pages instead of looping', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          servers: [],
          meta: { pagination: { page: 1, next_page: 1 } },
        }), { status: 200 }),
      );

      await expect(provider.listVMs()).rejects.toThrow(/repeated page 1/);
    });

    it('rejects malformed Hetzner server pagination tokens', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          servers: [],
          meta: { pagination: { page: 1, next_page: '2' } },
        }), { status: 200 }),
      );

      await expect(provider.listVMs()).rejects.toThrow(/next_page/);
    });

    it.each([0, -1])('rejects next_page %d as malformed', async (nextPage) => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          servers: [],
          meta: { pagination: { page: 1, next_page: nextPage } },
        }), { status: 200 }),
      );

      await expect(provider.listVMs()).rejects.toThrow(/next_page/);
    });

    it('propagates later Hetzner server page errors', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          servers: [],
          meta: { pagination: { page: 1, per_page: 50, previous_page: null, next_page: 2, last_page: 2, total_entries: 2 } },
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));

      await expect(provider.listVMs()).rejects.toMatchObject({ statusCode: 500 });
    });

    it('fails closed when Hetzner server pagination exceeds the max-page guard', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const page = Number(new URL(url).searchParams.get('page') || '1');
        return new Response(JSON.stringify({
          servers: [],
          meta: { pagination: { page, next_page: page + 1 } },
        }), { status: 200 });
      });

      await expect(provider.listVMs()).rejects.toThrow(new RegExp(`exceeded ${DEFAULT_HETZNER_MAX_LIST_PAGES} pages`));
      expect(fetch).toHaveBeenCalledTimes(DEFAULT_HETZNER_MAX_LIST_PAGES);
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
