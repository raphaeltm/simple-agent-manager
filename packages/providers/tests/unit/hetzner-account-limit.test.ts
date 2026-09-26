/**
 * Hetzner account quotas (`403 resource_limit_exceeded`) — the 2026-09-25 production incident.
 *
 * Three human wakes of one sleeping conversation failed with
 * `hetzner API error (403): shared core limit exceeded`. Nothing classified that 403. It arrived
 * at the control plane as category 'unknown' and was read as a generic failure, so the pool's
 * fallback chain stopped at cx53 while cx43/cx33/cx23 — which need fewer cores — were never tried.
 *
 * Like `hetzner-placement-capacity.test.ts`, these tests drive the REAL `providerFetch` →
 * `HetznerProvider.createVM` path with production-shaped response bodies, minting a fresh
 * `Response` per call (`.claude/rules/72`), and assert the parsed message and provider code so a
 * degraded fixture cannot pass silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider, isTransientCapacityError } from '../../src/hetzner';
import {
  classifyHetznerAccountLimit,
  hetznerCoreLimitCovers,
  hetznerServerTypeCoreClass,
} from '../../src/hetzner-account-limits';
import { classifyHetznerError, mapHetznerProviderError } from '../../src/hetzner-metadata';
import type { VMConfig } from '../../src/types';
import { ProviderError } from '../../src/types';

/** Hetzner's documented error envelope. `code: undefined` drops the field, as a lossy body would. */
function hetznerError(status: number, code: string | undefined, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ error: code === undefined ? { message } : { code, message } }), {
      status,
    });
}

/** The incident response: prod recorded status 403 and exactly this message. */
const sharedCoreLimit = hetznerError(403, 'resource_limit_exceeded', 'shared core limit exceeded');

/** A pooled placement: `native` set, so cross-location fallback is off (production shape). */
const pooledConfig: VMConfig = {
  name: 'pool-node',
  location: 'fsn1',
  userData: '#cloud-config',
  native: { instanceType: 'cx53' },
};

async function captureCreateError(make: () => Response): Promise<{
  error: ProviderError;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(make()));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  vi.useFakeTimers();
  // Production runtime budget: a quota must not spend it re-asking for the same server type.
  const provider = new HetznerProvider('test-token', 'fsn1', 10, true, 10, 100, {
    capacityRetryMaxAttempts: 10,
    capacityRetryBudgetMs: 300_000,
  });
  const promise = provider.createVM(pooledConfig).catch((err: unknown) => err);
  await vi.runAllTimersAsync();
  const error = await promise;
  expect(error).toBeInstanceOf(ProviderError);
  return { error: error as ProviderError, fetchMock };
}

describe('HetznerProvider.createVM on an account quota', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('surfaces the shared-core 403 as quota_exceeded, categorized at construction', async () => {
    const { error } = await captureCreateError(sharedCoreLimit);

    // Fixture fidelity: a consumed-body mock would degrade this to "HTTP 403" with no code.
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('hetzner API error (403): shared core limit exceeded');
    expect(error.providerCode).toBe('resource_limit_exceeded');
    // 'unknown' before the fix — the control plane could not tell a quota from anything else.
    expect(error.category).toBe('quota_exceeded');
    expect((error.cause as ProviderError).category).toBe('unknown');
    expect(classifyHetznerAccountLimit(error)).toEqual({ resource: 'cores', coreClass: 'shared' });
  });

  it('never re-asks for the same server type against a quota', async () => {
    // A quota is not transient capacity: entering the 300 s same-SKU loop would burn the whole
    // budget on a create that cannot succeed until the account frees cores.
    const { error, fetchMock } = await captureCreateError(sharedCoreLimit);

    expect(isTransientCapacityError(error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies the server-count quota as servers, not cores', async () => {
    const { error, fetchMock } = await captureCreateError(
      hetznerError(403, 'resource_limit_exceeded', 'server limit reached')
    );

    expect(error.message).toBe('hetzner API error (403): server limit reached');
    expect(error.category).toBe('quota_exceeded');
    expect(classifyHetznerAccountLimit(error)).toEqual({ resource: 'servers', coreClass: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies Hetzner's documented example body as some other account resource", async () => {
    // Verbatim example from the resource_limit_exceeded section of cloud.spec.json.
    const { error } = await captureCreateError(
      hetznerError(403, 'resource_limit_exceeded', 'project limit exceeded')
    );

    expect(error.category).toBe('quota_exceeded');
    expect(classifyHetznerAccountLimit(error)).toEqual({ resource: 'other', coreClass: null });
  });

  it('still recognizes the quota when the body lost its structured code', async () => {
    const { error } = await captureCreateError(
      hetznerError(403, undefined, 'shared core limit exceeded')
    );

    expect(error.providerCode).toBeUndefined();
    expect(error.category).toBe('quota_exceeded');
    expect(classifyHetznerAccountLimit(error)?.resource).toBe('cores');
  });

  it('control: a genuine permission 403 stays an auth error and is not an account limit', async () => {
    const { error, fetchMock } = await captureCreateError(
      hetznerError(403, 'forbidden', 'insufficient permissions for this request')
    );

    expect(error.message).toBe(
      'hetzner API error (403): insufficient permissions for this request'
    );
    expect(error.providerCode).toBe('forbidden');
    expect(error.category).toBe('auth_error');
    expect(classifyHetznerAccountLimit(error)).toBeNull();
    expect(isTransientCapacityError(error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('control: a limit-worded 403 about the token stays an auth error', async () => {
    const { error, fetchMock } = await captureCreateError(
      hetznerError(403, undefined, 'token permission limit exceeded')
    );

    expect(error.message).toBe('hetzner API error (403): token permission limit exceeded');
    expect(error.providerCode).toBeUndefined();
    expect(error.category).toBe('auth_error');
    expect(classifyHetznerAccountLimit(error)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('control: an invalid token stays an auth error', async () => {
    const { error } = await captureCreateError(
      hetznerError(401, 'unauthorized', 'unable to authenticate')
    );

    expect(error.category).toBe('auth_error');
    expect(classifyHetznerAccountLimit(error)).toBeNull();
  });
});

describe('classifyHetznerError account-quota arms', () => {
  it.each([
    [
      'documented code',
      403,
      'resource_limit_exceeded',
      'shared core limit exceeded',
      'quota_exceeded',
    ],
    ['legacy server code', 403, 'server_limit_exceeded', 'server limit reached', 'quota_exceeded'],
    [
      'message only',
      403,
      undefined,
      'hetzner API error (403): server limit reached',
      'quota_exceeded',
    ],
    [
      'unrecognized code naming a limit',
      403,
      'core_quota',
      'dedicated core limit exceeded',
      'quota_exceeded',
    ],
    // Structured code outranks the message fallback.
    ['forbidden code with limit text', 403, 'forbidden', 'server limit reached', 'auth_error'],
    ['permission text', 403, undefined, 'insufficient permissions', 'auth_error'],
    // Credential vocabulary vetoes the message fallback, even beside limit wording.
    ['limit text about the token', 403, undefined, 'token permission limit exceeded', 'auth_error'],
    [
      'limit text about credentials, unrecognized code',
      403,
      'some_new_code',
      'API credentials rate limit reached',
      'auth_error',
    ],
    [
      'maintenance',
      403,
      'maintenance',
      'Cannot perform operation due to maintenance',
      'auth_error',
    ],
  ] as const)('%s → %s', (_label, status, code, message, expected) => {
    expect(classifyHetznerError(status, code, message)).toBe(expected);
  });
});

describe('classifyHetznerAccountLimit', () => {
  const quota = (message: string, providerName = 'hetzner') =>
    new ProviderError(providerName, 403, `hetzner API error (403): ${message}`, {
      providerCode: 'resource_limit_exceeded',
    });

  it('names the dedicated core pool', () => {
    expect(classifyHetznerAccountLimit(quota('dedicated core limit exceeded'))).toEqual({
      resource: 'cores',
      coreClass: 'dedicated',
    });
  });

  it('leaves the core class open when the message does not name one', () => {
    expect(classifyHetznerAccountLimit(quota('core limit exceeded'))).toEqual({
      resource: 'cores',
      coreClass: null,
    });
  });

  it('respects a category assigned at construction', () => {
    const categorized = new ProviderError('hetzner', 403, 'shared core limit exceeded', {
      category: 'quota_exceeded',
    });
    expect(classifyHetznerAccountLimit(categorized)?.resource).toBe('cores');

    const auth = new ProviderError('hetzner', 403, 'server limit reached', {
      category: 'auth_error',
    });
    expect(classifyHetznerAccountLimit(auth)).toBeNull();
  });

  it('never reads another provider’s error with Hetzner vocabulary', () => {
    expect(classifyHetznerAccountLimit(quota('shared core limit exceeded', 'gcp'))).toBeNull();
  });
});

describe('Hetzner core classes', () => {
  it.each([
    ['cx53', 'shared'],
    ['cpx21', 'shared'],
    ['cax11', 'shared'],
    ['ccx13', 'dedicated'],
    ['CCX33', 'dedicated'],
  ] as const)('%s draws on %s cores', (serverType, coreClass) => {
    expect(hetznerServerTypeCoreClass(serverType)).toBe(coreClass);
  });

  it('a shared-core limit rules out shared offerings only', () => {
    const limit = { resource: 'cores', coreClass: 'shared' } as const;
    expect(hetznerCoreLimitCovers(limit, 'cx43')).toBe(true);
    expect(hetznerCoreLimitCovers(limit, 'ccx33')).toBe(false);
  });

  it('a limit that names no class covers every server type', () => {
    const limit = { resource: 'cores', coreClass: null } as const;
    expect(hetznerCoreLimitCovers(limit, 'cx43')).toBe(true);
    expect(hetznerCoreLimitCovers(limit, 'ccx33')).toBe(true);
  });

  it('a server-count limit is not a core limit', () => {
    expect(hetznerCoreLimitCovers({ resource: 'servers', coreClass: null }, 'cx23')).toBe(false);
  });
});

describe('mapHetznerProviderError', () => {
  it('keeps a category that was already decided', () => {
    // createVM's budget-exhausted wrapper says transient_capacity about an inner 422 whose own
    // text classifies differently. Re-deriving it would undo that decision.
    const decided = new ProviderError(
      'hetzner',
      422,
      'Capacity exhausted after 3 attempts for server type cx53 in fsn1: invalid input',
      { providerCode: 'invalid_input', category: 'transient_capacity' }
    );
    expect(mapHetznerProviderError(decided)).toBe(decided);
  });

  it('carries the structured context onto the categorized error', () => {
    const raw = new ProviderError('hetzner', 403, 'hetzner API error (403): server limit reached', {
      providerCode: 'resource_limit_exceeded',
      context: { operation: 'createVM' },
    });
    const mapped = mapHetznerProviderError(raw) as ProviderError;
    expect(mapped.category).toBe('quota_exceeded');
    expect(mapped.context).toEqual({ operation: 'createVM' });
    expect(mapped.cause).toBe(raw);
  });

  it('leaves an error the classifier cannot place exactly as thrown', () => {
    const raw = new ProviderError('hetzner', 500, 'hetzner API error (500): server error');
    expect(mapHetznerProviderError(raw)).toBe(raw);
  });
});
