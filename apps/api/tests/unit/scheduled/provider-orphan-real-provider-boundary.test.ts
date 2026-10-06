/**
 * Vertical OR-01 contract: raw provider payload -> real adapter decoding ->
 * reconciliation/D1 -> real provider deletion request.
 *
 * Only provider HTTP and the control-plane stores are mocked. The seven adapters,
 * their label codecs, getVM revalidation, and deleteVM implementations are real.
 */
import {
  DigitalOceanProvider,
  GcpProvider,
  HetznerProvider,
  InfomaniakProvider,
  type Provider,
  ScalewayProvider,
  UpCloudProvider,
  VultrProvider,
} from '@simple-agent-manager/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDigitalOceanFetchMock,
  createMockDigitalOceanDroplet,
} from '../../../../../packages/providers/tests/fixtures/digitalocean-mocks';
import {
  createHetznerFetchMock,
  createMockServer,
} from '../../../../../packages/providers/tests/fixtures/hetzner-mocks';
import { createMockScalewayServer } from '../../../../../packages/providers/tests/fixtures/scaleway-mocks';
import {
  createMockVultrInstance,
  createVultrFetchMock,
} from '../../../../../packages/providers/tests/fixtures/vultr-mocks';
import type { Env } from '../../../src/env';
import { runProviderOrphanReconciliation } from '../../../src/scheduled/provider-orphan-reconciliation';

const providerState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  return { ...actual, createProvider: vi.fn(() => providerState.current as Provider) };
});
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: vi.fn().mockResolvedValue({
    decryptedToken: 'provider-credential',
    provider: 'hetzner',
  }),
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  buildProviderConfig: vi.fn().mockReturnValue({ provider: 'hetzner', apiToken: 'unused' }),
}));
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('encryption-key'),
}));
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));

const INSTALLATION = '0123456789abcdef0123456789abcdef';
const FOREIGN_INSTALLATION = 'fedcba9876543210fedcba9876543210';
const NODE = '01kx84mcg1yn1tqvwr60b3g70a';
const CREATED = '2026-01-01T00:00:00Z';
const labels = (installation = INSTALLATION) => ({
  managed: 'simple-agent-manager',
  env: 'production',
  installation,
  node: NODE,
  role: 'workspace',
});
const delimited = (separator: string, installation = INSTALLATION) =>
  Object.entries(labels(installation)).map(([key, value]) => `${key}${separator}${value}`);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function env(): Env {
  return {
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: INSTALLATION,
    KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn((...requestedIds: string[]) => ({
          all: vi.fn().mockResolvedValue({
            success: true,
            results: requestedIds.map((requestedId) => ({
              requested_id: requestedId,
              id: null,
              status: null,
              provider_instance_id: null,
            })),
          }),
        })),
      })),
    },
    OBSERVABILITY_DATABASE: {},
  } as unknown as Env;
}

function methods(fetchMock: ReturnType<typeof vi.fn>): Array<[string, string]> {
  return fetchMock.mock.calls.map(([input, init]) => [
    ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    String(input),
  ]);
}

const originalFetch = globalThis.fetch;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
  providerState.current = null;
});

describe('provider orphan reconciliation — real provider delete boundaries', () => {
  it('Hetzner decodes raw labels and deletes only the exact-install orphan', async () => {
    const owned = createMockServer({ id: 101, name: 'owned', created: CREATED, labels: labels() });
    const fetchMock = createHetznerFetchMock({
      listServers: [
        owned,
        createMockServer({ id: 102, created: CREATED, labels: labels(FOREIGN_INSTALLATION) }),
        createMockServer({
          id: 103,
          created: CREATED,
          labels: { ...labels(), installation: undefined },
        }),
      ],
      getServer: owned,
    });
    globalThis.fetch = fetchMock;
    providerState.current = new HetznerProvider('token', 'fsn1');

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed, JSON.stringify({ result, calls: methods(fetchMock) })).toBe(1);
    expect(methods(fetchMock).filter(([method]) => method === 'DELETE')).toEqual([
      ['DELETE', 'https://api.hetzner.cloud/v1/servers/101'],
    ]);
  });

  it('Scaleway decodes raw tags and reaches only its owned terminate action', async () => {
    const owned = createMockScalewayServer({
      id: 'scw-owned',
      creation_date: CREATED,
      tags: delimited('='),
    });
    const raw = [
      owned,
      createMockScalewayServer({
        id: 'scw-foreign',
        creation_date: CREATED,
        tags: delimited('=', FOREIGN_INSTALLATION),
      }),
      createMockScalewayServer({
        id: 'scw-legacy',
        creation_date: CREATED,
        tags: delimited('=').filter((tag) => !tag.startsWith('installation=')),
      }),
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/zones/fr-par-1/servers?'))
        return json({ servers: raw });
      if (method === 'GET' && url.endsWith('/servers/scw-owned')) return json({ server: owned });
      if (method === 'POST' && url.endsWith('/servers/scw-owned/action'))
        return json({ task: { id: 't1', status: 'pending' } }, 202);
      return json({ message: 'Not found' }, 404);
    });
    globalThis.fetch = fetchMock;
    providerState.current = new ScalewayProvider('secret', 'project', 'fr-par-1');

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed).toBe(1);
    expect(methods(fetchMock).filter(([method]) => method === 'POST')).toEqual([
      ['POST', expect.stringContaining('/zones/fr-par-1/servers/scw-owned/action')],
    ]);
  });

  it('GCP decodes raw metadata and reaches only the owned instance DELETE', async () => {
    const instance = (id: string, installation?: string) => ({
      id,
      name: `vm-${id}`,
      status: 'RUNNING',
      machineType: 'zones/us-central1-a/machineTypes/e2-medium',
      creationTimestamp: CREATED,
      networkInterfaces: [{ accessConfigs: [{ natIP: '192.0.2.10' }] }],
      labels: installation
        ? { ...labels(installation), 'sam-managed': 'true' }
        : { ...labels(), installation: undefined, 'sam-managed': 'true' },
    });
    const ownedId = '9876543210123456789';
    const owned = { ...instance(ownedId, INSTALLATION), name: 'vm-owned' };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith(`/instances/${ownedId}`)) {
        return json({ error: { message: 'Not found by name' } }, 404);
      }
      if (url.includes('/aggregated/instances'))
        return json({ items: { 'zones/us-central1-a': { instances: [owned] } } });
      if (method === 'GET' && url.includes('/zones/us-central1-a/instances?')) {
        return json({
          items: url.includes('us-central1-a')
            ? [
                owned,
                instance('1234567890123456789', FOREIGN_INSTALLATION),
                instance('2234567890123456789'),
              ]
            : [],
        });
      }
      if (method === 'DELETE' && url.endsWith('/instances/vm-owned'))
        return json({ name: 'delete-op', status: 'PENDING' });
      if (url.endsWith('/operations/delete-op')) return json({ name: 'delete-op', status: 'DONE' });
      return json({ items: [] });
    });
    globalThis.fetch = fetchMock;
    providerState.current = new GcpProvider('project', async () => 'token', 'us-central1-a');

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed, JSON.stringify({ result, calls: methods(fetchMock) })).toBe(1);
    expect(methods(fetchMock).filter(([method]) => method === 'DELETE')).toEqual([
      ['DELETE', expect.stringContaining('/zones/us-central1-a/instances/vm-owned')],
    ]);
    expect(
      methods(fetchMock).some(
        ([method, url]) => method === 'GET' && url.endsWith(`/instances/${ownedId}`)
      )
    ).toBe(true);
    expect(
      methods(fetchMock).some(
        ([method, url]) => method === 'GET' && url.includes('/aggregated/instances')
      )
    ).toBe(true);
  });

  it('Vultr decodes raw tags and issues DELETE only for the exact-install orphan', async () => {
    const owned = createMockVultrInstance({
      id: 'vultr-owned',
      date_created: CREATED,
      tags: delimited('='),
    });
    const fetchMock = createVultrFetchMock({
      listInstances: [
        owned,
        createMockVultrInstance({
          id: 'vultr-foreign',
          date_created: CREATED,
          tags: delimited('=', FOREIGN_INSTALLATION),
        }),
        createMockVultrInstance({
          id: 'vultr-legacy',
          date_created: CREATED,
          tags: delimited('=').filter((tag) => !tag.startsWith('installation=')),
        }),
        createMockVultrInstance({
          id: 'vultr-ambiguous',
          date_created: CREATED,
          tags: [...delimited('='), `installation=${FOREIGN_INSTALLATION}`],
        }),
      ],
      getInstance: owned,
    });
    globalThis.fetch = fetchMock;
    providerState.current = new VultrProvider('token');

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed).toBe(1);
    expect(result.skippedAmbiguousOwnership).toBe(0);
    expect(methods(fetchMock).filter(([method]) => method === 'DELETE')).toEqual([
      ['DELETE', 'https://api.vultr.com/v2/instances/vultr-owned'],
    ]);
  });

  it('DigitalOcean decodes raw tags and issues DELETE only for the exact-install orphan', async () => {
    const owned = createMockDigitalOceanDroplet({
      id: 201,
      created_at: CREATED,
      tags: delimited(':'),
    });
    const fetchMock = createDigitalOceanFetchMock({
      dropletPages: [
        {
          items: [
            owned,
            createMockDigitalOceanDroplet({
              id: 202,
              created_at: CREATED,
              tags: delimited(':', FOREIGN_INSTALLATION),
            }),
            createMockDigitalOceanDroplet({
              id: 203,
              created_at: CREATED,
              tags: delimited(':').filter((tag) => !tag.startsWith('installation:')),
            }),
            createMockDigitalOceanDroplet({
              id: 204,
              created_at: CREATED,
              tags: [...delimited(':'), `installation:${FOREIGN_INSTALLATION}`],
            }),
          ],
          hasNext: false,
        },
      ],
      getDroplet: owned,
    });
    globalThis.fetch = fetchMock;
    providerState.current = new DigitalOceanProvider('token');

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed).toBe(1);
    expect(result.skippedAmbiguousOwnership).toBe(0);
    expect(methods(fetchMock).filter(([method]) => method === 'DELETE')).toEqual([
      ['DELETE', 'https://api.digitalocean.com/v2/droplets/201'],
    ]);
  });

  it('UpCloud decodes raw labels and deletes only the exact-install orphan', async () => {
    const server = (uuid: string, installation?: string) => ({
      uuid,
      title: uuid,
      hostname: uuid,
      state: 'stopped',
      zone: 'de-fra1',
      plan: '2xCPU-4GB',
      created: CREATED,
      labels: {
        label: Object.entries(
          installation ? labels(installation) : { ...labels(), installation: undefined }
        )
          .filter((entry) => entry[1] !== undefined)
          .map(([key, value]) => ({ key, value })),
      },
      ip_addresses: { ip_address: [{ access: 'public', family: 'IPv4', address: '192.0.2.10' }] },
      storage_devices: { storage_device: [] },
    });
    const owned = server('upcloud-owned', INSTALLATION);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/server'))
        return json({
          servers: {
            server: [
              owned,
              server('upcloud-foreign', FOREIGN_INSTALLATION),
              server('upcloud-legacy'),
              {
                ...server('upcloud-ambiguous', INSTALLATION),
                labels: {
                  label: [
                    ...Object.entries(labels()).map(([key, value]) => ({ key, value })),
                    { key: 'installation', value: FOREIGN_INSTALLATION },
                  ],
                },
              },
            ],
          },
        });
      if (method === 'GET' && url.endsWith('/server/upcloud-owned')) return json({ server: owned });
      if (method === 'DELETE' && url.includes('/server/upcloud-owned?storages=0'))
        return new Response(null, { status: 204 });
      return json({ error: { error_code: 'SERVER_NOT_FOUND', error_message: 'not found' } }, 404);
    });
    globalThis.fetch = fetchMock;
    providerState.current = new UpCloudProvider('user', 'password');

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed).toBe(1);
    expect(result.skippedAmbiguousOwnership).toBe(0);
    expect(methods(fetchMock).filter(([method]) => method === 'DELETE')).toEqual([
      ['DELETE', 'https://api.upcloud.com/1.3/server/upcloud-owned?storages=0'],
    ]);
  });

  it('Infomaniak decodes raw metadata and issues DELETE only for the exact-install orphan', async () => {
    const compute = 'https://compute.test/v2.1/project';
    const raw = (id: string, installation?: string) => ({
      id,
      name: id,
      status: 'ACTIVE',
      flavor: { id: 'a2-ram4-disk20-perf1', original_name: 'a2-ram4-disk20-perf1' },
      created: CREATED,
      addresses: { public: [{ version: 4, addr: '192.0.2.10' }] },
      metadata: installation ? labels(installation) : { ...labels(), installation: undefined },
    });
    const owned = raw('infomaniak-owned', INSTALLATION);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/auth/tokens')) {
        return json(
          {
            token: {
              project: { id: 'project' },
              catalog: [
                {
                  type: 'compute',
                  endpoints: [{ region: 'dc4-a', interface: 'public', url: compute }],
                },
                {
                  type: 'volumev3',
                  endpoints: [{ region: 'dc4-a', interface: 'public', url: 'https://volume.test' }],
                },
                {
                  type: 'image',
                  endpoints: [{ region: 'dc4-a', interface: 'public', url: 'https://image.test' }],
                },
                {
                  type: 'network',
                  endpoints: [
                    { region: 'dc4-a', interface: 'public', url: 'https://network.test' },
                  ],
                },
              ],
            },
          },
          201,
          { 'x-subject-token': 'subject-token' }
        );
      }
      if (method === 'GET' && url.endsWith('/servers/detail'))
        return json({
          servers: [
            owned,
            raw('infomaniak-foreign', FOREIGN_INSTALLATION),
            raw('infomaniak-legacy'),
          ],
        });
      if (method === 'GET' && url.endsWith('/servers/infomaniak-owned'))
        return json({ server: owned });
      if (method === 'DELETE' && url.endsWith('/servers/infomaniak-owned'))
        return new Response(null, { status: 204 });
      return json({ itemNotFound: { message: 'not found' } }, 404);
    });
    globalThis.fetch = fetchMock;
    providerState.current = new InfomaniakProvider('id', 'secret', {
      authUrl: 'https://identity.test/v3',
    });

    const result = await runProviderOrphanReconciliation(env());

    expect(result.destroyed).toBe(1);
    expect(methods(fetchMock).filter(([method]) => method === 'DELETE')).toEqual([
      ['DELETE', `${compute}/servers/infomaniak-owned`],
    ]);
  });
});
