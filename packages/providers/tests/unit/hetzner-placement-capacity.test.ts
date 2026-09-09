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
