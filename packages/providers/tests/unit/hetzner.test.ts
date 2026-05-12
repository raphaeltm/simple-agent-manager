import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider, isTransientCapacityError } from '../../src/hetzner';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';
import { createMockServer } from '../fixtures/hetzner-mocks';
import { fetchCall, jsonBody, testIpv4 } from './test-helpers';

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
      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 0).init);
      expect(body.name).toBe('test-server');
      expect(body.server_type).toBe('cx33');
      expect(body.user_data).toBe(vmConfig.userData);
      expect(body.labels).toEqual(vmConfig.labels);
      expect(body.start_after_create).toBe(true);

      expect(result).toEqual({
        id: '12345',
        name: 'test-server',
        ip: testIpv4(1, 2, 3, 4),
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

      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 0).init);
      expect(body.image).toBe('docker-ce');
    });

    it('should honor explicit image override (e.g. rollback to ubuntu-24.04)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          server: createMockServer({ id: 1, name: 'test', status: 'initializing' }),
        }), { status: 200 }),
      );

      await provider.createVM({ ...vmConfig, image: 'ubuntu-24.04' });

      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 0).init);
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
      const firstBody = jsonBody(fetchCall(mockFetch, 0).init);
      const secondBody = jsonBody(fetchCall(mockFetch, 1).init);
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
      const firstBody = jsonBody(fetchCall(mockFetch, 0).init);
      const secondBody = jsonBody(fetchCall(mockFetch, 1).init);
      const thirdBody = jsonBody(fetchCall(mockFetch, 2).init);
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

      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 0).init);
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

      const body = jsonBody(fetchCall(fetch as ReturnType<typeof vi.fn>, 0).init);
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
});

describe('isTransientCapacityError', () => {
  it('should return true for "unavailable" message with 422', () => {
    const err = new ProviderError('hetzner', 422, 'Server type cx33 unavailable in fsn1');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return true for "currently not available" message with 422', () => {
    const err = new ProviderError('hetzner', 422, 'Server type cx43 is currently not available in location ash');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return true for "no capacity" message with 422', () => {
    const err = new ProviderError('hetzner', 422, 'no capacity for this server type');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return true for "not enough resources" message with 422', () => {
    const err = new ProviderError('hetzner', 422, 'not enough resources available');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return true for "could not allocate" message with 422', () => {
    const err = new ProviderError('hetzner', 422, 'could not allocate server');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return false for non-capacity 422 message', () => {
    const err = new ProviderError('hetzner', 422, 'invalid input: server_type is not valid');
    expect(isTransientCapacityError(err)).toBe(false);
  });

  it('should return false for non-422 status codes', () => {
    const err = new ProviderError('hetzner', 403, 'Server type cx33 unavailable in fsn1');
    expect(isTransientCapacityError(err)).toBe(false);
  });

  it('should return false for 412 errors', () => {
    const err = new ProviderError('hetzner', 412, 'error during placement');
    expect(isTransientCapacityError(err)).toBe(false);
  });

  it('should return true for "resources temporarily unavailable" variant', () => {
    const err = new ProviderError('hetzner', 422, 'resources temporarily unavailable in this region');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return true for "resource unavailable" singular variant', () => {
    const err = new ProviderError('hetzner', 422, 'resource unavailable for allocation');
    expect(isTransientCapacityError(err)).toBe(true);
  });

  it('should return true for "could not find" variant', () => {
    const err = new ProviderError('hetzner', 422, 'could not find available host for server type cx33');
    expect(isTransientCapacityError(err)).toBe(true);
  });
});

describe('HetznerProvider capacity retry', () => {
  const vmConfig: VMConfig = {
    name: 'test-server',
    size: 'medium',
    location: 'fsn1',
    userData: '#cloud-config',
    labels: { node: 'node-123' },
  };

  const originalFetch = globalThis.fetch;

  /** Create a mock 422 capacity error response */
  function capacityErrorResponse(msg = 'Server type cx33 unavailable in fsn1') {
    return new Response(JSON.stringify({ error: { message: msg } }), { status: 422 });
  }

  /** Create a mock 412 placement error response */
  function placementErrorResponse() {
    return new Response(JSON.stringify({ error: { message: 'error during placement' } }), { status: 412 });
  }

  /** Create a mock successful server creation response */
  function successResponse() {
    return new Response(JSON.stringify({ server: createMockServer({ status: 'initializing' }) }), { status: 200 });
  }

  /** Mock fetch to always return the same capacity error */
  function mockAlwaysCapacityError(msg?: string) {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(capacityErrorResponse(msg)));
  }

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('should retry transient capacity 422 and succeed on subsequent attempt', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 3);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse())
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.id).toBe('12345');
    // 422 throws from providerFetch, placement loop re-throws, capacity loop catches and retries
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry non-capacity 422 errors', async () => {
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 3);
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ error: { message: 'invalid input: server_type is not valid' } }),
        { status: 422 },
      )),
    );

    const err = await provider.createVM(vmConfig).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('invalid input');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should throw capacity exhaustion error after max attempts', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 3);
    mockAlwaysCapacityError();

    const promise = provider.createVM(vmConfig).catch((err) => err);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(ProviderError);
    expect(result.statusCode).toBe(422);
    expect(result.message).toContain('Capacity exhausted after 3 attempts');
    expect(result.message).toContain('cx33');
    expect(result.message).toContain('fsn1');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('should use exponential backoff for capacity retries', async () => {
    vi.useFakeTimers();
    const initialDelay = 1000;
    const maxDelay = 10000;
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, initialDelay, maxDelay, 4);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse('no capacity for this server type'))
      .mockResolvedValueOnce(capacityErrorResponse('no capacity for this server type'))
      .mockResolvedValueOnce(capacityErrorResponse('no capacity for this server type'))
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);

    // After first 422: wait initialDelay (1000ms)
    await vi.advanceTimersByTimeAsync(0); // let first fetch resolve
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1); // not yet

    await vi.advanceTimersByTimeAsync(1);
    // providerFetch timeout also uses setTimeout, advance past it
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2); // second attempt after 1000ms

    // After second 422: wait 2000ms (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(3); // third attempt after 2000ms

    // After third 422: wait 4000ms (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(3999);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.id).toBe('12345');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('should cap backoff delay at maxDelay', async () => {
    // With initialDelay=100 and maxDelay=200, attempt 3 would be 100*2^2=400 but capped to 200
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 200, 5);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse('no capacity for this server type'))
      .mockResolvedValueOnce(capacityErrorResponse('no capacity for this server type'))
      .mockResolvedValueOnce(capacityErrorResponse('no capacity for this server type'))
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);

    // Attempt 0 fails (422), delay = 100ms
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Attempt 1 fails (422), delay = min(200, 200) = 200ms
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Attempt 2 fails (422), delay = min(400, 200) = 200ms (capped!)
    await vi.advanceTimersByTimeAsync(199);
    expect(mockFetch).toHaveBeenCalledTimes(3); // not yet at 200
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.id).toBe('12345');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('should use custom retry parameters from constructor', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 50, 500, 2);
    mockAlwaysCapacityError();

    const promise = provider.createVM(vmConfig).catch((err) => err);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(ProviderError);
    expect(result.message).toContain('Capacity exhausted after 2 attempts');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should still handle 412 placement errors inside capacity retry loop', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 3);
    // All locations return 412 — exhausts placement loop, outer capacity loop does NOT retry
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(placementErrorResponse()));

    const promise = provider.createVM(vmConfig).catch((err) => err);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(ProviderError);
    expect(result.statusCode).toBe(412);
    // Only 1 round of placement attempts (6 calls), no capacity retry
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('should throw immediately when maxAttempts is 1', async () => {
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 1);
    mockAlwaysCapacityError();

    const err = await provider.createVM(vmConfig).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('Capacity exhausted after 1 attempts');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should set .cause on capacity exhaustion error', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 2);
    mockAlwaysCapacityError('no capacity for this server type');

    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.cause).toBeInstanceOf(ProviderError);
    expect((err.cause as ProviderError).statusCode).toBe(422);
  });

  it('should handle mixed 412 placement then 422 capacity then success', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 3);
    // First capacity attempt: 422 (transient), then second attempt: all 412 placement errors
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse())
      .mockImplementation(() => Promise.resolve(placementErrorResponse()));

    globalThis.fetch = mockFetch;

    // 412 is not a capacity error, so the outer loop won't retry it
    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(412);
    // 1 call (422) + 6 calls (412 placement loop) = 7
    expect(mockFetch).toHaveBeenCalledTimes(7);
  });

  it('should NOT log a warn on the final exhaustion attempt', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 2);
    mockAlwaysCapacityError('no capacity for this server type');

    const promise = provider.createVM(vmConfig).catch((e) => e);
    await vi.runAllTimersAsync();
    await promise;

    const capacityWarnCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('transient capacity error'),
    );
    // Only 1 warn for first attempt; second attempt is the last and throws without logging
    expect(capacityWarnCalls).toHaveLength(1);
    expect(String(capacityWarnCalls[0]?.[0])).toContain('attempt 1/2');

    warnSpy.mockRestore();
  });

  it('should log capacity retry attempts with context', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new HetznerProvider('test-token', 'fsn1', undefined, true, 100, 1000, 3);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(capacityErrorResponse())
      .mockResolvedValueOnce(successResponse());

    globalThis.fetch = mockFetch;

    const promise = provider.createVM(vmConfig);
    await vi.runAllTimersAsync();
    await promise;

    const capacityWarnCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('transient capacity error'),
    );
    expect(capacityWarnCalls).toHaveLength(1);
    const logMsg = String(capacityWarnCalls[0]?.[0]);
    expect(logMsg).toContain('attempt 1/3');
    expect(logMsg).toContain('server_type=cx33');
    expect(logMsg).toContain('location=fsn1');
    expect(logMsg).toContain('100ms');

    warnSpy.mockRestore();
  });
});
