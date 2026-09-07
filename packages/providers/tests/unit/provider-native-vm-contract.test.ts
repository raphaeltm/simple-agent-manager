import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VMConfig } from '../../src';
import {
  DigitalOceanProvider,
  GcpProvider,
  HetznerProvider,
  InfomaniakProvider,
  ScalewayProvider,
  UpCloudProvider,
  VultrProvider,
} from '../../src';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function nativeConfig(size: string): VMConfig {
  return {
    name: 'sam-native-node',
    size: size as VMConfig['size'],
    location: 'native-region',
    userData: '#cloud-config\n',
    native: {
      instanceType: 'native-exact-type',
      bootDiskSizeGb: 96,
      resources: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
    },
  };
}

function nativeOnlyConfig(native: NonNullable<VMConfig['native']>): VMConfig {
  return {
    name: 'sam-native-node',
    location: 'native-region',
    userData: '#cloud-config\n',
    native,
  };
}

function unsupportedBootDiskConfig(instanceType: string, includedDiskGb: number): VMConfig {
  return nativeOnlyConfig({
    instanceType,
    bootDiskSizeGb: includedDiskGb + 1,
    resources: { vcpuCount: 2, memoryMb: 4096, diskGb: includedDiskGb },
  });
}

function normalizeBody(body: unknown): unknown {
  const text = String(body);
  return text ? JSON.parse(text) : undefined;
}

function mockGcpCreateVm(bodies: unknown[], machineType = 'native-exact-type'): void {
  globalThis.fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/global/firewalls') && init.method === 'POST') {
      return json({ error: { code: 409, message: 'already exists' } }, 409);
    }
    if (url.endsWith('/instances') && init.method === 'POST') {
      bodies.push(normalizeBody(init.body));
      return json({ name: 'operation-1', status: 'PENDING' });
    }
    if (url.includes('/operations/')) return json({ name: 'operation-1', status: 'DONE' });
    if (url.includes('/instances/sam-native-node')) {
      return json({
        id: 'instance-1',
        name: 'sam-native-node',
        status: 'RUNNING',
        machineType: `zones/us-central1-a/machineTypes/${machineType}`,
        creationTimestamp: '2026-09-07T00:00:00Z',
        networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
      });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
}

describe('provider native VM request contracts', () => {
  it('Hetzner uses native server_type and ignores contradictory legacy size', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_input, init = {}) => {
      bodies.push(normalizeBody(init.body));
      return json({
        server: {
          id: 1,
          name: 'sam-native-node',
          status: 'running',
          public_net: { ipv4: { ip: '203.0.113.10' } },
          server_type: { name: 'native-exact-type', cores: 7, memory: 14, disk: 96 },
          created: '2026-09-07T00:00:00Z',
          labels: {},
        },
      });
    }) as typeof fetch;

    const provider = new HetznerProvider('token', 'fsn1', undefined, false);
    const first = await provider.createVM({
      ...nativeOnlyConfig(nativeConfig('small').native!),
      location: 'fsn1',
    });
    const second = await provider.createVM({ ...nativeConfig('large'), location: 'fsn1' });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect((bodies[0] as Record<string, unknown>).server_type).toBe('native-exact-type');
    expect(first.observedHardware.resources).toEqual({
      value: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
      source: 'observed',
    });
    expect(second.serverType).toBe('native-exact-type');
  });

  it('Hetzner rejects unsupported fixed-root boot disk requests before allocation', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new HetznerProvider('token', 'fsn1', undefined, false);
    await expect(
      provider.createVM({
        ...unsupportedBootDiskConfig('arbitrary-hetzner-type', 80),
        location: 'fsn1',
      })
    ).rejects.toThrow('cannot satisfy requested native.bootDiskSizeGb');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Scaleway uses native commercial_type and requested architecture for image lookup', async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/images?')) return json({ images: [{ id: 'image-arm', name: 'Ubuntu' }] });
      if (url.endsWith('/servers') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({
          server: {
            id: 'server-1',
            name: 'sam-native-node',
            state: 'stopped',
            public_ip: null,
            public_ips: [],
            commercial_type: 'native-exact-type',
            creation_date: '2026-09-07T00:00:00Z',
            tags: [],
          },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const provider = new ScalewayProvider('secret', 'project', 'fr-par-1');
    await provider.createVM({
      ...nativeOnlyConfig({
        ...nativeConfig('small').native!,
        instanceType: 'native-exact-type',
        architecture: 'arm64',
      }),
      location: 'fr-par-1',
    });
    await provider.createVM({
      ...nativeConfig('large'),
      location: 'fr-par-1',
      native: { ...nativeConfig('large').native!, instanceType: 'native-exact-type', architecture: 'arm64' },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect((bodies[0] as { commercial_type: string }).commercial_type).toBe('native-exact-type');
    expect(urls.filter((url) => url.includes('/images?'))).toEqual([
      expect.stringContaining('arch=arm64'),
      expect.stringContaining('arch=arm64'),
    ]);
  });

  it('Scaleway rejects unsupported fixed-root boot disk requests before allocation', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new ScalewayProvider('secret', 'project', 'fr-par-1');
    await expect(
      provider.createVM({
        ...unsupportedBootDiskConfig('arbitrary-scaleway-type', 40),
        location: 'fr-par-1',
      })
    ).rejects.toThrow('cannot satisfy requested native.bootDiskSizeGb');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DigitalOcean uses native size slug without legacy storage authority', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_input, init = {}) => {
      bodies.push(normalizeBody(init.body));
      return json({
        droplet: {
          id: 1,
          name: 'sam-native-node',
          status: 'active',
          size_slug: 'native-exact-type',
          size: { vcpus: 7, memory: 14_336, disk: 96 },
          created_at: '2026-09-07T00:00:00Z',
          networks: { v4: [{ ip_address: '203.0.113.10', type: 'public' }] },
          tags: [],
        },
      });
    }) as typeof fetch;

    const provider = new DigitalOceanProvider('token', { region: 'fra1', ipPollTimeoutMs: 1 });
    const first = await provider.createVM({
      ...nativeOnlyConfig(nativeConfig('small').native!),
      location: 'fra1',
    });
    const second = await provider.createVM({ ...nativeConfig('large'), location: 'fra1' });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect((bodies[0] as { size: string }).size).toBe('native-exact-type');
    expect(first.observedHardware.resources).toEqual({
      value: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
      source: 'observed',
    });
    expect(second.serverType).toBe('native-exact-type');
  });

  it('DigitalOcean rejects unsupported fixed-root boot disk requests before allocation', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new DigitalOceanProvider('token', { region: 'fra1', ipPollTimeoutMs: 1 });
    await expect(
      provider.createVM({
        ...unsupportedBootDiskConfig('arbitrary-do-size', 80),
        location: 'fra1',
      })
    ).rejects.toThrow('cannot satisfy requested native.bootDiskSizeGb');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Vultr uses native plan and validates requested OS architecture', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/os?')) {
        return json({
          os: [{ id: 1743, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' }],
        });
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({
          instance: {
            id: 'instance-1',
            main_ip: '203.0.113.10',
            status: 'active',
            power_status: 'running',
            server_status: 'ok',
            region: 'fra',
            plan: 'native-exact-type',
            vcpu_count: 7,
            ram: 14_336,
            disk: 96,
            date_created: '2026-09-07T00:00:00Z',
            label: 'sam-native-node',
            tags: [],
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new VultrProvider('token', { region: 'fra', ipPollTimeoutMs: 1 });
    await provider.createVM({
      ...nativeOnlyConfig({ ...nativeConfig('small').native!, architecture: 'x86_64' }),
      location: 'fra',
    });
    await provider.createVM({
      ...nativeConfig('large'),
      location: 'fra',
      native: { ...nativeConfig('large').native!, architecture: 'x86_64' },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect((bodies[0] as { plan: string }).plan).toBe('native-exact-type');
  });

  it('Vultr rejects unsupported fixed-root boot disk requests before allocation', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new VultrProvider('token', { region: 'fra', ipPollTimeoutMs: 1 });
    await expect(
      provider.createVM({
        ...unsupportedBootDiskConfig('arbitrary-vultr-plan', 80),
        location: 'fra',
      })
    ).rejects.toThrow('cannot satisfy requested native.bootDiskSizeGb');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Vultr validates numeric OS overrides against requested architecture before allocation', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/os?')) {
        return json({
          os: [{ id: 1743, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' }],
        });
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new VultrProvider('token', { region: 'fra', ipPollTimeoutMs: 1 });
    await expect(
      provider.createVM({
        ...nativeOnlyConfig({
          instanceType: 'native-exact-type',
          bootDiskSizeGb: 96,
          image: '1743',
          architecture: 'arm64',
          resources: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
        }),
        location: 'fra',
      })
    ).rejects.toThrow('cannot satisfy "arm64"');
    expect(bodies).toEqual([]);
  });

  it('Vultr keys OS cache by architecture and revalidates neutral-name matches', async () => {
    const bodies: unknown[] = [];
    let osFetches = 0;
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/os?')) {
        osFetches += 1;
        return json({
          os: [{ id: 1743, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' }],
        });
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({
          instance: {
            id: 'instance-1',
            main_ip: '203.0.113.10',
            status: 'active',
            power_status: 'running',
            server_status: 'ok',
            region: 'fra',
            plan: 'native-exact-type',
            vcpu_count: 7,
            ram: 14_336,
            disk: 96,
            date_created: '2026-09-07T00:00:00Z',
            label: 'sam-native-node',
            tags: [],
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new VultrProvider('token', {
      region: 'fra',
      osName: 'Ubuntu 24.04 LTS',
      ipPollTimeoutMs: 1,
    });
    await provider.createVM({
      ...nativeOnlyConfig({
        instanceType: 'native-exact-type',
        bootDiskSizeGb: 96,
        architecture: 'x86_64',
        resources: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
      }),
      location: 'fra',
    });

    await expect(
      provider.createVM({
        ...nativeOnlyConfig({
          instanceType: 'native-exact-type',
          bootDiskSizeGb: 96,
          architecture: 'arm64',
          resources: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
        }),
        location: 'fra',
      })
    ).rejects.toThrow('cannot satisfy "arm64"');
    expect(osFetches).toBe(2);
    expect(bodies).toHaveLength(1);
  });

  it('GCP uses native machineType and requested boot disk size', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/global/firewalls') && init.method === 'POST') {
        return json({ error: { code: 409, message: 'already exists' } }, 409);
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({ name: 'operation-1', status: 'PENDING' });
      }
      if (url.includes('/operations/')) return json({ name: 'operation-1', status: 'DONE' });
      if (url.includes('/instances/sam-native-node')) {
        return json({
          id: 'instance-1',
          name: 'sam-native-node',
          status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/native-exact-type',
          creationTimestamp: '2026-09-07T00:00:00Z',
          networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new GcpProvider('project', async () => 'token', 'us-central1-a');
    const first = await provider.createVM({
      ...nativeOnlyConfig(nativeConfig('small').native!),
      location: 'us-central1-a',
    });
    const second = await provider.createVM({ ...nativeConfig('large'), location: 'us-central1-a' });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    const body = bodies[0] as {
      machineType: string;
      disks: Array<{ initializeParams: { diskSizeGb: string; sourceImage: string } }>;
    };
    expect(body.machineType).toContain('/machineTypes/native-exact-type');
    expect(body.disks[0]?.initializeParams.diskSizeGb).toBe('96');
    expect(body.disks[0]?.initializeParams.sourceImage).toBe(
      'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64'
    );
    expect(first.observedHardware.resources.source).toBe('unknown');
    expect(second.serverType).toBe('native-exact-type');
  });

  it('GCP keeps provider disk defaults for legacy callers and accepts full image refs', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/global/firewalls') && init.method === 'POST') {
        return json({ error: { code: 409, message: 'already exists' } }, 409);
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({ name: 'operation-1', status: 'PENDING' });
      }
      if (url.includes('/operations/')) return json({ name: 'operation-1', status: 'DONE' });
      if (url.includes('/instances/sam-native-node')) {
        return json({
          id: 'instance-1',
          name: 'sam-native-node',
          status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/e2-medium',
          creationTimestamp: '2026-09-07T00:00:00Z',
          networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new GcpProvider(
      'project',
      async () => 'token',
      'us-central1-a',
      'ubuntu-2404-lts-amd64',
      'ubuntu-os-cloud',
      200
    );
    await provider.createVM({
      name: 'sam-native-node',
      size: 'small',
      location: 'us-central1-a',
      userData: '#cloud-config\n',
      image: 'projects/custom-images/global/images/sam-node-v20260907',
    });

    const body = bodies[0] as { disks: Array<{ initializeParams: { diskSizeGb: string; sourceImage: string } }> };
    expect(body.disks[0]?.initializeParams.diskSizeGb).toBe('200');
    expect(body.disks[0]?.initializeParams.sourceImage).toBe(
      'projects/custom-images/global/images/sam-node-v20260907'
    );
  });

  it.each([
    {
      name: 'matching legacy-mapped top-level instanceType without size',
      config: { instanceType: 'e2-medium' },
    },
    {
      name: 'matching legacy-mapped top-level instanceType with conflicting size',
      config: { size: 'large' as VMConfig['size'], instanceType: 'e2-medium' },
    },
    {
      name: 'arbitrary top-level instanceType without size',
      config: { instanceType: 'c4-standard-7' },
    },
    {
      name: 'arbitrary top-level instanceType with conflicting size',
      config: { size: 'small' as VMConfig['size'], instanceType: 'c4-standard-7' },
    },
  ])('GCP keeps provider disk defaults for $name', async ({ config }) => {
    const bodies: unknown[] = [];
    mockGcpCreateVm(bodies, config.instanceType);

    const provider = new GcpProvider(
      'project',
      async () => 'token',
      'us-central1-a',
      'ubuntu-2404-lts-amd64',
      'ubuntu-os-cloud',
      200
    );
    await provider.createVM({
      name: 'sam-native-node',
      location: 'us-central1-a',
      userData: '#cloud-config\n',
      ...config,
    });

    const body = bodies[0] as {
      machineType: string;
      disks: Array<{ initializeParams: { diskSizeGb: string } }>;
    };
    expect(body.machineType).toContain(`/machineTypes/${config.instanceType}`);
    expect(body.disks[0]?.initializeParams.diskSizeGb).toBe('200');
  });

  it('GCP keeps explicit native boot disk authoritative over provider defaults', async () => {
    const bodies: unknown[] = [];
    mockGcpCreateVm(bodies, 'c4-standard-7');

    const provider = new GcpProvider(
      'project',
      async () => 'token',
      'us-central1-a',
      'ubuntu-2404-lts-amd64',
      'ubuntu-os-cloud',
      200
    );
    await provider.createVM({
      ...nativeConfig('small'),
      location: 'us-central1-a',
      native: {
        instanceType: 'c4-standard-7',
        bootDiskSizeGb: 96,
        resources: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
      },
    });

    const body = bodies[0] as { disks: Array<{ initializeParams: { diskSizeGb: string } }> };
    expect(body.disks[0]?.initializeParams.diskSizeGb).toBe('96');
  });

  it('GCP resolves configured image family names and native family references', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/global/firewalls') && init.method === 'POST') {
        return json({ error: { code: 409, message: 'already exists' } }, 409);
      }
      if (url.endsWith('/instances') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({ name: 'operation-1', status: 'PENDING' });
      }
      if (url.includes('/operations/')) return json({ name: 'operation-1', status: 'DONE' });
      if (url.includes('/instances/sam-native-node')) {
        return json({
          id: 'instance-1',
          name: 'sam-native-node',
          status: 'RUNNING',
          machineType: 'zones/us-central1-a/machineTypes/native-exact-type',
          creationTimestamp: '2026-09-07T00:00:00Z',
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new GcpProvider('project', async () => 'token', 'us-central1-a');
    await provider.createVM({
      ...nativeOnlyConfig({
        instanceType: 'native-exact-type',
        bootDiskSizeGb: 64,
        image: 'family/debian-12',
        resources: { vcpuCount: 2, memoryMb: 4096, diskGb: 64 },
      }),
      location: 'us-central1-a',
    });

    const body = bodies[0] as { disks: Array<{ initializeParams: { sourceImage: string } }> };
    expect(body.disks[0]?.initializeParams.sourceImage).toBe(
      'projects/ubuntu-os-cloud/global/images/family/debian-12'
    );
  });

  it.each([
    {
      image: 'ubuntu-2404-lts-amd64',
      expected: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
    },
    {
      image: 'family/debian-12',
      expected: 'projects/ubuntu-os-cloud/global/images/family/debian-12',
    },
    {
      image: 'images/custom-image',
      expected: 'projects/ubuntu-os-cloud/global/images/custom-image',
    },
    {
      image: 'global/images/custom-image',
      expected: 'global/images/custom-image',
    },
    {
      image: 'global/images/family/custom-family',
      expected: 'global/images/family/custom-family',
    },
    {
      image: 'projects/custom-images/global/images/custom-image',
      expected: 'projects/custom-images/global/images/custom-image',
    },
    {
      image: 'projects/custom-images/global/images/family/custom-family',
      expected: 'projects/custom-images/global/images/family/custom-family',
    },
    {
      image: 'https://www.googleapis.com/compute/v1/projects/custom-images/global/images/custom-image',
      expected: 'https://www.googleapis.com/compute/v1/projects/custom-images/global/images/custom-image',
    },
    {
      image: 'https://compute.googleapis.com/compute/v1/projects/custom-images/global/images/family/custom-family',
      expected: 'https://compute.googleapis.com/compute/v1/projects/custom-images/global/images/family/custom-family',
    },
  ])('GCP normalizes image reference $image', async ({ image, expected }) => {
    const bodies: unknown[] = [];
    mockGcpCreateVm(bodies);

    const provider = new GcpProvider('project', async () => 'token', 'us-central1-a');
    await provider.createVM({
      ...nativeOnlyConfig({
        instanceType: 'native-exact-type',
        bootDiskSizeGb: 64,
        image,
        resources: { vcpuCount: 2, memoryMb: 4096, diskGb: 64 },
      }),
      location: 'us-central1-a',
    });

    const body = bodies[0] as { disks: Array<{ initializeParams: { sourceImage: string } }> };
    expect(body.disks[0]?.initializeParams.sourceImage).toBe(expected);
  });

  it.each([
    'images/custom-image/extra',
    'family/debian-12/extra',
    'global/family/debian-12',
    'projects/custom-images/zones/us-central1-a/images/custom-image',
    'https://example.com/compute/v1/projects/custom-images/global/images/custom-image',
  ])('GCP rejects malformed image reference %s', async (image) => {
    const bodies: unknown[] = [];
    mockGcpCreateVm(bodies);

    const provider = new GcpProvider('project', async () => 'token', 'us-central1-a');
    await expect(
      provider.createVM({
        ...nativeOnlyConfig({
          instanceType: 'native-exact-type',
          bootDiskSizeGb: 64,
          image,
          resources: { vcpuCount: 2, memoryMb: 4096, diskGb: 64 },
        }),
        location: 'us-central1-a',
      })
    ).rejects.toThrow('GCP image must be an image family name or a Compute Engine image/family reference');
    expect(bodies).toEqual([]);
  });

  it('Infomaniak resolves native flavor names without legacy size authority', async () => {
    const authUrl = 'https://auth.example/v3';
    const compute = 'https://compute.example/v2.1/project';
    const image = 'https://image.example';
    const network = 'https://network.example';
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/auth/tokens')) {
        return json(
          {
            token: {
              project: { id: 'project' },
              catalog: [
                { type: 'compute', endpoints: [{ interface: 'public', region: 'dc4-a', url: compute }] },
                { type: 'image', endpoints: [{ interface: 'public', region: 'dc4-a', url: image }] },
                { type: 'network', endpoints: [{ interface: 'public', region: 'dc4-a', url: network }] },
                { type: 'volumev3', endpoints: [{ interface: 'public', region: 'dc4-a', url: 'v' }] },
              ],
            },
          },
          201,
          { 'x-subject-token': 'subject-token' }
        );
      }
      if (url === `${image}/v2/images?name=Ubuntu%2024.04%20noble`) {
        return json({ images: [{ id: 'image-1', name: 'Ubuntu 24.04 noble' }] });
      }
      if (url === `${compute}/flavors/detail?name=native-exact-type`) {
        return json({ flavors: [{ id: 'flavor-1', name: 'native-exact-type' }] });
      }
      if (url === `${network}/v2.0/networks?name=ext-net1`) {
        return json({ networks: [{ id: 'network-1', name: 'ext-net1' }] });
      }
      if (url === `${compute}/servers` && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({ server: { id: 'server-1' } }, 202);
      }
      if (url === `${compute}/servers/server-1`) {
        return json({
          server: {
            id: 'server-1',
            name: 'sam-native-node',
            status: 'ACTIVE',
            addresses: { ext: [{ version: 4, addr: '203.0.113.10' }] },
            flavor: { id: 'flavor-1', original_name: 'native-exact-type', vcpus: 7, ram: 14_336, disk: 96 },
            created: '2026-09-07T00:00:00Z',
            metadata: {},
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new InfomaniakProvider('id', 'secret', { authUrl });
    const first = await provider.createVM({
      ...nativeOnlyConfig(nativeConfig('small').native!),
      location: 'dc4-a',
    });
    const second = await provider.createVM({ ...nativeConfig('large'), location: 'dc4-a' });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect((bodies[0] as { server: { flavorRef: string } }).server.flavorRef).toBe('flavor-1');
    expect(first.observedHardware.resources).toEqual({
      value: { vcpuCount: 7, memoryMb: 14_336, diskGb: 96 },
      source: 'observed',
    });
    expect(second.serverType).toBe('native-exact-type');
  });

  it('Infomaniak rejects unsupported fixed-root boot disk requests before allocation', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new InfomaniakProvider('id', 'secret', { authUrl: 'https://auth.example/v3' });
    await expect(
      provider.createVM({
        ...unsupportedBootDiskConfig('arbitrary-infomaniak-flavor', 20),
        location: 'dc4-a',
      })
    ).rejects.toThrow('cannot satisfy requested native.bootDiskSizeGb');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('UpCloud uses native plan and disk request independent of legacy size', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/zone')) return json({ zones: { zone: [{ id: 'de-fra1' }] } });
      if (url.endsWith('/plan')) return json({ plans: { plan: [{ name: 'native-exact-type' }] } });
      if (url.endsWith('/storage/template')) {
        return json({
          storages: {
            storage: [
              {
                uuid: 'template-1',
                title: 'Ubuntu Server 24.04 LTS',
                size: 10,
                zone: '',
                type: 'template',
                template_type: 'cloud-init',
                servers: { server: [] },
              },
            ],
          },
        });
      }
      if (url.endsWith('/server') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({
          server: {
            uuid: 'server-1',
            title: 'sam-native-node',
            hostname: 'sam-native-node',
            state: 'started',
            zone: 'de-fra1',
            plan: 'native-exact-type',
            core_number: 7,
            memory_amount: 14_336,
            created: '2026-09-07T00:00:00Z',
            labels: { label: [] },
            ip_addresses: { ip_address: [{ access: 'public', family: 'IPv4', address: '203.0.113.10' }] },
            storage_devices: { storage_device: [] },
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new UpCloudProvider('user', 'password', { zone: 'de-fra1', ipPollTimeoutMs: 1 });
    const first = await provider.createVM({
      ...nativeOnlyConfig(nativeConfig('small').native!),
      location: 'de-fra1',
    });
    const second = await provider.createVM({ ...nativeConfig('large'), location: 'de-fra1' });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    const body = bodies[0] as { server: { plan: string; storage_devices: { storage_device: Array<{ size: number }> } } };
    expect(body.server.plan).toBe('native-exact-type');
    expect(body.server.storage_devices.storage_device[0]?.size).toBe(96);
    expect(first.observedHardware.resources).toEqual({
      value: { vcpuCount: 7, memoryMb: 14_336 },
      source: 'observed',
    });
    expect(second.serverType).toBe('native-exact-type');
  });

  it('UpCloud supports arbitrary native plans with concrete disk metadata and no legacy size', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/zone')) return json({ zones: { zone: [{ id: 'de-fra1' }] } });
      if (url.endsWith('/plan')) return json({ plans: { plan: [{ name: 'DEV-64xCPU-384GB' }] } });
      if (url.endsWith('/storage/template')) {
        return json({
          storages: {
            storage: [
              {
                uuid: 'template-1',
                title: 'Ubuntu Server 24.04 LTS',
                size: 10,
                zone: '',
                type: 'template',
                template_type: 'cloud-init',
                servers: { server: [] },
              },
            ],
          },
        });
      }
      if (url.endsWith('/server') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({
          server: {
            uuid: 'server-1',
            title: 'sam-native-node',
            state: 'started',
            zone: 'de-fra1',
            plan: 'DEV-64xCPU-384GB',
            core_number: 64,
            memory_amount: 393_216,
            created: '2026-09-07T00:00:00Z',
            labels: { label: [] },
            ip_addresses: {
              ip_address: [{ access: 'public', family: 'IPv4', address: '203.0.113.10' }],
            },
            storage_devices: { storage_device: [] },
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new UpCloudProvider('user', 'password', { zone: 'de-fra1', ipPollTimeoutMs: 1 });
    await provider.createVM({
      ...nativeOnlyConfig({
        instanceType: 'DEV-64xCPU-384GB',
        resources: { vcpuCount: 64, memoryMb: 393_216, diskGb: 480 },
      }),
      location: 'de-fra1',
    });

    const body = bodies[0] as { server: { storage_devices: { storage_device: Array<{ size: number }> } } };
    expect(body.server.storage_devices.storage_device[0]?.size).toBe(480);
  });

  it('UpCloud top-level instanceType compatibility uses alias disk only through the adapter', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/zone')) return json({ zones: { zone: [{ id: 'de-fra1' }] } });
      if (url.endsWith('/plan')) return json({ plans: { plan: [{ name: '4xCPU-8GB' }] } });
      if (url.endsWith('/storage/template')) {
        return json({
          storages: {
            storage: [
              {
                uuid: 'template-1',
                title: 'Ubuntu Server 24.04 LTS',
                size: 10,
                zone: '',
                type: 'template',
                template_type: 'cloud-init',
                servers: { server: [] },
              },
            ],
          },
        });
      }
      if (url.endsWith('/server') && init.method === 'POST') {
        bodies.push(normalizeBody(init.body));
        return json({
          server: {
            uuid: 'server-1',
            title: 'sam-native-node',
            state: 'started',
            zone: 'de-fra1',
            plan: '4xCPU-8GB',
            core_number: 4,
            memory_amount: 8192,
            created: '2026-09-07T00:00:00Z',
            labels: { label: [] },
            ip_addresses: {
              ip_address: [{ access: 'public', family: 'IPv4', address: '203.0.113.10' }],
            },
            storage_devices: { storage_device: [] },
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new UpCloudProvider('user', 'password', { zone: 'de-fra1', ipPollTimeoutMs: 1 });
    await provider.createVM({
      name: 'sam-native-node',
      instanceType: '4xCPU-8GB',
      location: 'de-fra1',
      userData: '#cloud-config\n',
    });

    const body = bodies[0] as { server: { storage_devices: { storage_device: Array<{ size: number }> } } };
    expect(body.server.storage_devices.storage_device[0]?.size).toBe(80);
  });
});
