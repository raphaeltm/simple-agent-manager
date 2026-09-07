import { afterEach, describe, expect, it, vi } from 'vitest';

import { InfomaniakProvider } from '../../src';
import {
  validateGcpInstance,
  validateHetznerServerResponse,
  validateScalewayServerResponse,
} from '../../src/validation';
import { validateDigitalOceanDropletResponse } from '../../src/validation-digitalocean';
import { validateUpCloudServerResponse } from '../../src/validation-upcloud';
import { validateVultrInstanceResponse } from '../../src/validation-vultr';

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

describe('provider observed hardware response validation', () => {
  it('rejects malformed Hetzner observed server type resources', () => {
    expect(() =>
      validateHetznerServerResponse(
        {
          server: {
            id: 1,
            name: 'vm',
            status: 'running',
            public_net: { ipv4: { ip: '203.0.113.10' } },
            server_type: { name: 'cax11', cores: '2' },
            created: '2026-09-07T00:00:00Z',
            labels: {},
          },
        },
        'server'
      )
    ).toThrow();
  });

  it('rejects malformed Scaleway observed commercial type', () => {
    expect(() =>
      validateScalewayServerResponse(
        {
          server: {
            id: 'server-1',
            name: 'vm',
            state: 'running',
            public_ip: null,
            public_ips: [],
            commercial_type: 42,
            creation_date: '2026-09-07T00:00:00Z',
            tags: [],
          },
        },
        'server'
      )
    ).toThrow();
  });

  it('rejects malformed DigitalOcean observed size resources', () => {
    expect(() =>
      validateDigitalOceanDropletResponse(
        {
          droplet: {
            id: 1,
            name: 'vm',
            status: 'active',
            size_slug: 's-2vcpu-4gb',
            created_at: '2026-09-07T00:00:00Z',
            networks: { v4: [] },
            tags: [],
            size: { vcpus: 2, memory: '4096', disk: 80 },
          },
        },
        'droplet'
      )
    ).toThrow();
  });

  it('rejects malformed Vultr observed plan resources', () => {
    expect(() =>
      validateVultrInstanceResponse(
        {
          instance: {
            id: 'instance-1',
            main_ip: '203.0.113.10',
            status: 'active',
            power_status: 'running',
            server_status: 'ok',
            region: 'fra',
            plan: 'vc2-2c-4gb',
            vcpu_count: '2',
            ram: 4096,
            disk: 80,
            date_created: '2026-09-07T00:00:00Z',
            label: 'vm',
            tags: [],
          },
        },
        'instance'
      )
    ).toThrow();
  });

  it('rejects malformed GCP observed machine type', () => {
    expect(() =>
      validateGcpInstance(
        {
          id: 'instance-1',
          name: 'vm',
          status: 'RUNNING',
          machineType: 42,
          creationTimestamp: '2026-09-07T00:00:00Z',
        },
        'instance'
      )
    ).toThrow();
  });

  it('rejects malformed UpCloud observed plan resources and accepts numeric strings', () => {
    expect(() =>
      validateUpCloudServerResponse(
        {
          server: {
            uuid: 'server-1',
            state: 'started',
            zone: 'de-fra1',
            plan: 'DEV-2xCPU-4GB',
            core_number: 'two',
            created: '2026-09-07T00:00:00Z',
            labels: { label: [] },
            ip_addresses: { ip_address: [] },
            storage_devices: { storage_device: [] },
          },
        },
        'server'
      )
    ).toThrow();

    expect(
      validateUpCloudServerResponse(
        {
          server: {
            uuid: 'server-1',
            state: 'started',
            zone: 'de-fra1',
            plan: 'DEV-2xCPU-4GB',
            core_number: '2',
            memory_amount: '4096',
            created: '2026-09-07T00:00:00Z',
            labels: { label: [] },
            ip_addresses: { ip_address: [] },
            storage_devices: { storage_device: [] },
          },
        },
        'server'
      )
    ).toMatchObject({ coreNumber: 2, memoryAmount: 4096 });
  });

  it('rejects malformed Infomaniak observed flavor resources', async () => {
    const authUrl = 'https://auth.example/v3';
    const compute = 'https://compute.example/v2.1/project';
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/tokens')) {
        return json(
          {
            token: {
              project: { id: 'project' },
              catalog: [{ type: 'compute', endpoints: [{ interface: 'public', region: 'dc4-a', url: compute }] }],
            },
          },
          201,
          { 'x-subject-token': 'subject-token' }
        );
      }
      if (url === `${compute}/servers/server-1`) {
        return json({
          server: {
            id: 'server-1',
            name: 'vm',
            status: 'ACTIVE',
            addresses: {},
            flavor: { id: 'flavor-1', original_name: 'a2-ram4-disk20-perf1', vcpus: 2, ram: '4096', disk: 20 },
            created: '2026-09-07T00:00:00Z',
            metadata: {},
          },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;

    const provider = new InfomaniakProvider('id', 'secret', { authUrl });
    await expect(provider.getVM('server-1')).rejects.toThrow();
  });
});
