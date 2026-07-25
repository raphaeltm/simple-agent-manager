/**
 * Rule-35 vertical slice for DigitalOcean provisioning (H3).
 *
 * APPROACH — PREFERRED path (per the task): this drives the REAL control-plane
 * credential → provider → DigitalOcean-HTTP path through the actual
 * `createProviderForUser()`. Only the true system boundaries are mocked:
 *
 *   - the drizzle `db` (table-identity routing: empty for every composable-
 *     credentials / platform query, a single digitalocean `cloud-provider` row for the
 *     legacy lookup),
 *   - `decrypt` (returns the raw token verbatim),
 *   - `global.fetch` (an inline DigitalOcean API v2 mock — equivalent to the providers
 *     package `createDigitalOceanFetchMock` fixture, inlined to avoid a cross-package
 *     test-fixture import).
 *
 * Everything in between is real: the CC resolver + lazy-backfill run against the
 * empty CC tables, return no data, and `createProviderForUser` falls through to
 * the legacy single-table lookup, decrypts the digitalocean token, calls the real
 * providers-package `createProvider()`/`DigitalOceanProvider`, and issues real DigitalOcean
 * HTTP calls (intercepted at `fetch`). We then assert the outbound
 * `POST /v2/droplets` payload AND that an empty `main_ip` (0.0.0.0) is tolerated
 * as `ip: ''`.
 */
import { DigitalOceanProvider } from '@simple-agent-manager/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createEnvironmentVolume } from '../../../src/services/deployment-volumes';
import { decrypt } from '../../../src/services/encryption';
import { createProviderForUser } from '../../../src/services/provider-credentials';

// vitest hoists vi.mock above the imports, so the `decrypt` import above resolves
// to this stub (the same pattern as provider-credentials-edge-cases.test.ts).
vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(),
}));

const mockDecrypt = decrypt as ReturnType<typeof vi.fn>;

const RAW_DIGITALOCEAN_TOKEN = 'digitalocean-raw-token-abc123';
const USER_ID = 'user-digitalocean-1';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

/**
 * A drizzle-shaped mock whose result set depends only on WHICH table `.from()`
 * targets. Every composable-credentials + platform query resolves empty; only the
 * legacy `credentials` table's `.limit()`-terminated lookup yields the digitalocean row.
 * This forces CC resolution to miss and `createProviderForUser` to fall through to
 * the legacy path — without persisting the runBackfill no-op inserts.
 */
function makeDigitalOceanCredentialDbMock(digitaloceanRow: Record<string, unknown>) {
  function rowsFor(table: unknown, limited: boolean): unknown[] {
    // Legacy `credentials` lookup is `.limit(1)`-terminated; the runBackfill scan
    // reads the same table WITHOUT a limit and must stay empty so no inserts run.
    if (table === schema.credentials) return limited ? [digitaloceanRow] : [];
    return []; // cc_credentials / cc_configurations / cc_attachments / platform_credentials
  }

  const makeBuilder = () => {
    let table: unknown;
    const builder = {
      from: (t: unknown) => {
        table = t;
        return builder;
      },
      where: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      limit: () => Promise.resolve(rowsFor(table, true)),
      // Thenable: `await db.select().from(x).where(y)` (no `.limit`) resolves here.
      then: (resolve: (value: unknown[]) => unknown, reject: (reason?: unknown) => unknown) =>
        Promise.resolve(rowsFor(table, false)).then(resolve, reject),
    };
    return builder;
  };

  return {
    select: () => makeBuilder(),
    // runBackfill guards every insert on length > 0; with empty inputs it never
    // fires, but provide a no-op so an accidental insert can't throw.
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) }),
  } as unknown as Parameters<typeof createProviderForUser>[0];
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Inline DigitalOcean API v2 fetch mock (equivalent to createDigitalOceanFetchMock): resolves
 * an Ubuntu os_id, accepts the create, and returns main_ip 0.0.0.0 everywhere so
 * the IP poll times out and the empty-IP tolerance is exercised.
 */
function makeDigitalOceanFetchMock(calls: RecordedCall[]) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({
      url: u,
      method,
      body: init?.body as string | undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });

    const pendingDroplet = {
      id: 9001,
      name: 'slice-node',
      status: 'new',
      size_slug: 's-2vcpu-4gb',
      created_at: '2026-01-01T00:00:00Z',
      networks: { v4: [] },
      tags: ['managed-by:sam', 'node-id:slice-1'],
    };
    if (method === 'POST' && /\/v2\/volumes$/.test(u)) {
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            volume: {
              id: 'volume-slice-1',
              name: body.name,
              size_gigabytes: body.size_gigabytes,
              region: { slug: body.region },
              droplet_ids: [],
              created_at: '2026-01-01T00:00:00Z',
              tags: body.tags,
            },
          }),
          { status: 201 }
        )
      );
    }
    if (method === 'POST' && /\/v2\/droplets$/.test(u)) {
      return Promise.resolve(
        new Response(JSON.stringify({ droplet: pendingDroplet }), { status: 202 })
      );
    }
    if (method === 'GET' && /\/v2\/droplets\/[^/?]+$/.test(u)) {
      return Promise.resolve(
        new Response(JSON.stringify({ droplet: pendingDroplet }), { status: 200 })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'not_found', message: 'not found' }), { status: 404 })
    );
  });
}

describe('DigitalOcean provisioning vertical slice — createProviderForUser → DigitalOceanProvider → DigitalOcean HTTP', () => {
  const env = {
    // Small poll budget so createVM resolves quickly and returns an empty IP.
    DIGITALOCEAN_IP_POLL_TIMEOUT_MS: '20',
    DIGITALOCEAN_IP_POLL_INTERVAL_MS: '5',
    DIGITALOCEAN_API_TIMEOUT_MS: '1000',
  } as unknown as Parameters<typeof createProviderForUser>[3];

  beforeEach(() => {
    mockDecrypt.mockResolvedValue(RAW_DIGITALOCEAN_TOKEN);
  });

  it('resolves a real DigitalOceanProvider from a legacy digitalocean credential and provisions a VM', async () => {
    const db = makeDigitalOceanCredentialDbMock({
      id: 'cred-digitalocean-1',
      userId: USER_ID,
      projectId: null,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'digitalocean',
      encryptedToken: 'cipher',
      iv: 'iv',
      isActive: true,
    });

    const calls: RecordedCall[] = [];
    globalThis.fetch = makeDigitalOceanFetchMock(calls);

    // --- Real control-plane credential → provider resolution -------------------
    const resolved = await createProviderForUser(db, USER_ID, 'enc-key', env, 'digitalocean');

    expect(resolved).not.toBeNull();
    expect(resolved!.provider).toBeInstanceOf(DigitalOceanProvider);
    expect(resolved!.providerName).toBe('digitalocean');
    expect(resolved!.credentialSource).toBe('user');
    // The decrypted raw token flowed into the provider — prove decrypt was consulted.
    expect(mockDecrypt).toHaveBeenCalled();

    // --- Real provider.createVM → real DigitalOcean HTTP (intercepted at fetch) --------
    const vm = await resolved!.provider.createVM({
      name: 'slice node',
      size: 'small',
      location: 'fra1',
      userData: '#cloud-config\nhostname: slice\n',
      labels: { 'managed-by': 'sam', 'node-id': 'slice-1' },
    });

    // Empty public network list is tolerated → ip === '' (heartbeat backfill fallback).
    expect(vm.ip).toBe('');
    expect(vm.id).toBe('9001');
    expect(vm.status).toBe('initializing');

    // --- Outbound POST /v2/droplets payload is correct ------------------------
    const createCall = calls.find((c) => c.method === 'POST' && /\/v2\/droplets$/.test(c.url));
    expect(createCall).toBeDefined();
    expect(createCall!.url).toBe('https://api.digitalocean.com/v2/droplets');
    const body = JSON.parse(createCall!.body as string);
    expect(body.region).toBe('fra1');
    expect(body.size).toBe('s-2vcpu-4gb');
    expect(body.image).toBe('ubuntu-24-04-x64');
    expect(body.name).toBe('slice-node');
    expect(body.user_data).toBe('#cloud-config\nhostname: slice\n');
    expect(body.backups).toBe(false);
    expect(body.monitoring).toBe(false);
    expect(body.tags).toEqual(['managed-by:sam', 'node-id:slice-1']);
    // The raw decrypted token is used as the Bearer credential on the wire.
    expect(createCall!.headers?.Authorization).toBe('Bearer ' + RAW_DIGITALOCEAN_TOKEN);

    const volume = await resolved!.provider.createVolume({
      name: 'Deployment_DATA_01JABC',
      sizeGb: 25,
      location: 'fra1',
      labels: { 'deployment-id': 'deploy-1' },
    });
    expect(volume.id).toBe('volume-slice-1');
    expect(volume.name).toBe('Deployment_DATA_01JABC');
    expect(volume.linuxDevice).toBe('/dev/disk/by-id/scsi-0DO_Volume_deployment-data-01jabc');
    const volumeCall = calls.find((c) => c.method === 'POST' && /\/v2\/volumes$/.test(c.url));
    expect(volumeCall).toBeDefined();
    expect(JSON.parse(volumeCall!.body as string)).toEqual({
      name: 'deployment-data-01jabc',
      region: 'fra1',
      size_gigabytes: 25,
      tags: ['sam-name:Deployment_DATA_01JABC', 'deployment-id:deploy-1'],
    });
    expect(volumeCall!.headers?.Authorization).toBe('Bearer ' + RAW_DIGITALOCEAN_TOKEN);
  });
});

function makeDigitalOceanDeploymentVolumeDbMock(
  digitaloceanRow: Record<string, unknown>,
  insertedRows: Array<Record<string, unknown>>
) {
  function rowsFor(table: unknown, limited: boolean): unknown[] {
    if (table === schema.deploymentEnvironments) return [{ projectId: null }];
    if (table === schema.credentials) return limited ? [digitaloceanRow] : [];
    return [];
  }

  const makeBuilder = () => {
    let table: unknown;
    const builder = {
      from: (target: unknown) => {
        table = target;
        return builder;
      },
      where: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      limit: () => Promise.resolve(rowsFor(table, true)),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason?: unknown) => unknown) =>
        Promise.resolve(rowsFor(table, false)).then(resolve, reject),
    };
    return builder;
  };

  return {
    select: () => makeBuilder(),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === schema.deploymentVolumes) insertedRows.push({ ...row });
        return {
          onConflictDoNothing: () => Promise.resolve(undefined),
          then: (resolve: (value?: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      },
    }),
  } as unknown as Parameters<typeof createEnvironmentVolume>[0];
}

describe('DigitalOcean deployment volume control-plane vertical slice', () => {
  const env = {
    ENCRYPTION_KEY: 'test-encryption-key',
    DIGITALOCEAN_API_TIMEOUT_MS: '1000',
  } as unknown as Parameters<typeof createEnvironmentVolume>[1];

  beforeEach(() => {
    mockDecrypt.mockResolvedValue(RAW_DIGITALOCEAN_TOKEN);
  });

  it('persists the real DigitalOcean volume result through the deployment volume service', async () => {
    const insertedRows: Array<Record<string, unknown>> = [];
    const db = makeDigitalOceanDeploymentVolumeDbMock(
      {
        id: 'cred-digitalocean-volume',
        userId: USER_ID,
        projectId: null,
        credentialType: 'cloud-provider',
        credentialKind: 'api-key',
        agentType: null,
        provider: 'digitalocean',
        encryptedToken: 'cipher',
        iv: 'iv',
        isActive: true,
      },
      insertedRows
    );
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeDigitalOceanFetchMock(calls);

    const row = await createEnvironmentVolume(db, env, USER_ID, {
      environmentId: 'env-do-1',
      name: 'app-data',
      sizeGb: 25,
      location: 'fra1',
      targetProvider: 'digitalocean',
    });

    expect(row).toMatchObject({
      environmentId: 'env-do-1',
      name: 'app-data',
      providerVolumeId: 'volume-slice-1',
      providerName: 'digitalocean',
      sizeGb: 25,
      location: 'fra1',
      status: 'available',
      linuxDevice: '/dev/disk/by-id/scsi-0DO_Volume_sam-env-do-1-app-data',
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject(row);

    const createCall = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v2/volumes')
    );
    expect(JSON.parse(createCall!.body as string)).toEqual({
      name: 'sam-env-do-1-app-data',
      region: 'fra1',
      size_gigabytes: 25,
      tags: [
        'sam-name:sam-env-do-1-app-data',
        'sam-environment:env-do-1',
        'sam-volume-name:app-data',
      ],
    });
  });

  it('propagates a DigitalOcean create failure without persisting deployment state', async () => {
    const insertedRows: Array<Record<string, unknown>> = [];
    const db = makeDigitalOceanDeploymentVolumeDbMock(
      {
        id: 'cred-digitalocean-volume',
        userId: USER_ID,
        projectId: null,
        credentialType: 'cloud-provider',
        credentialKind: 'api-key',
        agentType: null,
        provider: 'digitalocean',
        encryptedToken: 'cipher',
        iv: 'iv',
        isActive: true,
      },
      insertedRows
    );
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'unprocessable_entity', message: 'volume quota exceeded' }),
        {
          status: 422,
        }
      )
    );

    await expect(
      createEnvironmentVolume(db, env, USER_ID, {
        environmentId: 'env-do-1',
        name: 'data',
        sizeGb: 25,
        location: 'fra1',
        targetProvider: 'digitalocean',
      })
    ).rejects.toThrow('volume quota exceeded');
    expect(insertedRows).toHaveLength(0);
  });
});
