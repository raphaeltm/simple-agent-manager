import { afterEach, describe, expect, it, vi } from 'vitest';

import { DigitalOceanProvider } from '../../src/digitalocean';
import { HetznerProvider } from '../../src/hetzner';
import { ScalewayProvider } from '../../src/scaleway';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';
import { VultrProvider } from '../../src/vultr';
import {
  createMockDigitalOceanDroplet,
  createMockDigitalOceanVolume,
} from '../fixtures/digitalocean-mocks';
import { createMockServer } from '../fixtures/hetzner-mocks';
import { createMockVultrInstance } from '../fixtures/vultr-mocks';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const vmConfig: VMConfig = {
  name: 'sam-cancellation-regression',
  size: 'small',
  location: 'fsn1',
  userData: '#cloud-config\npackages:\n  - docker.io',
  labels: { 'sam-project': 'project-1', 'sam-node': 'node-1' },
};

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function methodOf(init?: RequestInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function countCalls(mock: ReturnType<typeof vi.fn>, method: string, matcher: RegExp): number {
  return mock.mock.calls.filter(
    ([url, init]) =>
      methodOf(init as RequestInit | undefined) === method && matcher.test(String(url))
  ).length;
}

describe('provider workflow cancellation', () => {
  describe('Hetzner create retries', () => {
    it('cancels the placement wait without treating a 412-shaped abort reason as another placement failure', async () => {
      vi.useFakeTimers();
      const provider = new HetznerProvider('test-token', 'fsn1', 1_000, true, 1_000, 1_000, {
        capacityRetryMaxAttempts: 3,
        capacityRetryBudgetMs: 10_000,
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: 'placement_error', message: 'placement could not be satisfied' },
            }),
            { status: 412 }
          )
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ server: createMockServer({ status: 'initializing' }) }), {
            status: 201,
          })
        );
      globalThis.fetch = fetchMock;
      const controller = new AbortController();
      const reason = new ProviderError(
        'hetzner',
        412,
        'caller cancelled a superseded placement request',
        { providerCode: 'placement_error', category: 'invalid_config' }
      );

      const outcome = provider
        .createVM(vmConfig, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(countCalls(fetchMock, 'POST', /\/v1\/servers$/)).toBe(1);

      controller.abort(reason);
      await vi.runAllTimersAsync();

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'POST', /\/v1\/servers$/)).toBe(1);
    });

    it('cancels the capacity backoff without retrying a transient-capacity-shaped abort reason', async () => {
      vi.useFakeTimers();
      const provider = new HetznerProvider('test-token', 'fsn1', 1_000, false, 1_000, 1_000, {
        capacityRetryMaxAttempts: 3,
        capacityRetryBudgetMs: 10_000,
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: 'resource_unavailable', message: 'no capacity in fsn1' },
            }),
            { status: 422 }
          )
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ server: createMockServer({ status: 'initializing' }) }), {
            status: 201,
          })
        );
      globalThis.fetch = fetchMock;
      const controller = new AbortController();
      const reason = new ProviderError(
        'hetzner',
        422,
        'caller cancelled a capacity-constrained request',
        { providerCode: 'resource_unavailable', category: 'transient_capacity' }
      );

      const outcome = provider
        .createVM(vmConfig, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(countCalls(fetchMock, 'POST', /\/v1\/servers$/)).toBe(1);

      controller.abort(reason);
      await vi.runAllTimersAsync();

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'POST', /\/v1\/servers$/)).toBe(1);
    });
  });

  describe('post-create IP polling', () => {
    it('does not begin DigitalOcean polling when cancellation arrives during the create body', async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const method = methodOf(init);
        if (method !== 'POST' || !/\/v2\/droplets$/.test(url)) {
          throw new Error(`Unexpected DigitalOcean request after cancellation: ${method} ${url}`);
        }
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        });
        return Promise.resolve(new Response(body, { status: 202 }));
      });
      globalThis.fetch = fetchMock as typeof fetch;
      const provider = new DigitalOceanProvider('test-token', { requestTimeoutMs: 10_000 });
      const controller = new AbortController();
      const reason = new ProviderError('digitalocean', 409, 'caller cancelled create response body');

      const outcome = provider
        .createVM({ ...vmConfig, location: 'fra1' }, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'POST', /\/v2\/droplets$/)).toBe(1);
      expect(countCalls(fetchMock, 'GET', /\/v2\/droplets\//)).toBe(0);
    });

    it('stops DigitalOcean polling at caller cancellation and preserves the exact reason', async () => {
      vi.useFakeTimers();
      const pendingDroplet = createMockDigitalOceanDroplet({
        id: 12345,
        status: 'new',
        networks: { v4: [] },
      });
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = methodOf(init);
        if (method === 'POST' && /\/v2\/droplets$/.test(url)) {
          return jsonResponse({ droplet: pendingDroplet }, 202);
        }
        if (method === 'GET' && /\/v2\/droplets\/12345$/.test(url)) {
          return jsonResponse({ droplet: pendingDroplet });
        }
        throw new Error(`Unexpected DigitalOcean request: ${method} ${url}`);
      });
      globalThis.fetch = fetchMock;
      const provider = new DigitalOceanProvider('test-token', {
        requestTimeoutMs: 1_000,
        ipPollTimeoutMs: 100,
        ipPollIntervalMs: 10,
      });
      const controller = new AbortController();
      const reason = new Error('caller cancelled DigitalOcean IP discovery');

      const outcome = provider
        .createVM({ ...vmConfig, location: 'fra1' }, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(countCalls(fetchMock, 'GET', /\/v2\/droplets\/12345$/)).toBe(1);

      controller.abort(reason);
      await vi.runAllTimersAsync();

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'POST', /\/v2\/droplets$/)).toBe(1);
      expect(countCalls(fetchMock, 'GET', /\/v2\/droplets\/12345$/)).toBe(1);
    });

    it('stops Vultr polling at caller cancellation and preserves the exact reason', async () => {
      vi.useFakeTimers();
      const pendingInstance = createMockVultrInstance({
        id: 'vultr-instance-1',
        main_ip: '0.0.0.0',
        status: 'pending',
        power_status: 'stopped',
        server_status: 'none',
      });
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = methodOf(init);
        if (method === 'POST' && /\/v2\/instances$/.test(url)) {
          return jsonResponse({ instance: pendingInstance }, 202);
        }
        if (method === 'GET' && /\/v2\/instances\/vultr-instance-1$/.test(url)) {
          return jsonResponse({ instance: pendingInstance });
        }
        throw new Error(`Unexpected Vultr request: ${method} ${url}`);
      });
      globalThis.fetch = fetchMock;
      const provider = new VultrProvider('test-token', {
        requestTimeoutMs: 1_000,
        ipPollTimeoutMs: 100,
        ipPollIntervalMs: 10,
      });
      const controller = new AbortController();
      const reason = new Error('caller cancelled Vultr IP discovery');

      const outcome = provider
        .createVM({ ...vmConfig, location: 'fra', image: '1743' }, { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(countCalls(fetchMock, 'GET', /\/v2\/instances\/vultr-instance-1$/)).toBe(1);

      controller.abort(reason);
      await vi.runAllTimersAsync();

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'POST', /\/v2\/instances$/)).toBe(1);
      expect(countCalls(fetchMock, 'GET', /\/v2\/instances\/vultr-instance-1$/)).toBe(1);
    });
  });

  describe('DigitalOcean volume action polling', () => {
    it('does not poll or fetch the volume again after attach cancellation', async () => {
      vi.useFakeTimers();
      let actionReads = 0;
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = methodOf(init);
        if (method === 'POST' && /\/v2\/volumes\/do-volume-1\/actions$/.test(url)) {
          return jsonResponse({ action: { id: 77, status: 'in-progress', type: 'attach' } }, 202);
        }
        if (method === 'GET' && /\/v2\/actions\/77$/.test(url)) {
          actionReads += 1;
          return jsonResponse({
            action: {
              id: 77,
              status: actionReads === 1 ? 'in-progress' : 'completed',
              type: 'attach',
            },
          });
        }
        if (method === 'GET' && /\/v2\/volumes\/do-volume-1$/.test(url)) {
          return jsonResponse({
            volume: createMockDigitalOceanVolume({ droplet_ids: [123] }),
          });
        }
        throw new Error(`Unexpected DigitalOcean volume request: ${method} ${url}`);
      });
      globalThis.fetch = fetchMock;
      const provider = new DigitalOceanProvider('test-token', {
        requestTimeoutMs: 1_000,
        actionPollTimeoutMs: 100,
        actionPollIntervalMs: 10,
      });
      const controller = new AbortController();
      const reason = new Error('caller cancelled volume attachment');

      const outcome = provider
        .attachVolume(
          { volumeId: 'do-volume-1', serverId: '123', location: 'fra1' },
          { signal: controller.signal }
        )
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(countCalls(fetchMock, 'GET', /\/v2\/actions\/77$/)).toBe(1);

      controller.abort(reason);
      await vi.runAllTimersAsync();

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'POST', /\/v2\/volumes\/do-volume-1\/actions$/)).toBe(1);
      expect(countCalls(fetchMock, 'GET', /\/v2\/actions\/77$/)).toBe(1);
      expect(countCalls(fetchMock, 'GET', /\/v2\/volumes\/do-volume-1$/)).toBe(0);
    });
  });

  describe('delegated volume clients', () => {
    it('cancels Vultr live-size discovery through the public provider before resize mutation', async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const method = methodOf(init);
        if (method !== 'GET' || !/\/v2\/blocks\/vultr-block-1$/.test(url)) {
          throw new Error(`Unexpected Vultr volume request: ${method} ${url}`);
        }

        const signal = init?.signal;
        if (!signal) throw new Error('Expected Vultr volume request to carry an abort signal');
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      globalThis.fetch = fetchMock as typeof fetch;
      const provider = new VultrProvider('test-token');
      const controller = new AbortController();
      const reason = new ProviderError('vultr', 404, 'caller cancelled stale volume resize', {
        category: 'invalid_config',
      });

      const outcome = provider
        .resizeVolume(
          { volumeId: 'vultr-block-1', location: 'fra', sizeGb: 80 },
          { signal: controller.signal }
        )
        .catch((error: unknown) => error);
      expect(countCalls(fetchMock, 'GET', /\/v2\/blocks\/vultr-block-1$/)).toBe(1);

      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(countCalls(fetchMock, 'GET', /\/v2\/blocks\/vultr-block-1$/)).toBe(1);
      expect(countCalls(fetchMock, 'PATCH', /\/v2\/blocks\/vultr-block-1$/)).toBe(0);
    });

    it('cancels Scaleway live-size discovery through the public provider before resize mutation', async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const method = methodOf(init);
        if (
          method !== 'GET' ||
          !/\/block\/v1\/zones\/fr-par-1\/volumes\/scaleway-volume-1$/.test(url)
        ) {
          throw new Error(`Unexpected Scaleway volume request: ${method} ${url}`);
        }

        const signal = init?.signal;
        if (!signal) throw new Error('Expected Scaleway volume request to carry an abort signal');
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      globalThis.fetch = fetchMock as typeof fetch;
      const provider = new ScalewayProvider('test-token', 'project-1', 'fr-par-1');
      const controller = new AbortController();
      const reason = new ProviderError(
        'scaleway',
        409,
        'caller cancelled superseded volume resize',
        { category: 'invalid_config' }
      );

      const outcome = provider
        .resizeVolume(
          { volumeId: 'scaleway-volume-1', location: 'fr-par-1', sizeGb: 80 },
          { signal: controller.signal }
        )
        .catch((error: unknown) => error);
      expect(
        countCalls(fetchMock, 'GET', /\/block\/v1\/zones\/fr-par-1\/volumes\/scaleway-volume-1$/)
      ).toBe(1);

      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(
        countCalls(fetchMock, 'GET', /\/block\/v1\/zones\/fr-par-1\/volumes\/scaleway-volume-1$/)
      ).toBe(1);
      expect(
        countCalls(fetchMock, 'PATCH', /\/block\/v1\/zones\/fr-par-1\/volumes\/scaleway-volume-1$/)
      ).toBe(0);
    });
  });

  it('does not mistake a caller cancellation shaped like a 404 for an idempotent delete', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = methodOf(init);
      if (method !== 'DELETE' || !/\/v2\/droplets\/already-gone$/.test(url)) {
        throw new Error(`Unexpected DigitalOcean delete request: ${method} ${url}`);
      }
      const signal = init?.signal;
      if (!signal) throw new Error('Expected delete request to carry an abort signal');
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock;
    const provider = new DigitalOceanProvider('test-token', { requestTimeoutMs: 100 });
    const controller = new AbortController();
    const reason = new ProviderError(
      'digitalocean',
      404,
      'caller cancelled deletion of an obsolete resource',
      { category: 'invalid_config' }
    );

    const outcome = provider
      .deleteVM('already-gone', { signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(countCalls(fetchMock, 'DELETE', /\/v2\/droplets\/already-gone$/)).toBe(1);

    controller.abort(reason);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe(reason);
    expect(countCalls(fetchMock, 'DELETE', /\/v2\/droplets\/already-gone$/)).toBe(1);
  });
});
