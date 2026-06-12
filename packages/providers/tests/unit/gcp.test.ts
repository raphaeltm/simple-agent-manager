import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GCP_APP_ROUTE_PORTS,
  DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
  DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
  GcpProvider,
} from '../../src/gcp';
import type { VMConfig } from '../../src/types';
import { expectDefined, fetchCall, jsonBody, testCidr, testIpv4 } from './test-helpers';

describe('GcpProvider', () => {
  let provider: GcpProvider;
  const originalFetch = globalThis.fetch;
  const mockTokenProvider = vi.fn().mockResolvedValue('test-gcp-token');

  beforeEach(() => {
    provider = new GcpProvider('test-project', mockTokenProvider, 'us-central1-a');
    vi.resetAllMocks();
    mockTokenProvider.mockResolvedValue('test-gcp-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor and properties', () => {
    it('should set provider name to gcp', () => {
      expect(provider.name).toBe('gcp');
    });

    it('should expose 8 locations', () => {
      expect(provider.locations).toContain('us-central1-a');
      expect(provider.locations).toContain('europe-west3-a');
      expect(provider.locations).toContain('asia-northeast1-a');
      expect(provider.locations.length).toBe(8);
    });

    it('should expose sizes for all tiers', () => {
      expect(provider.sizes.small).toBeDefined();
      expect(provider.sizes.medium).toBeDefined();
      expect(provider.sizes.large).toBeDefined();
    });

    it('should use default zone us-central1-a when not provided', () => {
      const p = new GcpProvider('proj', mockTokenProvider);
      expect(p.defaultLocation).toBe('us-central1-a');
    });

    it('should use custom default zone when provided', () => {
      const p = new GcpProvider('proj', mockTokenProvider, 'europe-west3-a');
      expect(p.defaultLocation).toBe('europe-west3-a');
    });
  });

  describe('locationMetadata', () => {
    it('should have metadata for all 8 zones', () => {
      expect(Object.keys(provider.locationMetadata)).toHaveLength(8);
    });

    it('should have correct metadata for us-central1-a', () => {
      expect(provider.locationMetadata['us-central1-a']).toEqual({ name: 'Iowa', country: 'US' });
    });

    it('should have correct metadata for europe-west3-a', () => {
      expect(provider.locationMetadata['europe-west3-a']).toEqual({ name: 'Frankfurt', country: 'DE' });
    });

    it('should have correct metadata for asia-northeast1-a', () => {
      expect(provider.locationMetadata['asia-northeast1-a']).toEqual({ name: 'Tokyo', country: 'JP' });
    });
  });

  describe('sizes', () => {
    it('should map small to e2-medium', () => {
      expect(provider.sizes.small.type).toBe('e2-medium');
      expect(provider.sizes.small.vcpu).toBe(1);
      expect(provider.sizes.small.ramGb).toBe(4);
    });

    it('should map medium to e2-standard-2', () => {
      expect(provider.sizes.medium.type).toBe('e2-standard-2');
      expect(provider.sizes.medium.vcpu).toBe(2);
      expect(provider.sizes.medium.ramGb).toBe(8);
    });

    it('should map large to e2-standard-4', () => {
      expect(provider.sizes.large.type).toBe('e2-standard-4');
      expect(provider.sizes.large.vcpu).toBe(4);
      expect(provider.sizes.large.ramGb).toBe(16);
    });
  });

  describe('createVM', () => {
    it('should call Compute Engine API with correct body', async () => {
      const mockInstance = {
        id: '12345',
        name: 'node-abc',
        status: 'RUNNING',
        machineType: 'zones/us-central1-a/machineTypes/e2-standard-2',
        creationTimestamp: '2026-03-18T00:00:00Z',
        networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(35, 1, 2, 3) }] }],
        labels: { 'sam-managed': 'true' },
      };

      let capturedBody: string | undefined;
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(async () => {
          // ensure agent firewall rule — 409 already exists
          return new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 });
        })
        .mockImplementationOnce(async () => {
          // ensure app-route firewall rule — 409 already exists
          return new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 });
        })
        .mockImplementationOnce(async (url: string, init: RequestInit) => {
          capturedBody = init.body as string;
          return new Response(JSON.stringify({ name: 'op-123', status: 'DONE' }));
        })
        .mockImplementationOnce(async () => {
          // pollOperation check
          return new Response(JSON.stringify({ status: 'DONE' }));
        })
        .mockImplementationOnce(async () => {
          // getVM after create
          return new Response(JSON.stringify(mockInstance));
        });

      const config: VMConfig = {
        name: 'node-abc',
        size: 'medium',
        location: 'us-central1-a',
        userData: '#cloud-config\nruncmd: []',
        labels: { node: 'test-node-id' },
      };

      const result = await provider.createVM(config);

      expect(result.name).toBe('node-abc');
      expect(result.ip).toBe(testIpv4(35, 1, 2, 3));
      expect(result.status).toBe('running');

      // Verify request body structure
      const body = JSON.parse(expectDefined(capturedBody));
      expect(body.name).toBe('node-abc');
      expect(body.machineType).toContain('e2-standard-2');
      expect(body.labels).toHaveProperty('sam-managed', 'true');
      expect(body.labels).toHaveProperty('node', 'test-node-id');
      expect(body.tags.items).toEqual(['sam-agent']);
      expect(body.metadata.items[0].key).toBe('user-data');
      expect(body.metadata.items[0].value).toBe('#cloud-config\nruncmd: []');
    });

    it('adds the public app-route network tag only to deployment-role VMs', async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 }))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 }))
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          capturedBody = init.body as string;
          return new Response(JSON.stringify({ name: 'op-123', status: 'DONE' }));
        })
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({
          id: '1',
          name: 'vm',
          status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/e2-medium',
          creationTimestamp: '2026-03-18T00:00:00Z',
          networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(1, 2, 3, 4) }] }],
        })));

      await provider.createVM({
        name: 'deployment-vm',
        size: 'small',
        location: 'us-central1-a',
        userData: '',
        labels: { role: 'deployment' },
      });

      const body = JSON.parse(expectDefined(capturedBody));
      expect(body.tags.items).toEqual(['sam-agent', 'sam-deployment-app-routes']);
    });

    it('should use Authorization header with token from tokenProvider', async () => {
      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(async () => {
          // ensure agent firewall rule — 409 already exists
          return new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 });
        })
        .mockImplementationOnce(async () => {
          // ensure app-route firewall rule — 409 already exists
          return new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 });
        })
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          capturedHeaders = init.headers;
          return new Response(JSON.stringify({ name: 'op-1', status: 'DONE' }));
        })
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({
          id: '1', name: 'vm', status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/e2-medium',
          creationTimestamp: '2026-03-18T00:00:00Z',
          networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(1, 2, 3, 4) }] }],
        })));

      await provider.createVM({ name: 'test', size: 'small', location: 'us-central1-a', userData: '' });

      expect(capturedHeaders).toBeDefined();
      expect((capturedHeaders as Record<string, string>)['Authorization']).toBe('Bearer test-gcp-token');
    });

    it('should use configured firewall source ranges and agent ports', async () => {
      const configuredProvider = new GcpProvider(
        'test-project',
        mockTokenProvider,
        'us-central1-a',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [testCidr(10, 0, 0, 0, 8)],
        ['9443'],
        [testCidr(0, 0, 0, 0, 0)],
        ['80', '443'],
      );
      const mockFetch = vi.fn()
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'firewall-op', status: 'PENDING' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'app-firewall-op', status: 'PENDING' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'create-op', status: 'PENDING' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({
          id: '1',
          name: 'vm',
          status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/e2-medium',
          creationTimestamp: '2026-03-18T00:00:00Z',
          networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(1, 2, 3, 4) }] }],
        })));
      globalThis.fetch = mockFetch;

      await configuredProvider.createVM({
        name: 'vm',
        size: 'small',
        location: 'us-central1-a',
        userData: '',
      });

      const firewallBody = jsonBody(fetchCall(mockFetch, 0).init);
      expect(firewallBody.sourceRanges).toEqual([testCidr(10, 0, 0, 0, 8)]);
      expect(firewallBody.allowed).toEqual([{ IPProtocol: 'tcp', ports: ['9443'] }]);
      expect(firewallBody.targetTags).toEqual(['sam-agent']);
      const appRouteFirewallBody = jsonBody(fetchCall(mockFetch, 2).init);
      expect(appRouteFirewallBody.sourceRanges).toEqual([testCidr(0, 0, 0, 0, 0)]);
      expect(appRouteFirewallBody.allowed).toEqual([{ IPProtocol: 'tcp', ports: ['80', '443'] }]);
      expect(appRouteFirewallBody.targetTags).toEqual(['sam-deployment-app-routes']);
    });

    it('should default firewall source ranges to Cloudflare IPv4 ranges and app routes to public HTTP/HTTPS', async () => {
      const mockFetch = vi.fn()
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'firewall-op', status: 'PENDING' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'app-firewall-op', status: 'PENDING' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'create-op', status: 'PENDING' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ status: 'DONE' })))
        .mockImplementationOnce(async () => new Response(JSON.stringify({
          id: '1',
          name: 'vm',
          status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/e2-medium',
          creationTimestamp: '2026-03-18T00:00:00Z',
          networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(1, 2, 3, 4) }] }],
        })));
      globalThis.fetch = mockFetch;

      await provider.createVM({
        name: 'vm',
        size: 'small',
        location: 'us-central1-a',
        userData: '',
      });

      const firewallBody = jsonBody(fetchCall(mockFetch, 0).init);
      expect(firewallBody.sourceRanges).toEqual([...DEFAULT_GCP_FIREWALL_SOURCE_RANGES]);
      expect(firewallBody.sourceRanges).toContain(testCidr(173, 245, 48, 0, 20));
      expect(firewallBody.sourceRanges).not.toContain(testCidr(0, 0, 0, 0, 0));
      const appRouteFirewallBody = jsonBody(fetchCall(mockFetch, 2).init);
      expect(appRouteFirewallBody.sourceRanges).toEqual([...DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES]);
      expect(appRouteFirewallBody.allowed).toEqual([{ IPProtocol: 'tcp', ports: [...DEFAULT_GCP_APP_ROUTE_PORTS] }]);
      expect(appRouteFirewallBody.targetTags).toEqual(['sam-deployment-app-routes']);
    });
  });

  describe('deleteVM', () => {
    it('should be idempotent when VM is not found', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/aggregated/instances')) {
          return new Response(JSON.stringify({ items: {} }));
        }
        return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      });

      // Should not throw — idempotent delete
      await expect(provider.deleteVM('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('listVMs', () => {
    it('should tolerate explicit unavailable or missing zones', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/zones/us-central1-a/')) {
          return new Response(JSON.stringify({
            items: [{
              id: '1',
              name: 'vm-1',
              status: 'RUNNING',
              machineType: 'zones/us-central1-a/machineTypes/e2-medium',
              creationTimestamp: '2026-03-18T00:00:00Z',
              networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(1, 2, 3, 4) }] }],
              labels: { 'sam-managed': 'true' },
            }],
          }));
        }
        if (url.includes('/zones/us-east1-b/')) {
          return new Response(JSON.stringify({ error: { message: 'Zone unavailable' } }), { status: 503 });
        }
        return new Response(JSON.stringify({ error: { message: 'Zone not found' } }), { status: 404 });
      });

      const result = await provider.listVMs();

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('1');
    });

    it('should fail fast on permission failures', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Permission denied' } }), { status: 403 }),
      );

      await expect(provider.listVMs()).rejects.toThrow(/zone us-central1-a list failed/);
    });

    it('should fail fast on malformed list payloads', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [{ id: 'missing-required-fields' }] })),
      );

      await expect(provider.listVMs()).rejects.toThrow(/response validation failed/);
    });
  });

  describe('findInstanceByIdOrName', () => {
    it('should surface aggregated-list failures after zonal name misses', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/aggregated/instances')) {
          return new Response(JSON.stringify({ error: { message: 'Permission denied' } }), { status: 403 });
        }
        return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      });

      await expect(provider.getVM('numeric-id')).rejects.toThrow(/aggregated instance lookup failed/);
    });
  });

  describe('validateToken', () => {
    it('should make a lightweight API call to validate credentials', async () => {
      let capturedUrl: string | undefined;
      globalThis.fetch = vi.fn().mockImplementationOnce(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ name: 'e2-standard-2' }));
      });

      const result = await provider.validateToken();

      expect(result).toBe(true);
      expect(capturedUrl).toContain('/machineTypes/e2-standard-2');
      expect(mockTokenProvider).toHaveBeenCalled();
    });
  });

  describe('status mapping', () => {
    const makeInstance = (status: string) => ({
      id: '1',
      name: 'test',
      status,
      machineType: 'zones/us-central1-a/machineTypes/e2-standard-2',
      creationTimestamp: '2026-03-18T00:00:00Z',
      networkInterfaces: [],
    });

    it.each([
      ['PROVISIONING', 'initializing'],
      ['STAGING', 'initializing'],
      ['RUNNING', 'running'],
      ['STOPPING', 'stopping'],
      ['STOPPED', 'off'],
      ['TERMINATED', 'off'],
      ['SUSPENDING', 'off'],
      ['SUSPENDED', 'off'],
      ['UNKNOWN', 'initializing'],
    ])('should map GCP status %s to %s', async (gcpStatus, expectedStatus) => {
      // Use getVM which maps status internally
      globalThis.fetch = vi.fn().mockImplementationOnce(async () => {
        return new Response(JSON.stringify(makeInstance(gcpStatus)));
      });

      const result = await provider.getVM('test');
      expect(result?.status).toBe(expectedStatus);
    });
  });
});
