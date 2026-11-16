import { HetznerProvider, ScalewayProvider } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listProviderCatalogOfferings } from '../../../src/services/provider-catalogs';

/**
 * Finding 2 (4a21532a5 review): catalog provenance/completeness was inferred from the
 * offerings array's members, so a SUCCESSFUL, COMPLETE, EMPTY provider inventory
 * (`server_types: []`) was classified as an incomplete STATIC catalog. Candidate
 * reconciliation then skipped marking the pool's prior offerings unavailable — forever.
 *
 * These exercise the real provider boundary (HetznerProvider driving its own /server_types
 * pagination through a mocked transport), not an internal helper.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockHetznerServerTypes(serverTypes: unknown[]): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('/server_types')) {
      throw new Error(`unexpected request: ${url}`);
    }
    return new Response(
      JSON.stringify({
        server_types: serverTypes,
        meta: { pagination: { page: 1, per_page: 50, next_page: null } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
}

function hetznerServerType(name: string) {
  return {
    id: 1,
    name,
    description: name.toUpperCase(),
    cores: 2,
    memory: 4,
    disk: 40,
    architecture: 'x86',
    deprecated: false,
    prices: [
      {
        location: 'fsn1',
        price_monthly: { gross: '4.51', net: '3.79' },
        price_hourly: { gross: '0.0077', net: '0.0065' },
      },
    ],
  };
}

describe('provider catalog completeness at the provider boundary', () => {
  it('clamps a stalled live request to the refresh pass and does not launch fallback after expiry', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('token');
    let signal: AbortSignal | undefined;
    const lookup = vi.spyOn(provider, 'listInstanceOfferings').mockImplementation((_, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const result = listProviderCatalogOfferings('hetzner', provider, 60_000, {
      deadlineAt: Date.now() + 50,
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(signal?.aborted).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('gives a slow fallback only the remaining shared pass budget', async () => {
    vi.useFakeTimers();
    const provider = new HetznerProvider('token');
    let fallbackSignal: AbortSignal | undefined;
    const lookup = vi
      .spyOn(provider, 'listInstanceOfferings')
      .mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('live failed')), 40))
      )
      .mockImplementationOnce((_, options) => {
        fallbackSignal = options?.signal;
        return new Promise(() => {});
      });
    const result = listProviderCatalogOfferings('hetzner', provider, 60_000, {
      deadlineAt: Date.now() + 50,
    }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(40);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fallbackSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ message: 'live failed' });
    expect(fallbackSignal?.aborted).toBe(true);
  });

  it('bounds a stalled live catalog and retains an incomplete static fallback', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    vi.useFakeTimers();
    const result = listProviderCatalogOfferings('hetzner', new HetznerProvider('token'), 100);
    await vi.advanceTimersByTimeAsync(100);
    const catalog = await result;
    expect(catalog.offerings.length).toBeGreaterThan(0);
    expect(catalog.refreshStatus).toMatchObject({
      succeeded: false,
      origin: 'static',
      complete: false,
    });
  });

  it('treats a successful EMPTY Hetzner server_types response as a complete API inventory', async () => {
    mockHetznerServerTypes([]);
    const provider = new HetznerProvider('token');

    const resolved = await listProviderCatalogOfferings('hetzner', provider);

    expect(resolved.offerings).toEqual([]);
    // Pre-fix this returned { origin: 'static', complete: false, reason: 'static-catalog' },
    // which made reconciliation skip missing-offering cleanup for the whole pool.
    expect(resolved.refreshStatus).toEqual({ succeeded: true, origin: 'api', complete: true });
  });

  it('still reports a populated Hetzner response as a complete API inventory', async () => {
    mockHetznerServerTypes([hetznerServerType('cx23')]);
    const provider = new HetznerProvider('token');

    const resolved = await listProviderCatalogOfferings('hetzner', provider);

    expect(resolved.offerings.length).toBeGreaterThan(0);
    expect(resolved.offerings.every((offering) => offering.catalogSource === 'api')).toBe(true);
    expect(resolved.refreshStatus).toEqual({ succeeded: true, origin: 'api', complete: true });
  });

  it('preserves static offerings with failed, incomplete provenance after a live catalog failure', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 500 })
    ) as unknown as typeof fetch;
    const provider = new HetznerProvider('token');

    const resolved = await listProviderCatalogOfferings('hetzner', provider);
    expect(resolved.offerings.length).toBeGreaterThan(0);
    expect(resolved.offerings.every((offering) => offering.catalogSource === 'static')).toBe(true);
    expect(resolved.refreshStatus).toEqual({ succeeded: false, origin: 'static', complete: false });
  });

  it('keeps a provider without a live catalog API classified as incomplete/static', async () => {
    // Scaleway returns SAM's curated static offering table regardless of the options, so its
    // result must never be mistaken for an authoritative provider inventory — including the
    // degenerate empty case, which is the discriminator for the empty-success rule above.
    const provider = new ScalewayProvider('token', 'project');

    const resolved = await listProviderCatalogOfferings('scaleway', provider);

    expect(provider.instanceOfferingApiBacked).toBeUndefined();
    expect(resolved.refreshStatus.complete).toBe(false);
    expect(resolved.refreshStatus.origin).toBe('static');
  });
});
