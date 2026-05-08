import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider } from '../../src/hetzner';
import { ProviderError } from '../../src/types';
import { createMockServer } from '../fixtures/hetzner-mocks';
import { expectDefined, fetchCall } from './test-helpers';

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
      expect(result[0]?.id).toBe('1');
      expect(result[1]?.id).toBe('2');
    });

    it('should pass label filters as label_selector', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );

      await provider.listVMs({ 'managed-by': 'simple-agent-manager', node: 'n1' });

      const url = fetchCall(fetch as ReturnType<typeof vi.fn>, 0).url;
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
