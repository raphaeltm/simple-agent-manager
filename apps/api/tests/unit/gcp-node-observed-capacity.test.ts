/**
 * Vertical slice for GCP workspace node capacity: the real GcpProvider.createVM response,
 * through the provisioning D1 mapping (`observedHardwareDbValues`), into the admission gate
 * (`resolveTrustedWorkspaceNodeCapacity`) that refused production GCP node
 * 01M73DSGQ07WQTBZMGPXJPJ281 on 2026-11-10 with "node has no trusted observed hardware
 * capacity". Only Google's Compute API is faked, at the fetch boundary.
 */
import { GcpProvider } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveTrustedWorkspaceNodeCapacity,
} from '../../src/scheduler-core';
import { observedHardwareDbValues } from '../../src/services/runtime-allocation';

const API = 'https://compute.googleapis.com/compute/v1/projects/sam-gcp';
const ZONE = 'europe-west1-b';

function installFakeCompute(machineTypeStatus = 200) {
  globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const method = init.method ?? 'GET';
    if (target.endsWith('/global/firewalls') && method === 'POST') {
      return new Response(JSON.stringify({ error: { code: 409, message: 'exists' } }), {
        status: 409,
      });
    }
    if (target.endsWith(`/zones/${ZONE}/instances`) && method === 'POST') {
      return new Response(JSON.stringify({ name: 'op', status: 'PENDING' }));
    }
    if (target.includes('/operations/')) {
      return new Response(JSON.stringify({ name: 'op', status: 'DONE' }));
    }
    if (target === `${API}/zones/${ZONE}/instances/node-gcp`) {
      return new Response(
        JSON.stringify({
          id: '1861759100528809252',
          name: 'node-gcp',
          status: 'RUNNING',
          machineType: `https://www.googleapis.com/compute/v1/projects/sam-gcp/zones/${ZONE}/machineTypes/e2-standard-4`,
          creationTimestamp: '2026-11-10T11:08:39.008-08:00',
          networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.7' }] }],
          disks: [{ boot: true, diskSizeGb: '50' }],
          labels: { 'sam-managed': 'true' },
        })
      );
    }
    if (target === `${API}/zones/${ZONE}/machineTypes/e2-standard-4`) {
      return machineTypeStatus === 200
        ? new Response(JSON.stringify({ name: 'e2-standard-4', guestCpus: 4, memoryMb: 16384 }))
        : new Response(JSON.stringify({ error: { code: machineTypeStatus } }), {
            status: machineTypeStatus,
          });
    }
    return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
  }) as typeof fetch;
}

async function provisionedNodeRow() {
  const provider = new GcpProvider('sam-gcp', vi.fn().mockResolvedValue('token'), ZONE);
  const vm = await provider.createVM({
    name: 'node-gcp',
    size: 'large',
    location: ZONE,
    userData: '#cloud-config',
    instanceType: 'e2-standard-4',
  });
  return {
    nodeClass: 'managed',
    providerInstanceId: vm.id,
    ...observedHardwareDbValues(vm),
  };
}

describe('GCP node observed capacity reaches workspace admission', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('a provisioned GCP node has trusted observed capacity', async () => {
    installFakeCompute();
    const row = await provisionedNodeRow();

    expect(row.observedHardwareSource).toBe('observed');
    expect(resolveTrustedWorkspaceNodeCapacity(row)).toEqual({
      vcpuCount: 4,
      memoryMb: 16384,
      diskGb: 50,
      source: 'observed',
      reasons: [],
    });
  });

  it('control: when the machine type cannot be read, admission still fails closed', async () => {
    installFakeCompute(503);
    const row = await provisionedNodeRow();

    expect(row.observedHardwareSource).toBe('observed/unknown');
    expect(resolveTrustedWorkspaceNodeCapacity(row).reasons).toEqual([
      'node has no trusted observed hardware capacity',
    ]);
  });
});
