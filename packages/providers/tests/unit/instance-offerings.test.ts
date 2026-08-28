import { describe, expect, it } from 'vitest';

import { getProviderInstanceOfferings, normalizeProviderPrice } from '../../src/instance-offerings';

describe('provider instance offerings', () => {
  it('flattens provider size metadata into concrete provider-native offerings', () => {
    expect(getProviderInstanceOfferings('vultr')).toEqual([
      expect.objectContaining({
        provider: 'vultr',
        legacyVmSize: 'small',
        instanceType: 'vc2-2c-4gb',
        vcpuCount: 2,
        memoryMb: 4096,
        diskGb: 80,
        priceCurrency: 'USD',
        priceMonthlyCents: 2000,
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
});
