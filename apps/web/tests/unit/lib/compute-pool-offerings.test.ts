import type { ProviderCatalog } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  buildComputePoolOfferingsModel,
  type ComputePoolOfferingFilters,
  flattenProviderCatalogOfferings,
  matchesComputePoolFilters,
} from '../../../src/lib/compute-pool-offerings';

type CatalogOffering = NonNullable<ProviderCatalog['offerings']>[number];

const BASE_FILTERS: ComputePoolOfferingFilters = {
  provider: 'all',
  location: '',
  minVcpu: '',
  minRamGb: '',
  maxMonthlyPrice: '',
  availability: 'all',
};

const CATALOG_LAST_SEEN_AT = '2026-08-28T00:00:00.000Z';

function offering(overrides: Partial<CatalogOffering> & Pick<
  CatalogOffering,
  | 'providerInstanceType'
  | 'displayName'
  | 'sku'
  | 'location'
  | 'locationName'
  | 'country'
  | 'vcpu'
  | 'memoryMb'
  | 'memoryGb'
  | 'diskGb'
  | 'price'
  | 'priceMonthly'
>): CatalogOffering {
  return {
    provider: 'hetzner',
    providerInstanceSku: null,
    currency: 'EUR',
    available: true,
    catalogSource: 'api',
    catalogLastSeenAt: CATALOG_LAST_SEEN_AT,
    ...overrides,
  };
}

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
      offering({
        providerInstanceType: 'cx22',
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
      }),
      offering({
        providerInstanceType: 'cpx31',
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
      }),
      offering({
        providerInstanceType: 'ccx33',
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
        available: false,
        status: 'temporarily unavailable',
      }),
      offering({
        providerInstanceType: 'stale-16c-64gb',
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
        stale: true,
        catalogLastSeenAt: '2026-08-27T00:00:00.000Z',
      }),
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

  it('keeps removed provider-native catalog rows addable without exposing legacy size choices', () => {
    const model = buildComputePoolOfferingsModel(
      [
        {
          id: 'candidate-cx22',
          poolId: 'pool-1',
          capacitySourceId: 'source-project',
          provider: 'hetzner',
          location: 'fsn1',
          workloadRole: 'workspace',
          runtime: 'vm',
          machineClass: 'shared-vm',
          machineSize: null,
          providerInstanceType: 'cx22',
          providerInstanceSku: null,
          providerInstanceDisplayName: 'CX22',
          providerInstanceVcpuCount: 2,
          providerInstanceMemoryMb: 4096,
          providerInstanceDiskGb: 40,
          providerInstancePriceDisplay: '€3.79/mo',
          providerInstancePriceCurrency: 'EUR',
          providerInstancePriceMonthlyCents: 379,
          providerInstancePriceHourlyMicros: 5190,
          providerInstanceCatalogSource: 'api',
          providerInstanceCatalogLastSeenAt: CATALOG_LAST_SEEN_AT,
          priority: 0,
          candidateOrder: 0,
          status: 'active',
          createdAt: CATALOG_LAST_SEEN_AT,
          updatedAt: CATALOG_LAST_SEEN_AT,
        },
        {
          id: 'candidate-cpx31',
          poolId: 'pool-1',
          capacitySourceId: 'source-project',
          provider: 'hetzner',
          location: 'ash',
          workloadRole: 'workspace',
          runtime: 'vm',
          machineClass: 'shared-vm',
          machineSize: null,
          providerInstanceType: 'cpx31',
          providerInstanceSku: null,
          providerInstanceDisplayName: 'CPX31',
          providerInstanceVcpuCount: 4,
          providerInstanceMemoryMb: 8192,
          providerInstanceDiskGb: 160,
          providerInstancePriceDisplay: '€13.10/mo',
          providerInstancePriceCurrency: 'EUR',
          providerInstancePriceMonthlyCents: 1310,
          providerInstancePriceHourlyMicros: 17_945,
          providerInstanceCatalogSource: 'api',
          providerInstanceCatalogLastSeenAt: CATALOG_LAST_SEEN_AT,
          priority: 1,
          candidateOrder: 1,
          status: 'deleted',
          createdAt: CATALOG_LAST_SEEN_AT,
          updatedAt: CATALOG_LAST_SEEN_AT,
        },
      ],
      [catalog()],
      [
        {
          id: 'source-project',
          scope: 'project',
          ownerUserId: null,
          ownerProjectId: 'project-1',
          sourceKind: 'cloud-provider-credential',
          provider: 'hetzner',
          credentialSource: 'project',
          credentialId: 'credential-project',
          platformCredentialId: null,
          credentialReference: 'credentials:credential-project',
          credentialVersion: Date.parse(CATALOG_LAST_SEEN_AT),
          externalSourceRef: null,
          status: 'active',
        },
      ]
    );

    const cpx31 = model.catalog.find((offering) => offering.sku === 'cpx31');
    expect(cpx31).toMatchObject({
      candidateId: 'candidate-cpx31',
      candidateStatus: 'deleted',
      canUpdateExistingCandidate: true,
      machineSizeHint: null,
    });
    expect(model.catalog.map((offering) => offering.sku)).toEqual(
      expect.arrayContaining(['cx22', 'cpx31', 'ccx33', 'stale-16c-64gb'])
    );
    expect(model.catalog.map((offering) => offering.sku)).not.toEqual(
      expect.arrayContaining(['small', 'medium', 'large'])
    );
  });

  it('does not hide provider-native catalog rows that have not been reconciled yet', () => {
    const model = buildComputePoolOfferingsModel([], [catalog()], []);

    const catalogOnly = model.catalog.find((offering) => offering.sku === 'stale-16c-64gb');
    expect(catalogOnly).toMatchObject({
      candidateId: null,
      candidateStatus: 'not-configured',
      canUpdateExistingCandidate: false,
    });
  });
});
