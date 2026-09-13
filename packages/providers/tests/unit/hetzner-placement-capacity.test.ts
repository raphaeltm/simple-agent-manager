/**
 * Hetzner 412 "error during placement" — the 2026-09-09 production incident.
 *
 * A placement failure means Hetzner cannot place THIS server type in THIS location right now.
 * It was classified `invalid_config`, so the control plane's capacity-pool fallback chain
 * terminalized on its first offering instead of trying the rest.
 *
 * These tests deliberately go through the REAL `providerFetch` path (a mocked `globalThis.fetch`
 * returning a production-shaped Hetzner error body) rather than hand-constructing a
 * `ProviderError`. `providerFetch` never sets `category`, and the pre-fix
 * `isTransientCapacityError` only consulted the classifier for status 422 — so a test that
 * hand-fed a categorized error would pass while production stayed broken (`.claude/rules/62`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyHetznerError,
  HetznerProvider,
  isHetznerPlacementCapacityError,
  isTransientCapacityError,
} from '../../src/hetzner';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';
import { createMockServer } from '../fixtures/hetzner-mocks';

/** Exactly what Hetzner returns, per prod `platform_errors` (statusCode 412). */
function placementResponse(withCode = true): Response {
  return new Response(
    JSON.stringify({
      error: withCode
        ? { code: 'placement_error', message: 'error during placement' }
        : { message: 'error during placement' },
    }),
    { status: 412 }
  );
}

function capacityResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'resource_unavailable', message: 'no capacity' } }),
    { status: 422 }
  );
}

function successResponse(): Response {
  return new Response(JSON.stringify({ server: createMockServer({ status: 'initializing' }) }), {
    status: 201,
  });
}

/** A pooled placement: `native` set, so cross-location fallback is off (production shape). */
const pooledConfig: VMConfig = {
  name: 'pool-node',
  location: 'fsn1',
  userData: '#cloud-config',
  native: { instanceType: 'cx53' },
};

/** Matches the production runtime: outer capacity loop has a large budget available. */
function provider(): HetznerProvider {
  return new HetznerProvider('test-token', 'fsn1', 10, true, 10, 100, {
    capacityRetryMaxAttempts: 10,
    capacityRetryBudgetMs: 300_000,
  });
}

/**
 * A `Response` body can be read only once, so a mock that resolves the SAME object for every
 * call degrades the second attempt's message to "HTTP 412" and drops `providerCode`. Every
 * mock here must MINT a response per call, exactly as a real socket would.
 */
function alwaysRespond(make: () => Response): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => Promise.resolve(make()));
}

async function captureCreateError(
  fetchMock: ReturnType<typeof vi.fn>,
  config: VMConfig = pooledConfig
): Promise<unknown> {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  vi.useFakeTimers();
  const promise = provider()
    .createVM(config)
    .catch((err: unknown) => err);
  await vi.runAllTimersAsync();
  return promise;
}

describe('Hetzner 412 placement failures are transient capacity', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('surfaces a 412 whose category is unassigned, and reads it as transient capacity', async () => {
    const err = await captureCreateError(alwaysRespond(() => placementResponse()));

    expect(err).toBeInstanceOf(ProviderError);
    const providerError = err as ProviderError;
    expect(providerError.statusCode).toBe(412);
    // Guards the fixture itself: a consumed-body mock would degrade this to "HTTP 412" and
    // drop `providerCode`, quietly testing a different error than production produces.
    expect(providerError.message).toBe('hetzner API error (412): error during placement');
    expect(providerError.providerCode).toBe('placement_error');
    // Fidelity guard: if `providerFetch` ever starts assigning a category, this test stops
    // exercising the branch it exists to protect and must be revisited.
    expect(providerError.category).toBe('unknown');
    // The assertion the incident turns on. False before the fix.
    expect(isTransientCapacityError(providerError)).toBe(true);
  });

  it('reads a 412 with no structured code as transient capacity (the shape prod logs prove)', async () => {
    const err = await captureCreateError(alwaysRespond(() => placementResponse(false)));

    const providerError = err as ProviderError;
    expect(providerError.message).toBe('hetzner API error (412): error during placement');
    expect(providerError.providerCode).toBeUndefined();
    expect(providerError.category).toBe('unknown');
    expect(isTransientCapacityError(providerError)).toBe(true);
  });

  it('does NOT spend the 300s same-SKU capacity budget on a placement failure', async () => {
    // `attemptCreateWithPlacementFallback` already retried the primary location twice. Letting
    // the outer loop run would cost up to `capacityRetryBudgetMs` per rung of the pool's
    // fallback chain, for a server type Hetzner just said it cannot place.
    const fetchMock = alwaysRespond(() => placementResponse());
    const err = await captureCreateError(fetchMock);

    expect((err as ProviderError).statusCode).toBe(412);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still retries a real 422 capacity error through the outer loop (control)', async () => {
    // Proves the previous test measures placement-specific behaviour, not a disabled retry loop.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(capacityResponse())
      .mockResolvedValueOnce(successResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    vi.useFakeTimers();
    const promise = provider().createVM(pooledConfig);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ id: String(createMockServer().id) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves non-capacity failures alone (controls)', async () => {
    expect(classifyHetznerError(409, 'conflict', 'action conflict')).toBe('invalid_config');
    expect(classifyHetznerError(422, 'invalid_input', 'invalid server_type')).toBe(
      'invalid_config'
    );
    expect(classifyHetznerError(401, 'unauthorized', 'invalid token')).toBe('auth_error');
    expect(classifyHetznerError(403, 'server_limit_exceeded', 'server limit')).toBe(
      'quota_exceeded'
    );
    expect(
      isTransientCapacityError(
        new ProviderError('hetzner', 401, 'hetzner API error (401): invalid token', {
          providerCode: 'unauthorized',
        })
      )
    ).toBe(false);
  });
});

/**
 * `isTransientCapacityError` calls a HETZNER-specific classifier, but
 * `node-provisioning-step.ts` and `node-provisioning.ts` call it on any `ProviderError` without
 * checking which provider raised it. GCP is the live hazard: `classifyGcpError` has no call
 * sites, so GCP errors also arrive with `category: 'unknown'`, and GCP uses 412 for
 * ETag/precondition mismatches while using "placement policy" in its own vocabulary.
 */
describe('cross-provider isolation', () => {
  it('does not read a GCP 412 mentioning placement as Hetzner capacity', () => {
    const gcp = new ProviderError('gcp', 412, 'gcp API error (412): placement policy conflict');
    expect(gcp.category).toBe('unknown');
    expect(isTransientCapacityError(gcp)).toBe(false);
    expect(isHetznerPlacementCapacityError(gcp)).toBe(false);
  });

  it('does not run Hetzner 422 capacity heuristics over another provider', () => {
    // This message matches TRANSIENT_CAPACITY_PATTERNS, so without the providerName guard the
    // Hetzner classifier would claim it.
    const scaleway = new ProviderError('scaleway', 422, 'not enough resources available');
    expect(isTransientCapacityError(scaleway)).toBe(false);
  });

  it('still honours another provider that classified its OWN error as capacity', () => {
    // The guard must only fence the Hetzner-classifier fallback, never the category itself.
    const gcp = new ProviderError('gcp', 503, 'ZONE_RESOURCE_POOL_EXHAUSTED', {
      category: 'transient_capacity',
    });
    expect(isTransientCapacityError(gcp)).toBe(true);
  });

  it('owner control: the identical error from Hetzner IS capacity', () => {
    const hetzner = new ProviderError('hetzner', 412, 'hetzner API error (412): error during placement');
    expect(isTransientCapacityError(hetzner)).toBe(true);
    expect(isHetznerPlacementCapacityError(hetzner)).toBe(true);
  });
});

describe('isHetznerPlacementCapacityError', () => {
  it('matches a 412 placement failure, by code or by message', () => {
    expect(
      isHetznerPlacementCapacityError(
        new ProviderError('hetzner', 412, 'hetzner API error (412): error during placement', {
          providerCode: 'placement_error',
        })
      )
    ).toBe(true);
    expect(
      isHetznerPlacementCapacityError(
        new ProviderError('hetzner', 412, 'hetzner API error (412): error during placement')
      )
    ).toBe(true);
  });

  it('agrees with the classifier when the provider code is unrecognized', () => {
    // `classifyHetznerError`'s switch has no `default`, so an unrecognized code falls through to
    // the same message check. If this predicate disagreed, such an error would be capacity
    // everywhere else while still entering the 300 s same-SKU retry loop.
    const err = new ProviderError(
      'hetzner',
      412,
      'hetzner API error (412): error during placement',
      { providerCode: 'some_new_code' }
    );
    expect(classifyHetznerError(err.statusCode, err.providerCode, err.message)).toBe(
      'transient_capacity'
    );
    expect(isHetznerPlacementCapacityError(err)).toBe(true);
  });

  it('does not match other errors, including ordinary capacity scarcity', () => {
    // A 422 capacity error must keep its outer-loop retry, so it must NOT be a placement error.
    expect(
      isHetznerPlacementCapacityError(
        new ProviderError('hetzner', 422, 'hetzner API error (422): no capacity', {
          providerCode: 'resource_unavailable',
        })
      )
    ).toBe(false);
    // A 412 that Hetzner labelled as something else is not a placement failure.
    expect(
      isHetznerPlacementCapacityError(
        new ProviderError('hetzner', 412, 'hetzner API error (412): locked', {
          providerCode: 'locked',
        })
      )
    ).toBe(false);
    expect(
      isHetznerPlacementCapacityError(
        new ProviderError('hetzner', 412, 'hetzner API error (412): some other precondition')
      )
    ).toBe(false);
  });
});
