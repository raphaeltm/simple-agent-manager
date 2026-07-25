/**
 * Rule-35 UpCloud vertical slice. Only persistence, decryption, and fetch are mocked;
 * credential resolution, provider construction, VM creation, and volume creation are real.
 */
import { UpCloudProvider } from '@simple-agent-manager/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { decrypt } from '../../../src/services/encryption';
import { createProviderForUser } from '../../../src/services/provider-credentials';

vi.mock('../../../src/services/encryption', () => ({ decrypt: vi.fn() }));
const mockDecrypt = decrypt as ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

function makeCredentialDbMock(row: Record<string, unknown>) {
  function rowsFor(table: unknown, limited: boolean): unknown[] {
    return table === schema.credentials && limited ? [row] : [];
  }
  const makeBuilder = () => {
    let table: unknown;
    const builder = {
      from: (value: unknown) => {
        table = value;
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
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
  } as unknown as Parameters<typeof createProviderForUser>[0];
}

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  authorization?: string;
}
const server = {
  uuid: 'srv-upcloud-slice',
  title: 'slice node',
  hostname: 'slice-node',
  state: 'started',
  zone: 'de-fra1',
  plan: '2xCPU-4GB',
  created: '2026-07-25T00:00:00Z',
  labels: { label: [{ key: 'managed-by', value: 'sam' }] },
  ip_addresses: { ip_address: [{ access: 'public', address: '203.0.113.10', family: 'IPv4' }] },
  storage_devices: { storage_device: [{ address: 'virtio:0', storage: 'root-1', boot_disk: '1' }] },
};
const volume = {
  uuid: 'storage-slice',
  title: 'deployment data',
  size: 20,
  state: 'online',
  zone: 'de-fra1',
  tier: 'maxiops',
  type: 'normal',
  created: '2026-07-25T00:00:00Z',
  labels: [{ key: 'managed-by', value: 'sam' }],
  servers: { server: [] },
};

function makeFetchMock(calls: RecordedCall[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method,
      body: init?.body as string | undefined,
      authorization: headers?.Authorization,
    });
    if (method === 'GET' && String(url).endsWith('/zone')) {
      return new Response(
        JSON.stringify({ zones: { zone: [{ id: 'de-fra1', description: 'Frankfurt #1' }] } }),
        { status: 200 }
      );
    }
    if (method === 'GET' && String(url).endsWith('/plan')) {
      return new Response(JSON.stringify({ plans: { plan: [{ name: '2xCPU-4GB' }] } }), {
        status: 200,
      });
    }
    if (method === 'GET' && String(url).endsWith('/storage/template')) {
      return new Response(
        JSON.stringify({
          storages: {
            storage: [
              {
                ...volume,
                uuid: 'template-1',
                title: 'Ubuntu Server 24.04 LTS',
                type: 'template',
                template_type: 'cloud-init',
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (method === 'POST' && String(url).endsWith('/server')) {
      return new Response(JSON.stringify({ server }), { status: 201 });
    }
    if (method === 'POST' && String(url).endsWith('/storage')) {
      return new Response(JSON.stringify({ storage: volume }), { status: 201 });
    }
    return new Response(
      JSON.stringify({ error: { error_code: 'NOT_FOUND', error_message: 'not found' } }),
      { status: 404 }
    );
  });
}

describe('UpCloud provisioning vertical slice', () => {
  beforeEach(() =>
    mockDecrypt.mockResolvedValue(
      JSON.stringify({ username: 'api-user', password: 'api-password' })
    )
  );

  it('resolves structured credentials and provisions a VM plus independent volume', async () => {
    const db = makeCredentialDbMock({
      id: 'cred-upcloud',
      userId: 'user-upcloud',
      projectId: null,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'upcloud',
      encryptedToken: 'cipher',
      iv: 'iv',
      isActive: true,
    });
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeFetchMock(calls);
    const resolved = await createProviderForUser(
      db,
      'user-upcloud',
      'encryption-key',
      {
        UPCLOUD_API_TIMEOUT_MS: '1000',
      } as unknown as Parameters<typeof createProviderForUser>[3],
      'upcloud'
    );

    expect(resolved?.provider).toBeInstanceOf(UpCloudProvider);
    expect(resolved?.credentialSource).toBe('user');
    const vm = await resolved!.provider.createVM({
      name: 'slice node',
      size: 'small',
      location: 'de-fra1',
      userData: '#cloud-config\nhostname: slice-node\n',
      labels: { 'managed-by': 'sam' },
    });
    const createdVolume = await resolved!.provider.createVolume({
      name: 'deployment data',
      sizeGb: 20,
      location: 'de-fra1',
      labels: { 'managed-by': 'sam' },
    });

    expect(vm).toMatchObject({ id: 'srv-upcloud-slice', ip: '203.0.113.10', status: 'running' });
    expect(createdVolume).toMatchObject({ id: 'storage-slice', sizeGb: 20, status: 'available' });
    const createServer = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/server')
    )!;
    expect(JSON.parse(createServer.body!).server).toMatchObject({
      zone: 'de-fra1',
      plan: '2xCPU-4GB',
      user_data: '#cloud-config\nhostname: slice-node\n',
      metadata: 'yes',
      storage_devices: {
        storage_device: [
          { action: 'clone', storage: 'template-1', tier: 'maxiops', encrypted: 'yes' },
        ],
      },
    });
    const createStorage = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/storage')
    )!;
    expect(JSON.parse(createStorage.body!)).toEqual({
      storage: {
        zone: 'de-fra1',
        title: 'deployment data',
        size: 20,
        tier: 'maxiops',
        encrypted: 'yes',
        labels: [{ key: 'managed-by', value: 'sam' }],
      },
    });
    expect(createServer.authorization).toBe(`Basic ${btoa('api-user:api-password')}`);
    expect(createStorage.authorization).toBe(createServer.authorization);
  });
});
