import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { CredentialCapacitySeed } from '../../../src/services/default-capacity-pool-types';
import { resolveOfferingsForSeed } from '../../../src/services/default-capacity-source-credentials';

const boundary = vi.hoisted(() => ({
  catalog: vi.fn(),
  policy: vi.fn(),
  staticOfferings: vi.fn(),
}));
vi.mock('../../../src/services/provider-catalogs', () => ({
  buildProviderCatalogForCredential: boundary.catalog,
  getStaticProviderCatalogOfferings: boundary.staticOfferings,
}));
vi.mock('../../../src/services/gcp-provider-factory', () => ({
  resolveGcpBootDiskPolicy: boundary.policy,
}));

const seed: CredentialCapacitySeed = {
  id: 'gcp-credential',
  scope: 'user',
  ownerUserId: 'owner',
  ownerProjectId: null,
  provider: 'gcp',
  active: true,
  credentialSource: 'user',
  credentialReference: 'credentials:gcp-credential',
  credentialVersion: 1,
  credentialId: 'gcp-credential',
  catalogCredentialId: 'gcp-credential',
  platformCredentialId: null,
  externalSourceRef: null,
  encryptedToken: 'test-ciphertext',
  iv: 'test-iv',
  createdBy: 'owner',
  stateFingerprint: 'current-credential',
};
const env = { CAPACITY_POOL_CATALOG_CACHE_TTL_MS: '0' } as Env;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T20:00:00Z'));
  vi.resetAllMocks();
  boundary.catalog.mockRejectedValue(new Error('Live catalog failed'));
  boundary.policy.mockResolvedValue({ gbPerVcpu: 20, minGb: 50 });
  boundary.staticOfferings.mockReturnValue([]);
});
afterEach(() => vi.useRealTimers());

describe('GCP fallback shares the catalog pass deadline', () => {
  it('does not begin a cold policy read after the live catalog consumed the pass', async () => {
    await expect(
      resolveOfferingsForSeed(seed, { env, reconciliationDeadlineAt: Date.now() })
    ).resolves.toEqual({ offerings: [], refreshSucceeded: false, catalogComplete: false });
    expect(boundary.policy).not.toHaveBeenCalled();
    expect(boundary.staticOfferings).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive fallback policy by the remaining pass, not its own timeout', async () => {
    boundary.policy.mockImplementation(() => new Promise(() => {}));
    const rejected = vi.fn();
    const resolved = vi.fn();
    const result = resolveOfferingsForSeed(seed, {
      env,
      reconciliationDeadlineAt: Date.now() + 25,
    }).then(resolved, rejected);
    await vi.advanceTimersByTimeAsync(24);
    expect(boundary.policy).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalledExactlyOnceWith({
      offerings: [],
      refreshSucceeded: false,
      catalogComplete: false,
    });
    expect(rejected).not.toHaveBeenCalled();
    expect(boundary.staticOfferings).not.toHaveBeenCalled();
    await result;
  });

  it('retains the current disk policy in fallback when it completes within the pass', async () => {
    await expect(
      resolveOfferingsForSeed(seed, { env, reconciliationDeadlineAt: Date.now() + 25 })
    ).resolves.toMatchObject({ refreshSucceeded: false, catalogComplete: false });
    expect(boundary.staticOfferings).toHaveBeenCalledWith('gcp', {
      gcpBootDiskPolicy: { gbPerVcpu: 20, minGb: 50 },
    });
  });

  it('preserves a policy failure that is not a pass timeout', async () => {
    boundary.policy.mockRejectedValue(new Error('Invalid disk policy'));
    await expect(
      resolveOfferingsForSeed(seed, { env, reconciliationDeadlineAt: Date.now() + 25 })
    ).rejects.toThrow('Invalid disk policy');
    expect(boundary.staticOfferings).not.toHaveBeenCalled();
  });
});
