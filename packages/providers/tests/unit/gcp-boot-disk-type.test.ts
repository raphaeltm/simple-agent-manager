/**
 * GCP nodes boot from a `pd-balanced` disk in the zone they are created in.
 *
 * Compute Engine gives an API-created disk with no type `pd-standard`. Every case drives the real
 * `GcpProvider.createVM` and reads the `instances.insert` body and URL it sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import { DEFAULT_GCP_BOOT_DISK_TYPE } from '../../src/gcp-metadata';
import { HetznerProvider } from '../../src/hetzner';
import { ProviderError, type VMConfig } from '../../src/types';

const DEFAULT_ZONE = 'us-central1-a';
const STOCKOUT_MESSAGE =
  "The zone 'projects/test-project/zones/us-central1-a' does not have enough resources available to fulfill the request.  Try a different zone, or try again later.";

interface Insert {
  zone: string;
  body: {
    machineType: string;
    disks: Array<{
      boot: boolean;
      autoDelete: boolean;
      initializeParams: { diskType?: string; diskSizeGb: string; sourceImage: string };
    }>;
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Stub Compute Engine. Inserts into a zone listed in `stockedOut` finish with a stockout. */
function stubCompute(inserts: Insert[], stockedOut: ReadonlySet<string> = new Set()): void {
  globalThis.fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url.endsWith('/global/firewalls') && method === 'POST') {
      return json(
        { error: { code: 409, message: 'already exists', status: 'ALREADY_EXISTS' } },
        409
      );
    }
    const insert = /\/zones\/([a-z0-9-]+)\/instances$/.exec(url);
    if (insert && method === 'POST') {
      const zone = insert[1]!;
      inserts.push({ zone, body: JSON.parse(String(init.body)) as Insert['body'] });
      return json({ name: `op-${zone}`, status: 'PENDING', operationType: 'insert' });
    }
    const op = /\/zones\/([a-z0-9-]+)\/operations\/op-/.exec(url);
    if (op) {
      const zone = op[1]!;
      if (stockedOut.has(zone)) {
        return json({
          name: `op-${zone}`,
          operationType: 'insert',
          status: 'DONE',
          error: { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: STOCKOUT_MESSAGE }] },
        });
      }
      return json({ name: `op-${zone}`, status: 'DONE' });
    }
    const read = /\/zones\/([a-z0-9-]+)\/instances\/([a-z0-9-]+)$/.exec(url);
    if (read && method === 'GET') {
      return json({
        id: '1',
        name: read[2],
        status: 'RUNNING',
        zone: `projects/test-project/zones/${read[1]}`,
        machineType: `zones/${read[1]}/machineTypes/e2-standard-4`,
        creationTimestamp: '2026-11-11T00:00:00Z',
        networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
      });
    }
    // Machine-type lookup for observed hardware; not under test here.
    if (url.includes('/machineTypes/')) return json({ guestCpus: 4, memoryMb: 16_384 });
    throw new Error(`unexpected request ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function vmConfig(overrides: Partial<VMConfig> = {}): VMConfig {
  return { name: 'node-disk', size: 'large', userData: '#cloud-config', ...overrides };
}

function bootDisk(insert: Insert) {
  const disk = insert.body.disks[0];
  expect(disk?.boot).toBe(true);
  return disk!.initializeParams;
}

describe('GCP boot disk type', () => {
  it('creates the boot disk as pd-balanced in the provider default zone', async () => {
    const inserts: Insert[] = [];
    stubCompute(inserts);
    const provider = new GcpProvider('test-project', async () => 'token', DEFAULT_ZONE);

    await provider.createVM(vmConfig());

    expect(DEFAULT_GCP_BOOT_DISK_TYPE).toBe('pd-balanced');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.zone).toBe(DEFAULT_ZONE);
    expect(bootDisk(inserts[0]!)).toEqual({
      sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
      diskSizeGb: '50',
      diskType: `zones/${DEFAULT_ZONE}/diskTypes/pd-balanced`,
    });
  });

  it('names the zone the instance is inserted into, not the provider default zone', async () => {
    const inserts: Insert[] = [];
    stubCompute(inserts);
    const provider = new GcpProvider('test-project', async () => 'token', DEFAULT_ZONE);

    await provider.createVM(
      vmConfig({ location: 'europe-west3-b', instanceType: 'n2d-standard-4' })
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.zone).toBe('europe-west3-b');
    expect(inserts[0]!.body.machineType).toBe('zones/europe-west3-b/machineTypes/n2d-standard-4');
    expect(bootDisk(inserts[0]!).diskType).toBe('zones/europe-west3-b/diskTypes/pd-balanced');
  });

  it('follows the zone when a stockout sends the next attempt to another zone', async () => {
    const inserts: Insert[] = [];
    stubCompute(inserts, new Set([DEFAULT_ZONE]));
    const provider = new GcpProvider('test-project', async () => 'token', DEFAULT_ZONE);

    const stockout = await provider.createVM(vmConfig({ location: DEFAULT_ZONE })).then(
      () => null,
      (e: unknown) => e
    );
    expect(stockout).toBeInstanceOf(ProviderError);
    expect((stockout as ProviderError).category).toBe('transient_capacity');
    expect((stockout as ProviderError).providerCode).toBe('ZONE_RESOURCE_POOL_EXHAUSTED');
    expect((stockout as ProviderError).message).toContain('does not have enough resources');

    // The TaskRunner descends to the next offering by calling createVM again with its location;
    // the provider itself never changes zone within one call.
    const created = await provider.createVM(vmConfig({ location: 'us-central1-c' }));
    expect(created.name).toBe('node-disk');

    expect(inserts.map((i) => [i.zone, bootDisk(i).diskType])).toEqual([
      [DEFAULT_ZONE, `zones/${DEFAULT_ZONE}/diskTypes/pd-balanced`],
      ['us-central1-c', 'zones/us-central1-c/diskTypes/pd-balanced'],
    ]);
  });

  it('keeps a requested boot disk size alongside the disk type', async () => {
    const inserts: Insert[] = [];
    stubCompute(inserts);
    const provider = new GcpProvider('test-project', async () => 'token', DEFAULT_ZONE);

    await provider.createVM(
      vmConfig({
        size: undefined,
        location: DEFAULT_ZONE,
        native: { instanceType: 'e2-standard-4', bootDiskSizeGb: 120 },
      })
    );

    expect(bootDisk(inserts[0]!)).toMatchObject({
      diskSizeGb: '120',
      diskType: `zones/${DEFAULT_ZONE}/diskTypes/pd-balanced`,
    });
  });

  // Pins existing classification (not the disk type change): pd-balanced draws on the regional
  // SSD_TOTAL_GB quota, and running out of it must reach the TaskRunner as quota_exceeded.
  it('reports an exhausted SSD quota as quota_exceeded', async () => {
    const message = "Quota 'SSD_TOTAL_GB' exceeded.  Limit: 500.0 in region us-central1.";
    globalThis.fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/global/firewalls')) {
        return json(
          { error: { code: 409, message: 'already exists', status: 'ALREADY_EXISTS' } },
          409
        );
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        return json({ name: 'op-quota', status: 'PENDING', operationType: 'insert' });
      }
      if (url.includes('/operations/op-quota')) {
        return json({
          name: 'op-quota',
          operationType: 'insert',
          status: 'DONE',
          error: { errors: [{ code: 'QUOTA_EXCEEDED', message }] },
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const provider = new GcpProvider('test-project', async () => 'token', DEFAULT_ZONE);

    const err = await provider.createVM(vmConfig()).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).category).toBe('quota_exceeded');
    expect((err as ProviderError).providerCode).toBe('QUOTA_EXCEEDED');
    expect((err as ProviderError).message).toContain("Quota 'SSD_TOTAL_GB' exceeded");
  });
});

describe('other providers (control)', () => {
  it('Hetzner create requests carry no GCP disk type', async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
      if (init.body) bodies.push(String(init.body));
      return json({
        server: {
          id: 1,
          name: 'node-disk',
          status: 'running',
          public_net: { ipv4: { ip: '203.0.113.10' } },
          server_type: { name: 'cx33', cores: 4, memory: 8, disk: 80 },
          created: '2026-11-11T00:00:00Z',
          labels: {},
        },
      });
    }) as unknown as typeof fetch;

    const created = await new HetznerProvider('token', 'fsn1', undefined, false).createVM(
      vmConfig({ size: undefined, location: 'fsn1', native: { instanceType: 'cx33' } })
    );

    expect(created.serverType).toBe('cx33');
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).server_type).toBe('cx33');
    expect(bodies[0]).not.toMatch(/diskType|pd-balanced/);
  });
});
