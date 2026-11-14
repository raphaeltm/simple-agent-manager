import { vi } from 'vitest';

/**
 * A stubbed Compute API for one zone offering t2d-standard-8: the live catalog read, the firewall
 * ensure, the instance insert (recording each boot disk size) and the instance read-back (which
 * reports the last inserted disk). Shared by the GCP boot disk tests.
 */
export function stubGcpCompute(zone: string, inserted: string[] = []): string[] {
  globalThis.fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/aggregated/machineTypes')) {
      return json({
        items: {
          [`zones/${zone}`]: {
            machineTypes: [{ name: 't2d-standard-8', zone, guestCpus: 8, memoryMb: 32_768 }],
          },
        },
      });
    }
    if (url.endsWith('/global/firewalls') && init.method === 'POST') {
      return json({ error: { code: 409, message: 'exists' } }, 409);
    }
    if (url.endsWith('/instances') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        disks: Array<{ initializeParams: { diskSizeGb: string } }>;
      };
      inserted.push(body.disks[0]!.initializeParams.diskSizeGb);
      return json({ name: 'op-1', status: 'PENDING' });
    }
    if (url.includes('/operations/')) return json({ name: 'op-1', status: 'DONE' });
    const instance = /\/instances\/([a-z0-9-]+)$/.exec(url);
    if (instance) {
      return json({
        id: '1',
        name: instance[1],
        status: 'RUNNING',
        creationTimestamp: '2026-11-14T00:00:00Z',
        machineType: `zones/${zone}/machineTypes/t2d-standard-8`,
        disks: [{ boot: true, diskSizeGb: inserted.at(-1) }],
        networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
      });
    }
    if (url.includes('/machineTypes/t2d-standard-8')) {
      return json({ guestCpus: 8, memoryMb: 32_768 });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;
  return inserted;
}
