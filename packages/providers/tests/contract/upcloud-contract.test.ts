import { afterEach, beforeEach, vi } from 'vitest';

import { UpCloudProvider } from '../../src/upcloud';
import { runProviderContractTests } from './provider-contract.test';
const originalFetch = globalThis.fetch;
const server = (id = 'srv-1', overrides = {}) => ({
  uuid: id,
  title: 'contract-test',
  hostname: 'contract-test',
  state: 'started',
  zone: 'de-fra1',
  plan: '2xCPU-4GB',
  created: '2026-01-01T00:00:00Z',
  labels: { label: [] },
  ip_addresses: { ip_address: [{ access: 'public', family: 'IPv4', address: '203.0.113.2' }] },
  storage_devices: {
    storage_device: [
      { address: 'virtio:0', storage: 'root-1', storage_title: 'root', boot_disk: '1' },
    ],
  },
  ...overrides,
});
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input),
      method = init.method ?? 'GET';
    if (url.endsWith('/zone'))
      return new Response(JSON.stringify({ zones: { zone: [{ id: 'de-fra1' }] } }));
    if (url.endsWith('/plan'))
      return new Response(JSON.stringify({ plans: { plan: [{ name: '2xCPU-4GB' }] } }));
    if (url.endsWith('/storage/template'))
      return new Response(
        JSON.stringify({
          storages: {
            storage: [
              {
                uuid: 'tpl',
                title: 'Ubuntu Server 24.04 LTS',
                size: 10,
                state: 'online',
                zone: '',
                tier: 'maxiops',
                type: 'template',
                template_type: 'cloud-init',
                labels: [],
                servers: { server: [] },
              },
            ],
          },
        })
      );
    if (url.includes('non-existent-id'))
      return new Response(
        JSON.stringify({ error: { error_code: 'SERVER_NOT_FOUND', error_message: 'not found' } }),
        { status: 404 }
      );
    if (url.endsWith('/account'))
      return new Response(JSON.stringify({ account: { username: 'u' } }));
    if (url.endsWith('/server') && method === 'GET')
      return new Response(JSON.stringify({ servers: { server: [] } }));
    if (url.endsWith('/server') && method === 'POST')
      return new Response(JSON.stringify({ server: server() }));
    if (url.includes('/stop'))
      return new Response(JSON.stringify({ server: server('test-id', { state: 'stopped' }) }));
    if (url.endsWith('/server/test-id'))
      return new Response(JSON.stringify({ server: server('test-id', { state: 'stopped' }) }));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
runProviderContractTests(
  () => new UpCloudProvider('user', 'password', { ipPollTimeoutMs: 20, ipPollIntervalMs: 1 }),
  { name: 'UpCloudProvider Contract', createReturnsIp: true }
);
