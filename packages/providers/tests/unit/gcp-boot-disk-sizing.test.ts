/**
 * GCP boot disk sizing: one policy (`gcpBootDiskSizeGb`) decides the disk the catalog advertises,
 * the disk the price includes, and the disk `createVM` inserts. Fixtures follow the Compute
 * `machineTypes.aggregatedList` and Cloud Billing `services.skus.list` shapes; the disk SKU
 * descriptions and unit (`GiBy.mo`) were read from the live catalog on 2026-11-14.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import {
  DEFAULT_GCP_BOOT_DISK_POLICY,
  gcpBootDiskSizeGb,
  gcpMachineTypeNamedVcpus,
  normalizeGcpBootDiskPolicy,
} from '../../src/gcp-boot-disk';
import {
  buildGcpPriceTable,
  type GcpPriceTable,
  parseGcpUnitSku,
  parseStoredGcpPriceTable,
} from '../../src/gcp-pricing';
import type { VMConfig } from '../../src/types';

const ZONE = 'europe-west1-b';
const T2D_CORE = 0.027502;
const T2D_RAM = 0.003686;
const BALANCED_GIB_MONTH = 0.11;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function diskSku(description: string, regions: string[], price: number, unit = 'GiBy.mo') {
  return {
    description,
    category: { resourceFamily: 'Storage', resourceGroup: 'SSD', usageType: 'OnDemand' },
    serviceRegions: regions,
    pricingInfo: [
      {
        pricingExpression: {
          usageUnit: unit,
          tieredRates: [
            { unitPrice: { currencyCode: 'USD', units: '0', nanos: Math.round(price * 1e9) } },
          ],
        },
      },
    ],
  };
}

describe('gcpBootDiskSizeGb', () => {
  it.each([
    [1, 50],
    [2, 50],
    [4, 80],
    [8, 160],
    [16, 320],
    [null, 50],
  ])('%s vCPUs get %s GB under the default policy', (vcpus, gb) => {
    expect(gcpBootDiskSizeGb(vcpus, DEFAULT_GCP_BOOT_DISK_POLICY)).toBe(gb);
  });

  it('follows an admin policy and clamps a degenerate one', () => {
    expect(gcpBootDiskSizeGb(8, { gbPerVcpu: 30, minGb: 60 })).toBe(240);
    expect(gcpBootDiskSizeGb(1, { gbPerVcpu: 30, minGb: 60 })).toBe(60);
    expect(normalizeGcpBootDiskPolicy({ gbPerVcpu: 0, minGb: 1 })).toEqual({
      gbPerVcpu: 20,
      minGb: 10,
    });
    expect(normalizeGcpBootDiskPolicy(undefined)).toEqual(DEFAULT_GCP_BOOT_DISK_POLICY);
  });

  it('reads vCPUs only from names that state them', () => {
    expect(gcpMachineTypeNamedVcpus('t2d-standard-8')).toBe(8);
    expect(gcpMachineTypeNamedVcpus('n2-highmem-4')).toBe(4);
    expect(gcpMachineTypeNamedVcpus('e2-medium')).toBeNull();
    expect(gcpMachineTypeNamedVcpus('e2-custom-4-8192')).toBeNull();
  });
});

describe('balanced disk prices', () => {
  it('parses zonal Balanced PD Capacity SKUs and skips regional and wrong-unit ones', () => {
    expect(
      parseGcpUnitSku(diskSku('Balanced PD Capacity in Netherlands', ['europe-west4'], 0.11))
    ).toMatchObject({ kind: 'BalancedDisk', regions: ['europe-west4'] });
    expect(
      parseGcpUnitSku(diskSku('Balanced PD Capacity', ['us-central1', 'europe-west1'], 0.1))
    ).toMatchObject({ kind: 'BalancedDisk', regions: ['us-central1', 'europe-west1'] });
    expect(
      parseGcpUnitSku(
        diskSku('Regional Balanced PD Capacity in Netherlands', ['europe-west4'], 0.22)
      )
    ).toBeNull();
    expect(
      parseGcpUnitSku(diskSku('Balanced PD Capacity', ['us-central1'], 0.1, 'GiBy.h'))
    ).toBeNull();
  });

  it('stores per-region disk prices, keeps conflicts unknown, and reads old tables', () => {
    const table = buildGcpPriceTable(
      [
        diskSku('Balanced PD Capacity', ['us-central1', 'europe-west1'], 0.1),
        diskSku('Balanced PD Capacity in Netherlands', ['europe-west4'], 0.11),
        diskSku('Balanced PD Capacity in Iowa', ['us-central1'], 0.12),
      ].map((sku) => parseGcpUnitSku(sku)!)
    );
    expect(table.balancedDiskGibMonthly).toEqual({
      'us-central1': null,
      'europe-west1': 0.1,
      'europe-west4': 0.11,
    });
    expect(parseStoredGcpPriceTable(JSON.parse(JSON.stringify(table)))).toEqual(table);
    // A table stored before disks were priced has no disk map and still parses.
    expect(parseStoredGcpPriceTable({ currency: 'USD', regions: {} })).toEqual({
      currency: 'USD',
      regions: {},
      balancedDiskGibMonthly: {},
    });
  });
});

describe('GcpProvider boot disk', () => {
  const machineTypes = {
    [`zones/${ZONE}`]: {
      machineTypes: [
        { name: 't2d-standard-8', zone: ZONE, guestCpus: 8, memoryMb: 32_768 },
        { name: 'e2-medium', zone: ZONE, guestCpus: 2, memoryMb: 4096, isSharedCpu: true },
        { name: 'n4-standard-4', zone: ZONE, guestCpus: 4, memoryMb: 16_384 },
      ],
    },
  };
  const table: GcpPriceTable = {
    currency: 'USD',
    regions: {
      'europe-west1': {
        t2d: { coreHourly: T2D_CORE, ramGibHourly: T2D_RAM },
        n4: { coreHourly: 0.03, ramGibHourly: 0.004 },
      },
    },
    balancedDiskGibMonthly: { 'europe-west1': BALANCED_GIB_MONTH },
  };

  function provider(policy = DEFAULT_GCP_BOOT_DISK_POLICY, priceTable: GcpPriceTable = table) {
    return new GcpProvider(
      'p',
      async () => 'token',
      ZONE,
      undefined,
      undefined,
      policy,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        machineTypes: ['t2d-standard-8', 'e2-medium', 'n4-standard-4'],
        priceTable: async () => priceTable,
      }
    );
  }

  /** Stubs the catalog read and the instance insert; returns the inserted disk sizes. */
  function stubCompute(): string[] {
    const inserted: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('/aggregated/machineTypes')) {
        return new Response(JSON.stringify({ items: machineTypes }));
      }
      if (url.endsWith('/global/firewalls') && init.method === 'POST') {
        return new Response(JSON.stringify({ error: { code: 409, message: 'exists' } }), {
          status: 409,
        });
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          disks: Array<{ initializeParams: { diskSizeGb: string } }>;
        };
        inserted.push(body.disks[0]!.initializeParams.diskSizeGb);
        return new Response(JSON.stringify({ name: 'op-1', status: 'PENDING' }));
      }
      if (url.includes('/operations/')) {
        return new Response(JSON.stringify({ name: 'op-1', status: 'DONE' }));
      }
      if (url.includes('/instances/node-1')) {
        return new Response(
          JSON.stringify({
            id: '1',
            name: 'node-1',
            status: 'RUNNING',
            creationTimestamp: '2026-11-14T00:00:00Z',
            machineType: `zones/${ZONE}/machineTypes/t2d-standard-8`,
            networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
          })
        );
      }
      if (url.includes('/machineTypes/t2d-standard-8')) {
        return new Response(JSON.stringify({ guestCpus: 8, memoryMb: 32_768 }));
      }
      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;
    return inserted;
  }

  const base: VMConfig = { name: 'node-1', location: ZONE, userData: '#cloud-config\n' };

  it('advertises the policy disk per machine type and prices it into the offering', async () => {
    stubCompute();
    const offerings = await provider().listInstanceOfferings({
      preferApi: true,
      allowStaticFallback: false,
    });
    const byType = new Map(offerings.map((o) => [o.providerInstanceType, o]));

    const t2d = byType.get('t2d-standard-8')!;
    expect(t2d).toMatchObject({ diskGb: 160, storageGb: 160 });
    const machineHourly = 8 * T2D_CORE + 32 * T2D_RAM;
    const diskHourly = (160 * BALANCED_GIB_MONTH) / 730;
    expect(t2d.priceHourly).toBeCloseTo(machineHourly + diskHourly, 9);
    expect(t2d.catalogMetadata).toMatchObject({
      priceSource: 'cloud-billing-catalog',
      bootDiskGb: 160,
    });

    expect(byType.get('e2-medium')).toMatchObject({ diskGb: 50 });
    // n4 boots from Hyperdisk, whose price the table does not hold: machine price alone.
    expect(byType.get('n4-standard-4')).toMatchObject({
      diskGb: 80,
      catalogMetadata: { priceSource: 'cloud-billing-catalog-machine-only' },
    });
    expect(byType.get('n4-standard-4')!.priceHourly).toBeCloseTo(4 * 0.03 + 16 * 0.004, 9);
  });

  it('keeps the machine price alone when the stored table has no disk price', async () => {
    stubCompute();
    const oldTable: GcpPriceTable = { currency: table.currency, regions: table.regions };
    const offerings = await provider(DEFAULT_GCP_BOOT_DISK_POLICY, oldTable).listInstanceOfferings({
      preferApi: true,
      allowStaticFallback: false,
    });
    const t2d = offerings.find((o) => o.providerInstanceType === 't2d-standard-8')!;
    expect(t2d.priceHourly).toBeCloseTo(8 * T2D_CORE + 32 * T2D_RAM, 9);
    expect(t2d.catalogMetadata).toMatchObject({
      priceSource: 'cloud-billing-catalog-machine-only',
    });
  });

  it('creates the planned disk: a pool plan carries the candidate disk as resources.diskGb', async () => {
    const inserted = stubCompute();
    await provider().createVM({
      ...base,
      native: {
        instanceType: 't2d-standard-8',
        resources: { vcpuCount: 8, memoryMb: 32_768, diskGb: 160 },
      },
    });
    // A plan made before the catalog refresh still says 50 GB: the VM matches its node row.
    await provider().createVM({
      ...base,
      native: {
        instanceType: 't2d-standard-8',
        resources: { vcpuCount: 8, memoryMb: 32_768, diskGb: 50 },
      },
    });
    expect(inserted).toEqual(['160', '50']);
  });

  it('sizes requests without a planned disk by the policy, and lets an explicit size win', async () => {
    const inserted = stubCompute();
    const custom = { gbPerVcpu: 30, minGb: 60 };
    await provider(custom).createVM({ ...base, native: { instanceType: 't2d-standard-8' } });
    await provider(custom).createVM({ ...base, instanceType: 'e2-medium' });
    await provider(custom).createVM({
      ...base,
      native: {
        instanceType: 't2d-standard-8',
        bootDiskSizeGb: 120,
        resources: { vcpuCount: 8, memoryMb: 32_768, diskGb: 160 },
      },
    });
    expect(inserted).toEqual(['240', '60', '120']);
  });

  it('applies the policy to the static catalog too', async () => {
    const offerings = await new GcpProvider('p', async () => 'token', ZONE, undefined, undefined, {
      gbPerVcpu: 30,
      minGb: 60,
    }).listInstanceOfferings({ preferApi: false });
    const large = offerings.find((o) => o.providerInstanceType === 'e2-standard-4')!;
    expect(large.diskGb).toBe(120);
  });
});
