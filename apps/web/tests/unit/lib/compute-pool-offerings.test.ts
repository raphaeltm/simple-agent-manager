import type { ProviderCatalog } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  type ComputePoolOfferingFilters,
  flattenProviderCatalogOfferings,
  matchesComputePoolFilters,
} from '../../../src/lib/compute-pool-offerings';

const BASE_FILTERS: ComputePoolOfferingFilters = {
  provider: 'all',
  location: '',
  minVcpu: '',
  minRamGb: '',
  maxMonthlyPrice: '',
  availability: 'all',
};

function catalog(): ProviderCatalog {
  return {
    provider: 'hetzner',
    credentialSource: 'project',
    credentialId: 'credential-project',
    locations: [
      { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
      { id: 'ash', name: 'Ashburn', country: 'US' },
      { id: 'hel1', name: 'Helsinki', country: 'FI' },
    ],
    sizes: {
      small: { type: 'cx22', price: '€3.79/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
      medium: { type: 'cpx31', price: '€13.10/mo', vcpu: 4, ramGb: 8, storageGb: 160 },
      large: { type: 'ccx33', price: '€55.20/mo', vcpu: 8, ramGb: 32, storageGb: 240 },
    },
    offerings: [
      {
        provider: 'hetzner',
        providerInstanceType: 'cx22',
        providerInstanceSku: null,
        displayName: 'CX22',
        sku: 'cx22',
        location: 'fsn1',
        locationName: 'Falkenstein',
        country: 'DE',
        vcpu: 2,
        memoryMb: 4096,
        memoryGb: 4,
        diskGb: 40,
        price: '€3.79/mo',
        priceMonthly: 3.79,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'cpx31',
        providerInstanceSku: null,
        displayName: 'CPX31',
        sku: 'cpx31',
        location: 'ash',
        locationName: 'Ashburn',
        country: 'US',
        vcpu: 4,
        memoryMb: 8192,
        memoryGb: 8,
        diskGb: 160,
        price: '€13.10/mo',
        priceMonthly: 13.1,
        currency: 'EUR',
        available: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'ccx33',
        providerInstanceSku: null,
        displayName: 'CCX33',
        sku: 'ccx33',
        location: 'hel1',
        locationName: 'Helsinki',
        country: 'FI',
        vcpu: 8,
        memoryMb: 32_768,
        memoryGb: 32,
        diskGb: 240,
        price: '€55.20/mo',
        priceMonthly: 55.2,
        currency: 'EUR',
        available: false,
        status: 'temporarily unavailable',
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-28T00:00:00.000Z',
      },
      {
        provider: 'hetzner',
        providerInstanceType: 'stale-16c-64gb',
        providerInstanceSku: null,
        displayName: 'Stale large',
        sku: 'stale-16c-64gb',
        location: 'hel1',
        locationName: 'Helsinki',
        country: 'FI',
        vcpu: 16,
        memoryMb: 65_536,
        memoryGb: 64,
        diskGb: 480,
        price: '€220.00/mo',
        priceMonthly: 220,
        currency: 'EUR',
        available: true,
        stale: true,
        catalogSource: 'api',
        catalogLastSeenAt: '2026-08-27T00:00:00.000Z',
      },
    ],
    defaultLocation: 'fsn1',
  };
}

describe('compute-pool offering filters', () => {
  const offerings = flattenProviderCatalogOfferings([catalog()]);
  const bySku = Object.fromEntries(offerings.map((offering) => [offering.sku, offering]));

  it('filters provider-native catalog rows by provider and location metadata', () => {
    expect(matchesComputePoolFilters(bySku.cx22!, { ...BASE_FILTERS, provider: 'hetzner' })).toBe(
      true
    );
    expect(
      matchesComputePoolFilters(bySku.cx22!, { ...BASE_FILTERS, provider: 'digitalocean' })
    ).toBe(false);
    expect(matchesComputePoolFilters(bySku.cpx31!, { ...BASE_FILTERS, location: 'ash' })).toBe(
      true
    );
    expect(matchesComputePoolFilters(bySku.cpx31!, { ...BASE_FILTERS, location: 'germany' })).toBe(
      false
    );
  });

  it('filters by minimum vCPU, minimum RAM, and maximum monthly price', () => {
    expect(matchesComputePoolFilters(bySku.cpx31!, { ...BASE_FILTERS, minVcpu: '4' })).toBe(true);
    expect(matchesComputePoolFilters(bySku.cx22!, { ...BASE_FILTERS, minVcpu: '4' })).toBe(false);
    expect(matchesComputePoolFilters(bySku.ccx33!, { ...BASE_FILTERS, minRamGb: '32' })).toBe(
      true
    );
    expect(matchesComputePoolFilters(bySku.cpx31!, { ...BASE_FILTERS, minRamGb: '32' })).toBe(
      false
    );
    expect(matchesComputePoolFilters(bySku.cpx31!, { ...BASE_FILTERS, maxMonthlyPrice: '15' })).toBe(
      true
    );
    expect(matchesComputePoolFilters(bySku.ccx33!, { ...BASE_FILTERS, maxMonthlyPrice: '15' })).toBe(
      false
    );
  });

  it('filters by availability state including unavailable and stale catalog rows', () => {
    expect(
      matchesComputePoolFilters(bySku.cx22!, { ...BASE_FILTERS, availability: 'available' })
    ).toBe(true);
    expect(
      matchesComputePoolFilters(bySku.ccx33!, { ...BASE_FILTERS, availability: 'available' })
    ).toBe(false);
    expect(
      matchesComputePoolFilters(bySku.ccx33!, { ...BASE_FILTERS, availability: 'unavailable' })
    ).toBe(true);
    expect(
      matchesComputePoolFilters(bySku['stale-16c-64gb']!, {
        ...BASE_FILTERS,
        availability: 'stale',
      })
    ).toBe(true);
    expect(
      matchesComputePoolFilters(bySku.cx22!, { ...BASE_FILTERS, availability: 'stale' })
    ).toBe(false);
  });
});
