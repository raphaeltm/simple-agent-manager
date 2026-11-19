/**
 * The GCP node-pool catalog end to end through `buildProviderCatalogForCredential`: the real
 * encrypted seed, the real admin-setting resolution, the stored installation price table, and
 * Google's machine-type listing behind `fetch`. Before this, the catalog's GCP token provider
 * threw on every call, so GCP pools only ever saw the static 3-type, 8-zone table.
 */
import { Buffer } from 'node:buffer';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { encrypt } from '../../../src/services/encryption';
import { GCP_PRICE_TABLE_KV_KEY } from '../../../src/services/gcp-price-table';
import { buildProviderCatalogForCredential } from '../../../src/services/provider-catalogs-build';
import type { ProviderCatalogCredentialSeed } from '../../../src/services/provider-catalogs-common';
import { serializeGcpCredential } from '../../../src/services/provider-credential-codecs';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const tokenCalls: Array<{ userId: string; projectId: string }> = [];
vi.mock('../../../src/services/gcp-sts', () => ({
  getGcpAccessToken: async (userId: string, projectId: string) => {
    tokenCalls.push({ userId, projectId });
    return 'gcp-token';
  },
}));

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

let sqlite: Database.Database;
let env: Env;

async function seed(
  input: Partial<ProviderCatalogCredentialSeed> = {}
): Promise<ProviderCatalogCredentialSeed> {
  const { ciphertext, iv } = await encrypt(
    serializeGcpCredential({
      version: 1,
      provider: 'gcp',
      authType: 'workload-identity',
      gcpProjectId: 'my-vms',
      gcpProjectNumber: '123456',
      serviceAccountEmail: 'sam@my-vms.iam.gserviceaccount.com',
      wifPoolId: 'sam-pool',
      wifProviderId: 'sam-provider',
      defaultZone: 'us-central1-a',
    }),
    KEY
  );
  return {
    id: 'cred-gcp',
    provider: 'gcp',
    encryptedToken: ciphertext,
    iv,
    credentialSource: 'user',
    ownerProjectId: null,
    credentialId: 'cred-gcp',
    platformCredentialId: null,
    capacitySourceCredentialId: 'cred-gcp',
    credentialReference: 'credentials:cred-gcp',
    credentialVersion: 1,
    externalSourceRef: null,
    active: true,
    createdBy: 'user-1',
    stateFingerprint: 'fp',
    ...input,
  };
}

function machineType(name: string, zone: string, guestCpus: number, memoryMb: number) {
  return { kind: 'compute#machineType', name, guestCpus, memoryMb, zone };
}

function stubCompute(items: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/compute/v1/projects/my-vms/aggregated/machineTypes');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer gcp-token');
    expect(url.searchParams.get('filter')).toContain('e2-standard-2');
    return new Response(JSON.stringify({ items }));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('GCP live catalog build', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tokenCalls.length = 0;
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      ENCRYPTION_KEY: KEY,
    } as unknown as Env;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sqlite.close();
  });

  it('builds live, priced offerings in every zone Google reports, and a complete catalog', async () => {
    await env.KV.put(
      GCP_PRICE_TABLE_KV_KEY,
      JSON.stringify({
        fetchedAt: '2026-11-07T00:00:00.000Z',
        table: {
          currency: 'USD',
          regions: { 'us-central1': { e2: { coreHourly: 0.021811, ramGibHourly: 0.002923 } } },
        },
      })
    );
    stubCompute({
      'zones/us-central1-a': {
        machineTypes: [machineType('e2-standard-2', 'us-central1-a', 2, 8192)],
      },
      'zones/me-central2-c': {
        machineTypes: [machineType('e2-standard-2', 'me-central2-c', 2, 8192)],
      },
    });

    const catalog = await buildProviderCatalogForCredential({ env, seed: await seed() });

    expect(catalog.refreshStatus).toMatchObject({ succeeded: true, origin: 'api', complete: true });
    const offerings = catalog.offerings ?? [];
    expect(offerings.map((o) => o.location)).toEqual(['us-central1-a', 'me-central2-c']);
    expect(offerings[0]).toMatchObject({
      catalogSource: 'api',
      currency: 'USD',
      price: '$48.91/mo',
    });
    expect(offerings[1]).toMatchObject({
      catalogSource: 'api',
      currency: null,
      price: 'Price unavailable',
    });
    // A user-level credential is bound to no SAM project, so its GCP project id is the identity.
    expect(tokenCalls).toEqual([{ userId: 'user-1', projectId: 'my-vms' }]);
  });

  it('mints a project-scoped credential for its SAM project', async () => {
    stubCompute({});

    await buildProviderCatalogForCredential({
      env,
      seed: await seed({ credentialSource: 'project', ownerProjectId: 'project-9' }),
    });

    expect(tokenCalls).toEqual([{ userId: 'project:project-9:user-1', projectId: 'project-9' }]);
  });

  it('offers machine types unpriced when no price table has been stored yet', async () => {
    stubCompute({
      'zones/us-central1-a': {
        machineTypes: [machineType('e2-standard-2', 'us-central1-a', 2, 8192)],
      },
    });

    const catalog = await buildProviderCatalogForCredential({ env, seed: await seed() });

    expect(catalog.refreshStatus).toMatchObject({ succeeded: true, complete: true });
    expect(catalog.offerings?.[0]).toMatchObject({ catalogSource: 'api', priceMonthly: null });
  });

  it('keeps the catalog incomplete, on static rows, when a zone is unreachable', async () => {
    stubCompute({
      'zones/us-central1-a': {
        machineTypes: [machineType('e2-standard-2', 'us-central1-a', 2, 8192)],
      },
      'zones/europe-west3-a': { warning: { code: 'UNREACHABLE', message: 'unreachable' } },
    });

    const catalog = await buildProviderCatalogForCredential({ env, seed: await seed() });

    // Static fallback rows cannot overwrite live candidates while the catalog is incomplete, so
    // an unreachable zone never retires its last-known offerings.
    expect(catalog.refreshStatus).toMatchObject({
      succeeded: false,
      origin: 'static',
      complete: false,
    });
    expect(catalog.offerings?.every((o) => o.catalogSource === 'static')).toBe(true);
  });
});
