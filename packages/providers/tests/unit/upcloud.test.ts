import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProvider, ProviderError } from '../../src';
import { classifyUpCloudError, mapUpCloudStatus, UpCloudProvider } from '../../src/upcloud';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
const server = (overrides = {}) => ({
  uuid: 'srv-1',
  title: 'node',
  hostname: 'node',
  state: 'started',
  zone: 'de-fra1',
  plan: '2xCPU-4GB',
  created: '2026-01-01T00:00:00Z',
  labels: { label: [{ key: 'managed-by', value: 'sam' }] },
  ip_addresses: { ip_address: [{ access: 'public', family: 'IPv4', address: '203.0.113.10' }] },
  storage_devices: {
    storage_device: [
      { address: 'virtio:0', storage: 'root-1', storage_title: 'root', boot_disk: '1' },
    ],
  },
  ...overrides,
});
const storage = (overrides = {}) => ({
  uuid: 'vol-1',
  title: 'data',
  size: 20,
  state: 'online',
  zone: 'de-fra1',
  tier: 'maxiops',
  type: 'normal',
  created: '2026-01-01T00:00:00Z',
  labels: [{ key: 'sam-environment', value: 'env-1' }],
  servers: { server: [] },
  ...overrides,
});
function mock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) =>
    handler(String(input), init)
  );
  globalThis.fetch = fn as typeof fetch;
  return fn;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('UpCloudProvider', () => {
  it('creates a server with Basic auth, cloud-init user_data, labels, and cloned root storage', async () => {
    const fetchMock = mock((url, _init) =>
      url.endsWith('/zone')
        ? json({ zones: { zone: [{ id: 'de-fra1' }] } })
        : url.endsWith('/plan')
          ? json({ plans: { plan: [{ name: '2xCPU-4GB' }] } })
          : url.endsWith('/storage/template')
            ? json({
                storages: {
                  storage: [
                    storage({
                      uuid: 'template-1',
                      title: 'Ubuntu Server 24.04 LTS',
                      type: 'template',
                      template_type: 'cloud-init',
                      zone: '',
                    }),
                  ],
                },
              })
            : json({ server: server() })
    );
    const p = new UpCloudProvider('api-user', 'sëcret', { ipPollTimeoutMs: 1 });
    const result = await p.createVM({
      name: 'Node One',
      size: 'small',
      location: 'de-fra1',
      userData: '#cloud-config\n',
      labels: {
        managed: 'simple-agent-manager',
        env: 'production',
        installation: '0123456789abcdef0123456789abcdef',
      },
    });
    expect(result.ip).toBe('203.0.113.10');
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/server') && (init as RequestInit).method === 'POST'
    );
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(JSON.parse(String(init.body))).toEqual({
      server: {
        zone: 'de-fra1',
        title: 'Node One',
        hostname: 'node-one',
        plan: '2xCPU-4GB',
        user_data: '#cloud-config\n',
        metadata: 'yes',
        labels: {
          label: [
            { key: 'managed', value: 'simple-agent-manager' },
            { key: 'env', value: 'production' },
            { key: 'installation', value: '0123456789abcdef0123456789abcdef' },
          ],
        },
        storage_devices: {
          storage_device: [
            {
              action: 'clone',
              storage: 'template-1',
              title: 'Node One root',
              size: 50,
              tier: 'maxiops',
              encrypted: 'yes',
            },
          ],
        },
        networking: {
          interfaces: {
            interface: [
              { type: 'public', ip_addresses: { ip_address: [{ family: 'IPv4' }] } },
              { type: 'utility', ip_addresses: { ip_address: [{ family: 'IPv4' }] } },
              { type: 'public', ip_addresses: { ip_address: [{ family: 'IPv6' }] } },
            ],
          },
        },
      },
    });
  });
  it('deletes the stopped server with storages=0, then only its root disk', async () => {
    const fetchMock = mock((url, init) => {
      if (url.endsWith('/zone')) return json({ zones: { zone: [{ id: 'de-fra1' }] } });
      if ((init.method ?? 'GET') === 'GET') return json({ server: server({ state: 'stopped' }) });
      return new Response(null, { status: 204 });
    });
    await new UpCloudProvider('u', 'p').deleteVM('srv-1');
    expect(
      fetchMock.mock.calls.map(([u, i]) => [(i as RequestInit).method, String(u)])
    ).toContainEqual(['DELETE', 'https://api.upcloud.com/1.3/server/srv-1?storages=0']);
    expect(
      fetchMock.mock.calls.map(([u, i]) => [(i as RequestInit).method, String(u)])
    ).toContainEqual(['DELETE', 'https://api.upcloud.com/1.3/storage/root-1']);
  });
  it('implements volume create, same-zone attach, virtio device discovery, detach, resize, and safe deletion', async () => {
    const fetchMock = mock((url, init) => {
      if (url.endsWith('/zone')) return json({ zones: { zone: [{ id: 'de-fra1' }] } });
      if (url.endsWith('/server/srv-1') && (init.method ?? 'GET') === 'GET')
        return json({ server: server() });
      if (url.endsWith('/storage/vol-1') && (init.method ?? 'GET') === 'GET')
        return json({ storage: storage() });
      if (url.endsWith('/storage/attach'))
        return json({
          server: server({
            storage_devices: {
              storage_device: [
                { address: 'virtio:1', storage: 'vol-1', storage_title: 'data', boot_disk: '0' },
              ],
            },
          }),
        });
      if (url.endsWith('/storage/detach')) return json({ server: server() });
      if (url.endsWith('/storage') && init.method === 'POST') return json({ storage: storage() });
      if (url.endsWith('/storage/vol-1') && init.method === 'PUT')
        return json({ storage: storage({ size: 40 }) });
      return new Response(null, { status: 204 });
    });
    const p = new UpCloudProvider('u', 'p');
    expect(
      (
        await p.createVolume({
          name: 'data',
          sizeGb: 20,
          location: 'de-fra1',
          labels: { 'sam-environment': 'env-1' },
        })
      ).id
    ).toBe('vol-1');
    expect(
      (await p.attachVolume({ volumeId: 'vol-1', serverId: 'srv-1', location: 'de-fra1' }))
        .linuxDevice
    ).toBe('/dev/vdb');
    await p.detachVolume({ volumeId: 'vol-1', serverId: 'srv-1', location: 'de-fra1' });
    expect(
      (
        await p.resizeVolume({
          volumeId: 'vol-1',
          location: 'de-fra1',
          sizeGb: 40,
          currentSizeGb: 20,
        })
      ).sizeGb
    ).toBe(40);
    await p.deleteVolume({ volumeId: 'vol-1', location: 'de-fra1' });
    expect(fetchMock).toHaveBeenCalled();
  });
  it('rejects shrink and attached-volume deletion before destructive API calls', async () => {
    const p = new UpCloudProvider('u', 'p');
    await expect(
      p.resizeVolume({ volumeId: 'v', location: 'de-fra1', sizeGb: 10, currentSizeGb: 20 })
    ).rejects.toBeInstanceOf(ProviderError);
    mock(() => json({ storage: storage({ servers: { server: ['srv-1'] } }) }));
    await expect(p.deleteVolume({ volumeId: 'vol-1', location: 'de-fra1' })).rejects.toThrow(
      'Detach'
    );
  });
  it('maps states and normalized error categories', () => {
    expect(mapUpCloudStatus('started')).toBe('running');
    expect(mapUpCloudStatus('stopped')).toBe('off');
    expect(classifyUpCloudError(401)).toBe('auth_error');
    expect(classifyUpCloudError(409, '', 'STORAGE_RESOURCES_UNAVAILABLE')).toBe(
      'transient_capacity'
    );
  });
  it('factory creates UpCloud provider', () => {
    expect(createProvider({ provider: 'upcloud', username: 'u', password: 'p' }).name).toBe(
      'upcloud'
    );
  });
});
