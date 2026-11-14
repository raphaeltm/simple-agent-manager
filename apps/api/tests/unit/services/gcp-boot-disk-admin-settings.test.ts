/**
 * The GCP boot disk policy is admin-editable at runtime (policy 9017df94): an admin edit through
 * the real settings writer reaches every GcpProvider the API builds, without a deploy.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { updateAdminSettings } from '../../../src/services/admin-settings';
import {
  createGcpProviderForEnv,
  resolveGcpBootDiskPolicy,
} from '../../../src/services/gcp-provider-factory';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const ZONE = 'europe-west1-b';
let sqlite: Database.Database;
let env: Env;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  sqlite.close();
  globalThis.fetch = originalFetch;
});

function stubCompute(inserted: string[]) {
  globalThis.fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/aggregated/machineTypes')) {
      return json({
        items: {
          [`zones/${ZONE}`]: {
            machineTypes: [{ name: 't2d-standard-8', zone: ZONE, guestCpus: 8, memoryMb: 32_768 }],
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
    if (url.includes('/instances/node-1')) {
      return json({
        id: '1',
        name: 'node-1',
        status: 'RUNNING',
        creationTimestamp: '2026-11-14T00:00:00Z',
        machineType: `zones/${ZONE}/machineTypes/t2d-standard-8`,
        networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
      });
    }
    if (url.includes('/machineTypes/t2d-standard-8'))
      return json({ guestCpus: 8, memoryMb: 32_768 });
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;
}

async function sizes(): Promise<{ advertised: number | undefined; created: string | undefined }> {
  const inserted: string[] = [];
  stubCompute(inserted);
  const provider = await createGcpProviderForEnv(
    env,
    { gcpProjectId: 'p', defaultZone: ZONE },
    async () => 'token',
    { machineTypes: ['t2d-standard-8'], priceTable: async () => null }
  );
  const [offering] = await provider.listInstanceOfferings({
    preferApi: true,
    allowStaticFallback: false,
  });
  await provider.createVM({
    name: 'node-1',
    location: ZONE,
    userData: '#cloud-config\n',
    native: { instanceType: 't2d-standard-8' },
  });
  return { advertised: offering?.diskGb, created: inserted[0] };
}

describe('GCP boot disk admin settings', () => {
  it('defaults to 20 GB per vCPU with a 50 GB floor', async () => {
    expect(await resolveGcpBootDiskPolicy(env)).toEqual({ gbPerVcpu: 20, minGb: 50 });
    expect(await sizes()).toEqual({ advertised: 160, created: '160' });
  });

  it('an admin edit changes the advertised and created size', async () => {
    await updateAdminSettings(env, {
      changes: [
        { name: 'gcpCatalog.bootDiskGbPerVcpu', value: 30 },
        { name: 'gcpCatalog.bootDiskMinGb', value: 300 },
      ],
      actorUserId: 'admin',
    });
    expect(await resolveGcpBootDiskPolicy(env)).toEqual({ gbPerVcpu: 30, minGb: 300 });
    // max(300, 30 x 8): the floor wins for this machine.
    expect(await sizes()).toEqual({ advertised: 300, created: '300' });
  });

  it('rejects values outside the registered ranges', async () => {
    await expect(
      updateAdminSettings(env, {
        changes: [{ name: 'gcpCatalog.bootDiskMinGb', value: 5 }],
        actorUserId: 'admin',
      })
    ).rejects.toThrow();
    expect(await resolveGcpBootDiskPolicy(env)).toEqual({ gbPerVcpu: 20, minGb: 50 });
  });
});
