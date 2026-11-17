/**
 * #2842: Infomaniak VMs boot from a SAM-sized Cinder volume instead of the flavor's 20 GB local
 * root disk. Every case goes through the real `InfomaniakProvider` against a fake OpenStack API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VMConfig, VMInstance } from '../../src';
import { createProvider, INFOMANIAK_ROOT_DISK_METADATA_KEY, InfomaniakProvider } from '../../src';

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

function authResponse(): Response {
  const catalog = [
    { type: 'compute', url: COMPUTE },
    { type: 'volumev3', url: VOLUME },
    { type: 'image', url: IMAGE },
    { type: 'network', url: NETWORK },
  ].map(({ type, url }) => ({
    type,
    endpoints: [{ region: 'dc4-a', interface: 'public', url }],
  }));
  return json({ token: { project: { id: 'project' }, catalog } }, 201, {
    'x-subject-token': 'subject-token',
  });
}

function server(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'server-1',
    name: 'sam-node',
    status: 'ACTIVE',
    addresses: { 'ext-net1': [{ version: 4, addr: '203.0.113.10' }] },
    flavor: {
      id: 'flavor-1',
      original_name: 'a4-ram8-disk20-perf1',
      vcpus: 4,
      ram: 8192,
      disk: 20,
    },
    created: '2026-11-17T00:00:00Z',
    ...overrides,
  };
}

interface FakeNova {
  createBodies: Array<{ server: Record<string, unknown> }>;
  requests: Array<{ method: string; url: string; headers: Headers }>;
}

/**
 * A fake Nova that answers server reads the way Nova does: the created server reports whatever
 * metadata it was created with, and `image: ""` when it booted from a volume.
 */
function fakeNova(): FakeNova {
  const state: FakeNova = { createBodies: [], requests: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    state.requests.push({ method, url, headers: new Headers(init?.headers) });
    if (url.endsWith('/auth/tokens')) return authResponse();
    if (url.startsWith(`${IMAGE}/v2/images?name=`))
      return json({ images: [{ id: 'image-1', name: 'Ubuntu 24.04 noble' }] });
    if (url.startsWith(`${COMPUTE}/flavors/detail?name=`)) {
      const name = decodeURIComponent(url.split('name=')[1] ?? '');
      return json({ flavors: [{ id: 'flavor-1', name }] });
    }
    if (url === `${NETWORK}/v2.0/networks?name=ext-net1`)
      return json({ networks: [{ id: 'network-1', name: 'ext-net1' }] });
    if (url === `${COMPUTE}/servers` && method === 'POST') {
      state.createBodies.push(JSON.parse(String(init?.body)));
      return json({ server: { id: 'server-1' } }, 202);
    }
    if (url === `${COMPUTE}/servers/server-1` && method === 'GET') {
      const created = state.createBodies.at(-1)?.server;
      return json({
        server: server({
          image: created?.block_device_mapping_v2 ? '' : { id: 'image-1' },
          metadata: created?.metadata ?? {},
        }),
      });
    }
    if (url === `${COMPUTE}/servers/server-1` && method === 'DELETE')
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  return state;
}

function lastMapping(nova: FakeNova): Record<string, unknown> {
  const mapping = nova.createBodies.at(-1)?.server.block_device_mapping_v2;
  expect(Array.isArray(mapping) && mapping.length === 1).toBe(true);
  return (mapping as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
}

const baseConfig: VMConfig = {
  name: 'sam-node',
  location: 'dc4-a',
  userData: '#cloud-config',
  labels: { managed: 'simple-agent-manager', node: 'node-1' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Infomaniak boot volume (#2842)', () => {
  it('boots a legacy-size VM from an 80 GB volume by default and reads 80 GB back', async () => {
    const nova = fakeNova();
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });

    const vm = await provider.createVM({ ...baseConfig, size: 'medium' });

    expect(lastMapping(nova)).toEqual({
      boot_index: 0,
      uuid: 'image-1',
      source_type: 'image',
      destination_type: 'volume',
      volume_size: 80,
      delete_on_termination: true,
    });
    const created = nova.createBodies[0]?.server ?? {};
    expect(created).not.toHaveProperty('imageRef');
    expect(JSON.stringify(created)).not.toContain('volume_type');
    expect(created.metadata).toEqual({
      managed: 'simple-agent-manager',
      node: 'node-1',
      [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80',
    });
    expect(vm.observedHardware.resources).toEqual({
      value: { vcpuCount: 4, memoryMb: 8192, diskGb: 80 },
      source: 'observed',
    });
    for (const request of nova.requests) {
      expect(request.headers.has('OpenStack-API-Version')).toBe(false);
      expect(request.headers.has('X-OpenStack-Nova-API-Version')).toBe(false);
    }
  });

  it('uses the configured size for the catalog, legacy requests and the observed disk alike', async () => {
    const nova = fakeNova();
    const provider = createProvider({
      provider: 'infomaniak',
      applicationCredentialId: 'id',
      applicationCredentialSecret: 'secret',
      authUrl: AUTH_URL,
      bootVolumeSizeGb: 120,
    });

    const offerings = await provider.listInstanceOfferings();
    expect(offerings.length).toBeGreaterThan(0);
    for (const offering of offerings) {
      expect(offering).toMatchObject({ diskGb: 120, storageGb: 120 });
      expect(offering.displayName).toMatch(/· 120 GB disk$/);
    }
    expect(provider.sizes.medium.storageGb).toBe(120);

    const vm = await provider.createVM({ ...baseConfig, size: 'small' });
    expect(lastMapping(nova).volume_size).toBe(120);
    expect((vm.observedHardware.resources.value as { diskGb: number }).diskGb).toBe(120);
  });

  it.each([
    ['a larger candidate keeps its planned disk', 120, 120],
    ['a stale pre-#2842 20 GB candidate gets the configured size', 20, 80],
    ['a smaller candidate gets the configured size', 64, 80],
  ])('pool plan: %s', async (_label, plannedDiskGb, expectedGb) => {
    const nova = fakeNova();
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });

    const vm = await provider.createVM({
      ...baseConfig,
      native: {
        instanceType: 'a4-ram8-disk20-perf1',
        resources: { vcpuCount: 4, memoryMb: 8192, diskGb: plannedDiskGb },
      },
    });

    expect(lastMapping(nova).volume_size).toBe(expectedGb);
    expect((vm.observedHardware.resources.value as { diskGb: number }).diskGb).toBe(expectedGb);
  });

  it('honours an explicit bootDiskSizeGb above the flavor root disk', async () => {
    const nova = fakeNova();
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });

    await provider.createVM({
      ...baseConfig,
      native: {
        instanceType: 'a4-ram8-disk20-perf1',
        bootDiskSizeGb: 200,
        resources: { vcpuCount: 4, memoryMb: 8192, diskGb: 20 },
      },
    });

    expect(lastMapping(nova).volume_size).toBe(200);
    expect(nova.createBodies[0]?.server.metadata).toMatchObject({
      [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '200',
    });
  });

  it('records the real size even when caller labels carry a stale root-disk key', async () => {
    const nova = fakeNova();
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });

    await provider.createVM({
      ...baseConfig,
      size: 'small',
      labels: { ...baseConfig.labels, [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '9999' },
    });

    expect(nova.createBodies[0]?.server.metadata).toMatchObject({
      [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80',
    });
  });

  it.each([
    ['below the minimum', 19],
    ['above the maximum', 4_097],
    ['fractional', 40.5],
    ['zero', 0],
  ])('rejects an explicit boot volume %s before any provider request', async (_label, size) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });

    await expect(
      provider.createVM({
        ...baseConfig,
        native: {
          instanceType: 'a4-ram8-disk20-perf1',
          bootDiskSizeGb: size,
          resources: { vcpuCount: 4, memoryMb: 8192, diskGb: 80 },
        },
      })
    ).rejects.toMatchObject({ category: 'invalid_config', providerName: 'infomaniak' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([10, 1.5, 100_000, Number.NaN])(
    'falls back to the default for a configured size of %s instead of failing provider builds',
    async (size) => {
      const nova = fakeNova();
      const provider = new InfomaniakProvider('id', 'secret', {
        authUrl: AUTH_URL,
        bootVolumeSizeGb: size,
      });
      // Teardown must still work with a bad configured value.
      await provider.deleteVM('server-1');
      await provider.createVM({ ...baseConfig, size: 'small' });
      expect(lastMapping(nova).volume_size).toBe(80);
    }
  );

  it('deletes the server only; Nova owns the boot volume through delete_on_termination', async () => {
    const nova = fakeNova();
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });

    await provider.createVM({ ...baseConfig, size: 'small' });
    nova.requests.length = 0;
    await provider.deleteVM('server-1');

    expect(lastMapping(nova).delete_on_termination).toBe(true);
    expect(nova.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `DELETE ${COMPUTE}/servers/server-1`,
    ]);
  });
});

describe('Infomaniak observed root disk', () => {
  async function listOne(entry: Record<string, unknown>): Promise<VMInstance> {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce(json({ servers: [server(entry)] }));
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    const [vm] = await provider.listVMs();
    if (!vm) throw new Error('expected one VM');
    return vm;
  }

  it('keeps the flavor disk for legacy image-booted nodes (no migration)', async () => {
    const vm = await listOne({ image: { id: 'image-1' }, metadata: { managed: 'sam' } });
    expect(vm.observedHardware.resources).toEqual({
      value: { vcpuCount: 4, memoryMb: 8192, diskGb: 20 },
      source: 'observed',
    });
  });

  it('reads the recorded volume size, not flavor.disk, for volume-booted nodes', async () => {
    const vm = await listOne({
      image: '',
      metadata: { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80' },
    });
    expect(vm.observedHardware.resources).toEqual({
      value: { vcpuCount: 4, memoryMb: 8192, diskGb: 80 },
      source: 'observed',
    });
  });

  it.each([
    ['missing', {}],
    ['non-numeric', { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80GB' }],
    ['zero', { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '0' }],
    ['negative', { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '-5' }],
    ['fractional', { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80.5' }],
    ['below the volume minimum', { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '10' }],
    ['above the volume maximum', { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '9000000000000000' }],
  ])('reports unknown disk for a volume-booted node with a %s record', async (_label, metadata) => {
    const vm = await listOne({ image: '', metadata });
    expect(vm.observedHardware.resources).toMatchObject({ source: 'unknown', value: null });
    expect(vm.observedHardware.serverType).toEqual({
      value: 'a4-ram8-disk20-perf1',
      source: 'observed',
    });
  });

  it('reports unknown disk when the response omits the boot source', async () => {
    const vm = await listOne({ metadata: { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80' } });
    expect(vm.observedHardware.resources).toMatchObject({ source: 'unknown' });
  });

  it('maps a mixed inventory without failing the list', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce(
        json({
          servers: [
            server({ id: 'legacy', image: { id: 'image-1' }, metadata: {} }),
            server({
              id: 'volume',
              image: '',
              metadata: { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: '80' },
            }),
            server({
              id: 'broken',
              image: '',
              metadata: { [INFOMANIAK_ROOT_DISK_METADATA_KEY]: 'x' },
            }),
          ],
        })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    const vms = await provider.listVMs();
    expect(
      vms.map((vm) => [
        vm.id,
        vm.observedHardware.resources.source === 'observed'
          ? (vm.observedHardware.resources.value as { diskGb: number }).diskGb
          : null,
      ])
    ).toEqual([
      ['legacy', 20],
      ['volume', 80],
      ['broken', null],
    ]);
  });
});

describe('Infomaniak data volumes stay separate from boot volumes', () => {
  it('label-scoped volume listing never selects a Nova-created boot volume', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce(
        json({
          volumes: [
            {
              id: 'boot-vol',
              name: '',
              size: 80,
              status: 'in-use',
              attachments: [{ server_id: 'server-1' }],
              created_at: '2026-11-17T00:00:00Z',
              metadata: {},
            },
            {
              id: 'data-vol',
              name: 'data',
              size: 20,
              status: 'available',
              attachments: [],
              created_at: '2026-11-17T00:00:00Z',
              metadata: { managed: 'simple-agent-manager', env: 'e1' },
            },
          ],
        })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    const volumes = await provider.listVolumes({
      location: 'dc4-a',
      labels: { managed: 'simple-agent-manager', env: 'e1' },
    });
    expect(volumes.map((volume) => volume.id)).toEqual(['data-vol']);
  });
});
