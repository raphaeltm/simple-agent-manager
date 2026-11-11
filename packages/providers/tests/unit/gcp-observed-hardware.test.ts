/**
 * GCP observed hardware. The Compute instance resource names its machine type but not the
 * type's vCPU or memory, so before this fix every GCP node was stored with unknown resources and
 * workspace admission refused it forever (production node 01M73DSGQ07WQTBZMGPXJPJ281,
 * 2026-11-10: "node has no trusted observed hardware capacity"). These tests drive the real
 * createVM path with production-shaped responses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcpProvider } from '../../src/gcp';
import { gcpInstanceToVM } from '../../src/gcp-native-instance';
import type { VMInstance } from '../../src/types';
import { validateGcpInstance } from '../../src/validation-gcp';
import { testIpv4 } from './test-helpers';

const API = 'https://compute.googleapis.com/compute/v1/projects/test-project';
const ZONE = 'europe-west1-b';

/** Shaped like a real `instances.get` response: full self-links, int64 strings. */
function realInstance(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'compute#instance',
    id: '1861759100528809252',
    name: 'node-gcp',
    status: 'RUNNING',
    zone: `https://www.googleapis.com/compute/v1/projects/test-project/zones/${ZONE}`,
    machineType: `https://www.googleapis.com/compute/v1/projects/test-project/zones/${ZONE}/machineTypes/e2-standard-4`,
    creationTimestamp: '2026-11-10T11:08:39.008-08:00',
    networkInterfaces: [{ accessConfigs: [{ natIP: testIpv4(35, 1, 2, 3) }] }],
    disks: [
      { boot: false, diskSizeGb: '200', deviceName: 'data' },
      { boot: true, diskSizeGb: '50', deviceName: 'persistent-disk-0' },
    ],
    labels: { 'sam-managed': 'true' },
    ...overrides,
  };
}

/** Shaped like a real `machineTypes.get` response. */
function realMachineType() {
  return {
    kind: 'compute#machineType',
    name: 'e2-standard-4',
    guestCpus: 4,
    memoryMb: 16384,
    zone: ZONE,
    isSharedCpu: false,
  };
}

interface FakeComputeOptions {
  instance?: Record<string, unknown>;
  /** Status per machineTypes.get call, in order; the last value repeats. Default: 200. */
  machineTypeStatuses?: number[];
}

function installFakeCompute(options: FakeComputeOptions = {}) {
  const requests: string[] = [];
  let machineTypeCalls = 0;
  globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const method = init.method ?? 'GET';
    requests.push(`${method} ${target}`);
    if (target.endsWith('/global/firewalls') && method === 'POST') {
      return new Response(JSON.stringify({ error: { code: 409, message: 'exists' } }), {
        status: 409,
      });
    }
    if (target.endsWith(`/zones/${ZONE}/instances`) && method === 'POST') {
      return new Response(JSON.stringify({ name: 'op-create', status: 'PENDING' }));
    }
    if (target.includes('/operations/')) {
      return new Response(JSON.stringify({ name: 'op-create', status: 'DONE' }));
    }
    if (target === `${API}/zones/${ZONE}/instances/node-gcp`) {
      return new Response(JSON.stringify(options.instance ?? realInstance()));
    }
    if (target === `${API}/zones/${ZONE}/machineTypes/e2-standard-4`) {
      const statuses = options.machineTypeStatuses ?? [200];
      const status = statuses[Math.min(machineTypeCalls, statuses.length - 1)] ?? 200;
      machineTypeCalls++;
      return status === 200
        ? new Response(JSON.stringify(realMachineType()))
        : new Response(JSON.stringify({ error: { code: status, message: 'boom' } }), { status });
    }
    return new Response(JSON.stringify({ error: { code: 404, message: 'not found' } }), {
      status: 404,
    });
  }) as typeof fetch;
  return requests;
}

function newProvider() {
  return new GcpProvider('test-project', vi.fn().mockResolvedValue('token'), ZONE);
}

async function createNode(): Promise<VMInstance> {
  return newProvider().createVM({
    name: 'node-gcp',
    size: 'large',
    location: ZONE,
    userData: '#cloud-config',
    instanceType: 'e2-standard-4',
  });
}

describe('GCP observed hardware', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createVM reports the machine type resources and boot disk as observed', async () => {
    const requests = installFakeCompute();

    const vm = await createNode();

    expect(vm.observedHardware).toEqual({
      serverType: { source: 'observed', value: 'e2-standard-4' },
      resources: {
        source: 'observed',
        value: { vcpuCount: 4, memoryMb: 16384, diskGb: 50 },
      },
    });
    // The lookup goes to the project's Compute API, rebuilt from the zone and type name,
    // not by following the www.googleapis.com self-link in the instance response.
    expect(requests).toContain(`GET ${API}/zones/${ZONE}/machineTypes/e2-standard-4`);
    expect(requests.some((r) => r.includes('www.googleapis.com'))).toBe(false);
  });

  it('getObservedVM reports observed hardware and the zone, for allocation recovery', async () => {
    const requests = installFakeCompute();

    const vm = await newProvider().getObservedVM('node-gcp');

    expect(vm?.id).toBe('1861759100528809252');
    expect(vm?.observedHardware.resources.source).toBe('observed');
    expect(vm?.location).toBe(ZONE);
    expect(requests.filter((r) => r.includes('/machineTypes/'))).toHaveLength(1);
  });

  it('getVM stays a single lookup for existence and ownership callers', async () => {
    const requests = installFakeCompute();

    const vm = await newProvider().getVM('node-gcp');

    expect(vm?.id).toBe('1861759100528809252');
    expect(vm?.location).toBe(ZONE);
    expect(requests.filter((r) => r.includes('/machineTypes/'))).toHaveLength(0);
  });

  it('retries a transient machine type failure and still reports observed resources', async () => {
    const requests = installFakeCompute({ machineTypeStatuses: [503, 200] });

    const vm = await createNode();

    expect(vm.observedHardware.resources.source).toBe('observed');
    expect(requests.filter((r) => r.includes('/machineTypes/'))).toHaveLength(2);
  });

  it('a machine type lookup that keeps failing leaves resources unknown and still returns the created VM', async () => {
    const requests = installFakeCompute({ machineTypeStatuses: [503] });

    const vm = await createNode();

    // Bounded: DEFAULT_GCP_MACHINE_TYPE_LOOKUP_ATTEMPTS, then give up.
    expect(requests.filter((r) => r.includes('/machineTypes/'))).toHaveLength(3);
    expect(vm.id).toBe('1861759100528809252');
    expect(vm.observedHardware.serverType).toEqual({ source: 'observed', value: 'e2-standard-4' });
    expect(vm.observedHardware.resources.source).toBe('unknown');
  });

  it('a non-transient machine type failure (404) gives up without retrying', async () => {
    const requests = installFakeCompute({ machineTypeStatuses: [404, 200] });

    const vm = await createNode();

    expect(requests.filter((r) => r.includes('/machineTypes/'))).toHaveLength(1);
    expect(vm.observedHardware.resources.source).toBe('unknown');
  });

  it('an instance without a boot disk size leaves resources unknown', async () => {
    installFakeCompute({ instance: realInstance({ disks: [{ boot: false, diskSizeGb: '50' }] }) });

    const vm = await createNode();

    expect(vm.observedHardware.resources.source).toBe('unknown');
  });

  it('cancellation during the machine type lookup propagates instead of degrading', async () => {
    installFakeCompute();
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/machineTypes/')) {
        controller.abort(reason);
        throw reason;
      }
      return inner(url, init);
    }) as typeof fetch;

    await expect(
      newProvider().createVM(
        {
          name: 'node-gcp',
          size: 'large',
          location: ZONE,
          userData: '#cloud-config',
          instanceType: 'e2-standard-4',
        },
        { signal: controller.signal }
      )
    ).rejects.toBe(reason);
  });
});

describe('GCP boot disk parsing', () => {
  const base = {
    id: '1',
    name: 'vm',
    status: 'RUNNING',
    machineType: `zones/${ZONE}/machineTypes/e2-standard-4`,
    creationTimestamp: '2026-11-10T00:00:00Z',
  };

  it.each([
    ['int64 string', [{ boot: true, diskSizeGb: '50' }], 50],
    ['number', [{ boot: true, diskSizeGb: 80 }], 80],
    ['no boot disk', [{ boot: false, diskSizeGb: '50' }], undefined],
    ['non-numeric', [{ boot: true, diskSizeGb: 'fifty' }], undefined],
    ['zero', [{ boot: true, diskSizeGb: '0' }], undefined],
    ['malformed entry', ['nope', null, { boot: true, diskSizeGb: '30' }], 30],
    ['no disks', undefined, undefined],
  ])('%s', (_label, disks, expected) => {
    const parsed = validateGcpInstance({ ...base, ...(disks ? { disks } : {}) }, 'instance');
    expect(parsed.bootDiskSizeGb).toBe(expected);
  });

  it('without machine type resources, the mapped VM keeps resources unknown', () => {
    const vm = gcpInstanceToVM(validateGcpInstance({ ...base, disks: [] }, 'instance'));
    expect(vm.observedHardware.resources.source).toBe('unknown');
  });
});
