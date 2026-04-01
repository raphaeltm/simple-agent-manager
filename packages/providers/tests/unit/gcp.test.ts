import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';

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
        networkInterfaces: [{ accessConfigs: [{ natIP: '35.1.2.3' }] }],
        labels: { 'sam-managed': 'true' },
      };

      let capturedBody: string | undefined;
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(async () => {
          // ensureFirewallRule — 409 already exists
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
      expect(result.ip).toBe('35.1.2.3');
      expect(result.status).toBe('running');

      // Verify request body structure
      const body = JSON.parse(capturedBody!);
      expect(body.name).toBe('node-abc');
      expect(body.machineType).toContain('e2-standard-2');
      expect(body.labels).toHaveProperty('sam-managed', 'true');
      expect(body.labels).toHaveProperty('node', 'test-node-id');
      expect(body.metadata.items[0].key).toBe('user-data');
      expect(body.metadata.items[0].value).toBe('#cloud-config\nruncmd: []');
    });

    it('should use Authorization header with token from tokenProvider', async () => {
      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(async () => {
          // ensureFirewallRule — 409 already exists
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
          networkInterfaces: [{ accessConfigs: [{ natIP: '1.2.3.4' }] }],
        })));

      await provider.createVM({ name: 'test', size: 'small', location: 'us-central1-a', userData: '' });

      expect(capturedHeaders).toBeDefined();
      expect((capturedHeaders as Record<string, string>)['Authorization']).toBe('Bearer test-gcp-token');
    });
  });

  describe('deleteVM', () => {
    it('should be idempotent when VM is not found', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        throw new ProviderError('gcp', 404, 'Not found');
      });

      // Should not throw — idempotent delete
      await expect(provider.deleteVM('nonexistent')).resolves.toBeUndefined();
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
