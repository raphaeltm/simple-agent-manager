import { describe, expect, it } from 'vitest';

import {
  getProviderCatalogOfferings,
  getProviderInstanceOfferings,
  normalizeProviderPrice,
} from '../../src/instance-offerings';

describe('provider instance offerings', () => {
  it.each(['hetzner', 'scaleway', 'vultr', 'digitalocean', 'upcloud', 'gcp', 'infomaniak'] as const)(
    'returns concrete normalized offerings for %s',
    (provider) => {
      const offerings = getProviderInstanceOfferings(provider);

      expect(offerings.length).toBeGreaterThanOrEqual(3);
      expect(new Set(offerings.map((offering) => offering.legacyVmSize))).toEqual(
        new Set(['small', 'medium', 'large'])
      );
      expect(
        offerings.every(
          (offering) =>
            offering.provider === provider &&
            offering.instanceType.length > 0 &&
            offering.vcpuCount > 0 &&
            offering.memoryMb > 0 &&
            (offering.diskGb === null || offering.diskGb > 0)
        )
      ).toBe(true);
    }
  );

  it('flattens provider size metadata into concrete provider-native offerings', () => {
    expect(getProviderInstanceOfferings('vultr')).toEqual([
      expect.objectContaining({
        provider: 'vultr',
        legacyVmSize: 'small',
        instanceType: 'vc2-2c-4gb',
        instanceSku: null,
        displayName: 'vc2-2c-4gb · 2 vCPU · 4 GB RAM · 80 GB disk',
        vcpuCount: 2,
        memoryMb: 4096,
        diskGb: 80,
        priceCurrency: 'USD',
        priceMonthlyCents: 2000,
        catalogSource: 'static',
        catalogLastSeenAt: null,
      }),
      expect.objectContaining({
        provider: 'vultr',
        legacyVmSize: 'medium',
        instanceType: 'vc2-4c-8gb',
      }),
      expect.objectContaining({
        provider: 'vultr',
        legacyVmSize: 'large',
        instanceType: 'vc2-6c-16gb',
      }),
    ]);
  });

  it('projects static metadata into location-specific provider catalog offerings', () => {
    expect(
      getProviderCatalogOfferings('vultr', ['fra'], {
        fra: { name: 'Frankfurt', country: 'DE' },
      })[0]
    ).toMatchObject({
      provider: 'vultr',
      location: 'fra',
      locationName: 'Frankfurt',
      country: 'DE',
      providerInstanceType: 'vc2-2c-4gb',
      providerInstanceSku: null,
      displayName: 'vc2-2c-4gb · 2 vCPU · 4 GB RAM · 80 GB disk',
      sku: 'vc2-2c-4gb',
      instanceType: 'vc2-2c-4gb',
      type: 'vc2-2c-4gb',
      vcpu: 2,
      memoryMb: 4096,
      ramGb: 4,
      diskGb: 80,
      price: '~$20/mo',
      priceMonthlyUsd: 20,
      currency: 'USD',
      machineSize: 'small',
      catalogSource: 'static',
      catalogLastSeenAt: null,
    });
  });

  it('normalizes monthly and hourly provider price displays without inventing unknown prices', () => {
    expect(normalizeProviderPrice('~$20/mo')).toMatchObject({
      priceDisplay: '~$20/mo',
      priceCurrency: 'USD',
      priceMonthlyCents: 2000,
    });
    expect(normalizeProviderPrice('~€0.024/hr')).toMatchObject({
      priceDisplay: '~€0.024/hr',
      priceCurrency: 'EUR',
      priceHourlyMicros: 24_000,
    });
    expect(normalizeProviderPrice('provider-priced')).toEqual({
      priceDisplay: 'provider-priced',
      priceCurrency: null,
      priceMonthlyCents: null,
      priceHourlyMicros: null,
    });
  });

  it('allows callers to override approximate billing month hours for price normalization', () => {
    expect(
      normalizeProviderPrice('~€0.024/hr', { approximateBillingMonthHours: 700 })
    ).toMatchObject({
      priceDisplay: '~€0.024/hr',
      priceCurrency: 'EUR',
      priceHourlyMicros: 24_000,
      priceMonthlyCents: 1680,
    });

    expect(
      normalizeProviderPrice('~$700/mo', { approximateBillingMonthHours: 700 })
    ).toMatchObject({
      priceDisplay: '~$700/mo',
      priceCurrency: 'USD',
      priceMonthlyCents: 70_000,
      priceHourlyMicros: 1_000_000,
    });
  });
});
