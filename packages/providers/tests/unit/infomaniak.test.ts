import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyInfomaniakError,
  InfomaniakProvider,
  mapInfomaniakStatus,
} from '../../src/infomaniak';
import { ProviderError } from '../../src/types';

const AUTH_URL = 'https://identity.test/v3';
const COMPUTE = 'https://compute.test/v2.1/project';
const VOLUME = 'https://volume.test/v3/project';
const IMAGE = 'https://image.test';
const NETWORK = 'https://network.test';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function auth(
  catalog = [
    { type: 'compute', endpoints: [{ region: 'dc4-a', interface: 'public', url: COMPUTE }] },
    { type: 'volumev3', endpoints: [{ region: 'dc4-a', interface: 'public', url: VOLUME }] },
    { type: 'image', endpoints: [{ region: 'dc4-a', interface: 'public', url: IMAGE }] },
    { type: 'network', endpoints: [{ region: 'dc4-a', interface: 'public', url: NETWORK }] },
  ]
): Response {
  return json({ token: { project: { id: 'project' }, catalog } }, 201, {
    'x-subject-token': 'subject-token',
  });
}
function volume(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vol-1',
    name: 'data',
    size: 20,
    status: 'available',
    attachments: [],
    volume_type: 'CEPH_1_perf1',
    created_at: '2026-07-25T00:00:00Z',
    metadata: { env: 'e1' },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('InfomaniakProvider', () => {
  it('authenticates with explicit Keystone application credentials and validates the full catalog', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth());
    const provider = new InfomaniakProvider('credential-id', 'one-time-secret', {
      authUrl: AUTH_URL,
    });
    await expect(provider.validateToken()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_URL}/auth/tokens`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          auth: {
            identity: {
              methods: ['application_credential'],
              application_credential: { id: 'credential-id', secret: 'one-time-secret' },
            },
          },
        }),
      })
    );
  });

  it('rejects malformed Keystone catalogs at runtime', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth([]));
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(provider.validateToken()).rejects.toThrow('catalog is missing compute');
  });

  it('creates a Cinder volume with exact region/type/metadata payload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(json({ volume: volume({ status: 'creating' }) }, 202));
    const provider = new InfomaniakProvider('id', 'secret', {
      authUrl: AUTH_URL,
      volumeType: 'CEPH_1_perf1',
    });
    const result = await provider.createVolume({
      name: 'data',
      sizeGb: 20,
      location: 'dc4-a',
      labels: { env: 'e1' },
    });
    expect(result).toMatchObject({
      id: 'vol-1',
      sizeGb: 20,
      status: 'creating',
      location: 'dc4-a',
      labels: { env: 'e1' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${VOLUME}/volumes`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Auth-Token': 'subject-token' }),
        body: JSON.stringify({
          volume: { name: 'data', size: 20, volume_type: 'CEPH_1_perf1', metadata: { env: 'e1' } },
        }),
      })
    );
  });

  it('refuses attached-volume deletion without issuing DELETE', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({ volume: volume({ status: 'in-use', attachments: [{ server_id: 'server-1' }] }) })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(
      provider.deleteVolume({ volumeId: 'vol-1', location: 'dc4-a' })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires detach before grow-only resize', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({ volume: volume({ status: 'in-use', attachments: [{ server_id: 'server-1' }] }) })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(
      provider.resizeVolume({ volumeId: 'vol-1', location: 'dc4-a', sizeGb: 30 })
    ).rejects.toThrow('Detach');
  });

  it('resolves OpenStack catalogs and creates a Nova server with exact cloud-init payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/tokens')) return auth();
      if (url === `${IMAGE}/v2/images?name=Ubuntu%2024.04%20noble`)
        return json({ images: [{ id: 'image-1', name: 'Ubuntu 24.04 noble' }] });
      if (url === `${COMPUTE}/flavors/detail?name=a2-ram4-disk20-perf1`)
        return json({ flavors: [{ id: 'flavor-1', name: 'a2-ram4-disk20-perf1' }] });
      if (url === `${NETWORK}/v2.0/networks?name=ext-net1`)
        return json({ networks: [{ id: 'network-1', name: 'ext-net1' }] });
      if (url === `${COMPUTE}/servers` && init?.method === 'POST')
        return json({ server: { id: 'server-1' } }, 202);
      if (url === `${COMPUTE}/servers/server-1`)
        return json({
          server: {
            id: 'server-1',
            name: 'sam-node',
            status: 'ACTIVE',
            addresses: { 'ext-net1': [{ version: 4, addr: '203.0.113.10' }] },
            flavor: { id: 'flavor-1', original_name: 'a2-ram4-disk20-perf1' },
            created: '2026-07-25T00:00:00Z',
            metadata: { project: 'p1' },
          },
        });
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    const result = await provider.createVM({
      name: 'sam-node',
      size: 'small',
      location: 'dc4-a',
      image: 'Ubuntu 24.04 noble',
      userData: '#cloud-config\nusers: []',
      labels: {
        managed: 'simple-agent-manager',
        env: 'production',
        installation: '0123456789abcdef0123456789abcdef',
      },
    });
    expect(result).toMatchObject({ id: 'server-1', ip: '203.0.113.10', status: 'running' });
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === `${COMPUTE}/servers` && init?.method === 'POST'
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      server: {
        name: 'sam-node',
        imageRef: 'image-1',
        flavorRef: 'flavor-1',
        networks: [{ uuid: 'network-1' }],
        user_data: 'I2Nsb3VkLWNvbmZpZwp1c2VyczogW10=',
        metadata: {
          managed: 'simple-agent-manager',
          env: 'production',
          installation: '0123456789abcdef0123456789abcdef',
        },
      },
    });
  });

  it('lists only VMs carrying every exact ownership marker', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({
          servers: [
            {
              id: 'owned',
              name: 'node',
              status: 'ACTIVE',
              addresses: {},
              flavor: { id: 'flavor-1' },
              created: '2026-08-12T00:00:00Z',
              metadata: {
                managed: 'simple-agent-manager',
                env: 'production',
                installation: '0123456789abcdef0123456789abcdef',
              },
            },
            {
              id: 'foreign',
              name: 'node',
              status: 'ACTIVE',
              addresses: {},
              flavor: { id: 'flavor-1' },
              created: '2026-08-12T00:00:00Z',
              metadata: {
                managed: 'simple-agent-manager',
                env: 'production',
                installation: 'fedcba9876543210fedcba9876543210',
              },
            },
          ],
        })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(
      provider.listVMs({
        managed: 'simple-agent-manager',
        env: 'production',
        installation: '0123456789abcdef0123456789abcdef',
      })
    ).resolves.toEqual([expect.objectContaining({ id: 'owned' })]);
  });

  it('attaches through Nova with the exact payload and returns stable device discovery data', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(json({ volumeAttachment: { id: 'attachment-1' } }, 202))
      .mockResolvedValueOnce(
        json({ volume: volume({ status: 'in-use', attachments: [{ server_id: 'server-1' }] }) })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    const result = await provider.attachVolume({
      volumeId: 'vol-1',
      serverId: 'server-1',
      location: 'dc4-a',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${COMPUTE}/servers/server-1/os-volume_attachments`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ volumeAttachment: { volumeId: 'vol-1' } }),
      })
    );
    expect(result).toMatchObject({
      attachedServerId: 'server-1',
      status: 'attached',
      linuxDevice: '/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_vol-1',
    });
  });

  it('extends a detached Cinder volume with the exact grow-only action payload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(json({ volume: volume({ size: 20 }) }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(json({ volume: volume({ size: 40 }) }));
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    const result = await provider.resizeVolume({
      volumeId: 'vol-1',
      location: 'dc4-a',
      sizeGb: 40,
      currentSizeGb: 20,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `${VOLUME}/volumes/vol-1/action`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ 'os-extend': { new_size: 40 } }),
      })
    );
    expect(result.sizeGb).toBe(40);
  });

  it('normalizes status and errors', () => {
    expect(mapInfomaniakStatus('ACTIVE')).toBe('running');
    expect(mapInfomaniakStatus('SHUTOFF')).toBe('off');
    expect(classifyInfomaniakError(401, '')).toBe('auth_error');
    expect(classifyInfomaniakError(409, 'Quota exceeded')).toBe('quota_exceeded');
    expect(classifyInfomaniakError(503, 'No valid host')).toBe('transient_capacity');
    expect(new ProviderError('infomaniak', 400, 'bad').providerName).toBe('infomaniak');
  });
});
