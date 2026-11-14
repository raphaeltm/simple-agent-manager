/**
 * The GCP boot disk policy is admin-editable at runtime (policy 9017df94): an admin edit through
 * the real settings writer reaches every GcpProvider the API builds, without a deploy.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { updateAdminSettings } from '../../../src/services/admin-settings';
import {
  createGcpProviderForEnv,
  resolveGcpBootDiskPolicy,
} from '../../../src/services/gcp-provider-factory';
import { getStaticProviderCatalogOfferings } from '../../../src/services/provider-catalogs';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { stubGcpCompute } from '../../helpers/gcp-compute-stub';

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

function stubCompute(inserted: string[] = []) {
  stubGcpCompute(ZONE, inserted);
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

  it('falls back to the defaults when settings cannot be read, so providers still build', async () => {
    const broken = {
      ...env,
      DATABASE: {
        prepare: () => {
          throw new Error('D1 unavailable');
        },
        batch: () => Promise.reject(new Error('D1 unavailable')),
      },
    } as unknown as Env;
    expect(await resolveGcpBootDiskPolicy(broken)).toEqual({ gbPerVcpu: 20, minGb: 50 });
    const provider = await createGcpProviderForEnv(
      broken,
      { gcpProjectId: 'p', defaultZone: ZONE },
      async () => 'token'
    );
    expect(provider.name).toBe('gcp');
  });

  it('re-sizes the static catalog fallback to the admin policy', async () => {
    await updateAdminSettings(env, {
      changes: [{ name: 'gcpCatalog.bootDiskGbPerVcpu', value: 30 }],
      actorUserId: 'admin',
    });
    const offerings = getStaticProviderCatalogOfferings('gcp', {
      gcpBootDiskPolicy: await resolveGcpBootDiskPolicy(env),
    });
    const large = offerings.find((offering) => offering.providerInstanceType === 'e2-standard-4');
    expect(large?.diskGb).toBe(120);
    // Without a policy the default applies, matching SIZE_MAP.
    expect(
      getStaticProviderCatalogOfferings('gcp').find(
        (offering) => offering.providerInstanceType === 'e2-standard-4'
      )?.diskGb
    ).toBe(80);
  });
});
