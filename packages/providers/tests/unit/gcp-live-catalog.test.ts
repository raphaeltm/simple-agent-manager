/**
 * Live GCP catalog: machine types from Compute `machineTypes.aggregatedList`, priced from the
 * Cloud Billing Catalog. Fixtures follow the documented response shapes
 * (https://cloud.google.com/billing/docs/reference/rest/v1/services.skus/list,
 * https://cloud.google.com/compute/docs/reference/rest/v1/machineTypes/aggregatedList), and the
 * us-central1 E2 unit rates reproduce Google's published monthly prices
 * (e2-standard-2 $48.91, e2-medium $24.46).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import { gcpMachineTypeFilter } from '../../src/gcp-catalog';
import {
  buildGcpPriceTable,
  fetchGcpComputePriceTable,
  type GcpPriceTable,
  parseGcpUnitSku,
  parseStoredGcpPriceTable,
} from '../../src/gcp-pricing';
import { ProviderError } from '../../src/types';

const E2_CORE = 0.021811;
const E2_RAM = 0.002923;

function sku(
  description: string,
  regions: string[],
  price: number,
  overrides: { usageType?: string; usageUnit?: string; currencyCode?: string } = {}
) {
  const units = Math.floor(price);
  return {
    name: `services/6F81-5844-456A/skus/${description.length}`,
    skuId: 'ABCD-1234-EF56',
    description,
    category: {
      serviceDisplayName: 'Compute Engine',
      resourceFamily: 'Compute',
      resourceGroup: description.includes('Ram') ? 'RAM' : 'CPU',
      usageType: overrides.usageType ?? 'OnDemand',
    },
    serviceRegions: regions,
    pricingInfo: [
      {
        summary: '',
        pricingExpression: {
          usageUnit: overrides.usageUnit ?? (description.includes('Ram') ? 'GiBy.h' : 'h'),
          displayQuantity: 1,
          tieredRates: [
            {
              startUsageAmount: 0,
              unitPrice: {
                currencyCode: overrides.currencyCode ?? 'USD',
                units: String(units),
                nanos: Math.round((price - units) * 1e9),
              },
            },
          ],
        },
        aggregationInfo: { aggregationLevel: 'ACCOUNT', aggregationInterval: 'DAILY' },
        currencyConversionRate: 1,
        effectiveTime: '2026-11-01T00:00:00Z',
      },
    ],
    serviceProviderName: 'Google',
  };
}

describe('parseGcpUnitSku', () => {
  it('parses on-demand core and RAM SKUs for each vendor spelling', () => {
    expect(
      parseGcpUnitSku(sku('E2 Instance Core running in Americas', ['us-central1'], E2_CORE))
    ).toMatchObject({ series: 'e2', kind: 'Core', regions: ['us-central1'] });
    expect(
      parseGcpUnitSku(sku('N2D AMD Instance Ram running in Belgium', ['europe-west1'], 0.004))
    ).toMatchObject({ series: 'n2d', kind: 'Ram' });
    expect(
      parseGcpUnitSku(sku('T2A Arm Instance Core running in Americas', ['us-central1'], 0.02))
    ).toMatchObject({ series: 't2a', kind: 'Core' });
    expect(
      parseGcpUnitSku(sku('C3 Instance Core running in Americas', ['us-central1'], 0.03))
    ).toMatchObject({ series: 'c3' });
  });

  it.each([
    ['Spot Preemptible E2 Instance Core running in Americas', {}],
    ['N2D AMD Custom Instance Core running in Americas', {}],
    ['N2D AMD Sole Tenancy Instance Core running in Americas', {}],
    ['Commitment v1: E2 Cpu in Americas for 1 Year', {}],
    ['E2 Instance Core running in Americas', { usageType: 'Commit1Yr' }],
    ['E2 Instance Core running in Americas', { usageUnit: 'GiBy.h' }],
    ['E2 Instance Ram running in Americas', { usageUnit: 'h' }],
    ['E2 Instance Core running in Americas', { currencyCode: 'EUR' }],
  ])('skips %s %j', (description, overrides) => {
    expect(parseGcpUnitSku(sku(description, ['us-central1'], E2_CORE, overrides))).toBeNull();
  });

  it('skips a zero price and a SKU without regions', () => {
    expect(
      parseGcpUnitSku(sku('E2 Instance Core running in Americas', ['us-central1'], 0))
    ).toBeNull();
    expect(parseGcpUnitSku(sku('E2 Instance Core running in Americas', [], E2_CORE))).toBeNull();
  });
});

describe('buildGcpPriceTable', () => {
  it('makes a conflicting unit unknown instead of picking one price', () => {
    const table = buildGcpPriceTable(
      [
        sku('E2 Instance Core running in Americas', ['us-central1', 'us-east1'], E2_CORE),
        sku('E2 Instance Core running in Iowa', ['us-central1'], 0.03),
        sku('E2 Instance Ram running in Americas', ['us-central1'], E2_RAM),
      ].map((s) => parseGcpUnitSku(s)!)
    );
    expect(table.regions['us-central1']?.e2).toEqual({ coreHourly: null, ramGibHourly: E2_RAM });
    expect(table.regions['us-east1']?.e2?.coreHourly).toBeCloseTo(E2_CORE, 10);
  });

  it('round-trips through the stored form and rejects a malformed one', () => {
    const table = buildGcpPriceTable([
      parseGcpUnitSku(sku('E2 Instance Core running in Americas', ['us-central1'], E2_CORE))!,
    ]);
    expect(parseStoredGcpPriceTable(JSON.parse(JSON.stringify(table)))).toEqual(table);
    expect(parseStoredGcpPriceTable({ currency: 'EUR', regions: {} })).toBeNull();
    expect(parseStoredGcpPriceTable({ currency: 'USD', regions: { x: 'y' } })).toBeNull();
  });
});

describe('fetchGcpComputePriceTable', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads every page with the bearer token and builds the table', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/services/6F81-5844-456A/skus');
      expect(url.searchParams.get('currencyCode')).toBe('USD');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
      if (!url.searchParams.get('pageToken')) {
        return new Response(
          JSON.stringify({
            skus: [
              sku('E2 Instance Core running in Americas', ['us-central1'], E2_CORE),
              { description: 'GPU thing' },
            ],
            nextPageToken: 'p2',
          })
        );
      }
      return new Response(
        JSON.stringify({
          skus: [sku('E2 Instance Ram running in Americas', ['us-central1'], E2_RAM)],
        })
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const table = await fetchGcpComputePriceTable('token-1', {
      maxPages: 5,
      requestTimeoutMs: 1000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(table.regions['us-central1']?.e2?.coreHourly).toBeCloseTo(E2_CORE, 10);
    expect(table.regions['us-central1']?.e2?.ramGibHourly).toBeCloseTo(E2_RAM, 10);
  });

  it('fails rather than returning a partial table past the page limit', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ skus: [], nextPageToken: `p${(n += 1)}` }))
    ) as unknown as typeof fetch;
    await expect(
      fetchGcpComputePriceTable('t', { maxPages: 3, requestTimeoutMs: 1000 })
    ).rejects.toThrow(/exceeded 3 pages/);
  });

  it('fails on a repeated page token', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ skus: [], nextPageToken: 'same' }))
    ) as unknown as typeof fetch;
    await expect(
      fetchGcpComputePriceTable('t', { maxPages: 5, requestTimeoutMs: 1000 })
    ).rejects.toThrow(/repeated/);
  });

  it('surfaces a disabled Cloud Billing API as a provider error', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message:
                'Cloud Billing API has not been used in project 123 before or it is disabled.',
              status: 'PERMISSION_DENIED',
            },
          }),
          { status: 403 }
        )
    ) as unknown as typeof fetch;
    await expect(
      fetchGcpComputePriceTable('t', { maxPages: 5, requestTimeoutMs: 1000 })
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('gcpMachineTypeFilter', () => {
  it('builds an exact-name RE2 filter', () => {
    expect(gcpMachineTypeFilter(['e2-medium', 'n2d-standard-4'])).toBe(
      'name eq "(e2-medium|n2d-standard-4)"'
    );
  });

  it.each([[[]], [['e2-.*']], [['E2-medium']], [['e2-medium") OR (x']]])('refuses %j', (names) => {
    expect(() => gcpMachineTypeFilter(names as string[])).toThrow(ProviderError);
  });
});

describe('GcpProvider live offerings', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const machineType = (
    name: string,
    zone: string,
    guestCpus: number,
    memoryMb: number,
    extra: Record<string, unknown> = {}
  ) => ({
    kind: 'compute#machineType',
    id: '1',
    name,
    description: name,
    guestCpus,
    memoryMb,
    zone,
    selfLink: `https://compute.googleapis.com/compute/v1/projects/p/zones/${zone}/machineTypes/${name}`,
    ...extra,
  });

  const priceTable: GcpPriceTable = {
    currency: 'USD',
    regions: { 'us-central1': { e2: { coreHourly: E2_CORE, ramGibHourly: E2_RAM } } },
  };

  function stubMachineTypes(items: Record<string, unknown>) {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/compute/v1/projects/p/aggregated/machineTypes');
      expect(url.searchParams.get('filter')).toBe(
        'name eq "(e2-medium|e2-standard-2|n2d-standard-2)"'
      );
      return new Response(JSON.stringify({ items }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function provider(
    priceSource: (() => Promise<GcpPriceTable | null>) | undefined = async () => priceTable
  ) {
    return new GcpProvider(
      'p',
      async () => 'token',
      'us-central1-a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        machineTypes: ['e2-medium', 'e2-standard-2', 'n2d-standard-2'],
        priceTable: priceSource,
      }
    );
  }

  it('offers every listed type in every zone Google reports, priced per region', async () => {
    stubMachineTypes({
      'zones/us-central1-a': {
        machineTypes: [
          machineType('e2-standard-2', 'us-central1-a', 2, 8192),
          machineType('e2-medium', 'us-central1-a', 2, 4096, { isSharedCpu: true }),
          machineType('e2-standard-2', 'us-central1-a', 2, 8192, { name: 'e2-micro' }),
        ],
      },
      'zones/northamerica-northeast2-b': {
        machineTypes: [machineType('n2d-standard-2', 'northamerica-northeast2-b', 2, 8192)],
      },
      'zones/us-east1-b': { warning: { code: 'NO_RESULTS_ON_PAGE', message: 'none' } },
    });

    const offerings = await provider().listInstanceOfferings({
      preferApi: true,
      allowStaticFallback: false,
    });

    expect(offerings.map((o) => `${o.location}/${o.providerInstanceType}`)).toEqual([
      'us-central1-a/e2-standard-2',
      'us-central1-a/e2-medium',
      'northamerica-northeast2-b/n2d-standard-2',
    ]);
    const standard = offerings[0]!;
    expect(standard).toMatchObject({
      catalogSource: 'api',
      currency: 'USD',
      vcpu: 2,
      memoryMb: 8192,
      machineSize: 'medium',
      price: '$48.91/mo',
    });
    expect(standard.priceMonthly).toBeCloseTo(48.91, 2);
    // Shared-core: Google shows 2 vCPUs and bills 1.
    expect(offerings[1]?.priceMonthly).toBeCloseTo(24.46, 2);
    // No price for the region/series: offered, unpriced, never a guessed number.
    expect(offerings[2]).toMatchObject({
      currency: null,
      priceMonthly: null,
      price: 'Price unavailable',
      catalogMetadata: { priceSource: 'unavailable', region: 'northamerica-northeast2' },
    });
  });

  it('skips deprecated machine types', async () => {
    stubMachineTypes({
      'zones/us-central1-a': {
        machineTypes: [
          machineType('e2-standard-2', 'us-central1-a', 2, 8192, {
            deprecated: { state: 'DEPRECATED' },
          }),
          machineType('e2-medium', 'us-central1-a', 2, 4096, {
            isSharedCpu: true,
            deprecated: { state: 'ACTIVE' },
          }),
        ],
      },
    });
    const offerings = await provider().listInstanceOfferings({
      preferApi: true,
      allowStaticFallback: false,
    });
    expect(offerings.map((o) => o.providerInstanceType)).toEqual(['e2-medium']);
  });

  it('a failing price source leaves offerings unpriced instead of failing the catalog', async () => {
    stubMachineTypes({
      'zones/us-central1-a': {
        machineTypes: [machineType('e2-standard-2', 'us-central1-a', 2, 8192)],
      },
    });
    const offerings = await provider(async () => {
      throw new Error('price cache unreadable');
    }).listInstanceOfferings({ preferApi: true, allowStaticFallback: false });
    expect(offerings).toHaveLength(1);
    expect(offerings[0]).toMatchObject({ catalogSource: 'api', priceMonthly: null });
  });

  it('an unreachable zone fails the live catalog rather than reading it as sold out', async () => {
    stubMachineTypes({
      'zones/us-central1-a': {
        machineTypes: [machineType('e2-standard-2', 'us-central1-a', 2, 8192)],
      },
      'zones/europe-west3-a': {
        warning: {
          code: 'UNREACHABLE',
          message: 'unreachable',
          data: [{ key: 'scope', value: 'zones/europe-west3-a' }],
        },
      },
    });
    await expect(
      provider().listInstanceOfferings({ preferApi: true, allowStaticFallback: false })
    ).rejects.toThrow(/machine type list is incomplete: unreachable zones\/europe-west3-a/);
  });

  it('a zone scope with neither machine types nor a warning fails the live catalog', async () => {
    stubMachineTypes({
      'zones/us-central1-a': {
        machineTypes: [machineType('e2-standard-2', 'us-central1-a', 2, 8192)],
      },
      'zones/us-east1-b': {},
    });
    await expect(
      provider().listInstanceOfferings({ preferApi: true, allowStaticFallback: false })
    ).rejects.toThrow(/expected machineTypes or warning/);
  });

  it('a response without items fails the live catalog rather than reading it as empty', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({}))
    ) as unknown as typeof fetch;
    await expect(
      provider().listInstanceOfferings({ preferApi: true, allowStaticFallback: false })
    ).rejects.toThrow(/expected items/);
  });

  it('skips Arm machine types, which cannot boot the amd64 image', async () => {
    stubMachineTypes({
      'zones/us-central1-a': {
        machineTypes: [
          machineType('e2-standard-2', 'us-central1-a', 2, 8192, { architecture: 'X86_64' }),
          machineType('n2d-standard-2', 'us-central1-a', 2, 8192, { architecture: 'ARM64' }),
        ],
      },
    });
    const offerings = await provider().listInstanceOfferings({
      preferApi: true,
      allowStaticFallback: false,
    });
    expect(offerings.map((o) => o.providerInstanceType)).toEqual(['e2-standard-2']);
  });

  it('falls back to the static table when allowed and the live call fails', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })
    ) as unknown as typeof fetch;
    const offerings = await provider().listInstanceOfferings({ preferApi: true });
    expect(offerings.every((o) => o.catalogSource === 'static')).toBe(true);
  });

  it('is API-backed only when built with catalog options', () => {
    expect(provider().instanceOfferingApiBacked).toBe(true);
    expect(new GcpProvider('p', async () => 't').instanceOfferingApiBacked).toBe(false);
  });

  it('preferApi false returns the static table without calling Google', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const offerings = await provider().listInstanceOfferings({ preferApi: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(offerings.every((o) => o.catalogSource === 'static')).toBe(true);
  });
});
