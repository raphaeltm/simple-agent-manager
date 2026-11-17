/**
 * #2842: the Infomaniak boot volume size is an admin setting (policy 9017df94). An edit through the
 * real settings writer must reach the catalog the scheduler reads AND the VM the provisioning path
 * creates, so a pool candidate's disk is the disk the node gets.
 */
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { updateAdminSettings } from '../../../src/services/admin-settings';
import { encrypt } from '../../../src/services/encryption';
import {
  buildProviderConfigForEnv,
  resolveInfomaniakBootVolumeGb,
} from '../../../src/services/infomaniak-provider-settings';
import { getStaticProviderCatalogOfferings } from '../../../src/services/provider-catalogs';
import { createCatalogProvider } from '../../../src/services/provider-catalogs-build';
import {
  createProviderForUser,
  serializeCredentialToken,
} from '../../../src/services/provider-credentials';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSchemaTables } from '../../helpers/sqlite-d1';

const AUTH_URL = 'https://identity.test/v3';
const COMPUTE = 'https://compute.test/v2.1/project';
const IMAGE = 'https://image.test';
const NETWORK = 'https://network.test';
const TOKEN = serializeCredentialToken('infomaniak', {
  applicationCredentialId: 'app-cred-id',
  applicationCredentialSecret: 'app-cred-secret',
});

let sqlite: Database.Database;
let env: Env;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Fake Keystone + Nova. Returns the boot volume size of every server create. */
function stubOpenStack(): number[] {
  const createdSizes: number[] = [];
  let lastMetadata: Record<string, string> = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/auth/tokens')) {
      const catalog = [
        ['compute', COMPUTE],
        ['volumev3', 'https://volume.test/v3/project'],
        ['image', IMAGE],
        ['network', NETWORK],
      ].map(([type, endpoint]) => ({
        type,
        endpoints: [{ region: 'dc4-a', interface: 'public', url: endpoint }],
      }));
      return json({ token: { project: { id: 'project' }, catalog } }, 201, {
        'x-subject-token': 'subject-token',
      });
    }
    if (url.startsWith(`${IMAGE}/v2/images?name=`))
      return json({ images: [{ id: 'image-1', name: 'Ubuntu 24.04 noble' }] });
    if (url.startsWith(`${COMPUTE}/flavors/detail?name=`)) {
      const name = decodeURIComponent(url.split('name=')[1] ?? '');
      return json({ flavors: [{ id: 'flavor-1', name }] });
    }
    if (url.startsWith(`${NETWORK}/v2.0/networks?name=`))
      return json({ networks: [{ id: 'network-1', name: 'ext-net1' }] });
    if (url === `${COMPUTE}/servers` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        server: {
          block_device_mapping_v2: Array<{ volume_size: number }>;
          metadata: Record<string, string>;
        };
      };
      createdSizes.push(body.server.block_device_mapping_v2[0]?.volume_size ?? -1);
      lastMetadata = body.server.metadata;
      return json({ server: { id: 'server-1' } }, 202);
    }
    if (url === `${COMPUTE}/servers/server-1`)
      return json({
        server: {
          id: 'server-1',
          name: 'node-1',
          status: 'ACTIVE',
          addresses: { 'ext-net1': [{ version: 4, addr: '203.0.113.10' }] },
          flavor: { id: 'flavor-1', original_name: 'a4-ram8-disk20-perf1', vcpus: 4, ram: 8192, disk: 20 },
          image: '',
          created: '2026-11-17T00:00:00Z',
          metadata: lastMetadata,
        },
      });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  return createdSizes;
}

const testEnv = (): Env => ({ ...env, INFOMANIAK_AUTH_URL: AUTH_URL }) as Env;

beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
  createSchemaTables(sqlite, [schema.users, schema.credentials]);
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

async function setBootVolumeGb(value: number) {
  await updateAdminSettings(env, {
    changes: [{ name: 'infomaniak.bootVolumeGb', value }],
    actorUserId: 'admin',
  });
}

async function seedPlatformInfomaniakCredential() {
  const { ciphertext, iv } = await encrypt(TOKEN, env.ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
       VALUES ('admin', 'admin@example.test', 'Admin', 1, 0, 0)`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO platform_credentials
         (id, credential_type, provider, credential_kind, label, encrypted_token, iv, is_enabled, created_by)
       VALUES ('pc-1', 'cloud-provider', 'infomaniak', 'api-key', 'Infomaniak', ?, ?, 1, 'admin')`
    )
    .run(ciphertext, iv);
}

/** What the catalog advertises vs. what the provisioning path creates and reads back. */
async function sizes() {
  const created = stubOpenStack();
  const catalogProvider = await createCatalogProvider('infomaniak', TOKEN, testEnv());
  const [offering] = await catalogProvider.listInstanceOfferings({
    preferApi: true,
    allowStaticFallback: false,
  });
  const resolved = await createProviderForUser(
    drizzle(env.DATABASE, { schema }),
    'user-without-own-credential',
    env.ENCRYPTION_KEY,
    testEnv()
  );
  if (!resolved) throw new Error('expected the platform Infomaniak credential to resolve');
  expect(resolved).toMatchObject({ providerName: 'infomaniak', credentialSource: 'platform' });
  const vm = await resolved.provider.createVM({
    name: 'node-1',
    location: 'dc4-a',
    userData: '#cloud-config\n',
    size: 'medium',
  });
  const observed = vm.observedHardware.resources;
  return {
    advertised: offering?.diskGb,
    created: created[0],
    observed: observed.source === 'observed' ? observed.value?.diskGb : null,
  };
}

describe('Infomaniak boot volume admin setting', () => {
  it('defaults to 80 GB for the catalog, the created volume and the observed disk', async () => {
    await seedPlatformInfomaniakCredential();
    expect(await resolveInfomaniakBootVolumeGb(env)).toBe(80);
    expect(await sizes()).toEqual({ advertised: 80, created: 80, observed: 80 });
  });

  it('an admin edit changes all three without a deploy', async () => {
    await seedPlatformInfomaniakCredential();
    await setBootVolumeGb(150);
    expect(await resolveInfomaniakBootVolumeGb(env)).toBe(150);
    expect(await sizes()).toEqual({ advertised: 150, created: 150, observed: 150 });
  });

  it.each([19, 4_097, 40.5])('rejects %s and keeps the previous value', async (value) => {
    await expect(setBootVolumeGb(value)).rejects.toThrow();
    expect(await resolveInfomaniakBootVolumeGb(env)).toBe(80);
  });

  it('falls back to the default when settings cannot be read, so providers still build', async () => {
    const broken = {
      ...env,
      DATABASE: {
        prepare: () => {
          throw new Error('D1 unavailable');
        },
        batch: () => Promise.reject(new Error('D1 unavailable')),
      },
    } as unknown as Env;
    expect(await resolveInfomaniakBootVolumeGb(broken)).toBe(80);
    const config = await buildProviderConfigForEnv('infomaniak', TOKEN, broken);
    expect(config).toMatchObject({ provider: 'infomaniak', bootVolumeSizeGb: 80 });
  });

  it('reads no setting for other providers', async () => {
    const config = await buildProviderConfigForEnv('hetzner', 'hetzner-token', env);
    expect(config).not.toHaveProperty('bootVolumeSizeGb');
  });

  it('re-sizes the static catalog fallback to the setting', async () => {
    await setBootVolumeGb(150);
    const offerings = getStaticProviderCatalogOfferings('infomaniak', {
      infomaniakBootVolumeGb: await resolveInfomaniakBootVolumeGb(env),
    });
    expect(offerings.length).toBeGreaterThan(0);
    expect(new Set(offerings.map((offering) => offering.diskGb))).toEqual(new Set([150]));
    expect(
      new Set(getStaticProviderCatalogOfferings('infomaniak').map((offering) => offering.diskGb))
    ).toEqual(new Set([80]));
  });
});
