import { vi, beforeEach, afterEach } from 'vitest';
import { HetznerProvider } from '../../src/hetzner';
import { runProviderContractTests } from './provider-contract.test';

/**
 * Run the reusable contract test suite against HetznerProvider
 * with all API calls mocked.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Mock all Hetzner API responses
  globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const urlStr = url.toString();

    // POST /servers → createVM
    if (method === 'POST' && urlStr.endsWith('/servers')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            server: {
              id: 99999,
              name: 'contract-test',
              status: 'initializing',
              public_net: { ipv4: { ip: '10.0.0.1' } },
              server_type: { name: 'cx23' },
              created: '2024-01-01T00:00:00Z',
              labels: {},
            },
          }),
          { status: 201 },
        ),
      );
    }

    // DELETE /servers/:id → deleteVM (return 404 for non-existent to test idempotency)
    if (method === 'DELETE' && urlStr.includes('/servers/')) {
      if (urlStr.includes('non-existent')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }

    // GET /servers/:id → getVM (return 404 for non-existent)
    if (method === 'GET' && urlStr.match(/\/servers\/[^/?]+$/) && !urlStr.includes('?')) {
      if (urlStr.includes('non-existent')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            server: {
              id: 12345,
              name: 'test-vm',
              status: 'running',
              public_net: { ipv4: { ip: '10.0.0.2' } },
              server_type: { name: 'cx23' },
              created: '2024-01-01T00:00:00Z',
              labels: {},
            },
          }),
          { status: 200 },
        ),
      );
    }

    // GET /servers → listVMs
    if (method === 'GET' && (urlStr.endsWith('/servers') || urlStr.includes('/servers?'))) {
      return Promise.resolve(
        new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      );
    }

    // POST /servers/:id/actions/poweroff or poweron
    if (method === 'POST' && urlStr.includes('/actions/power')) {
      return Promise.resolve(
        new Response(JSON.stringify({ action: { id: 1, status: 'running' } }), { status: 200 }),
      );
    }

    // GET /datacenters → validateToken
    if (method === 'GET' && urlStr.includes('/datacenters')) {
      return Promise.resolve(
        new Response(JSON.stringify({ datacenters: [] }), { status: 200 }),
      );
    }

    // Default: 404
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
    );
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

runProviderContractTests(
  () => new HetznerProvider('contract-test-token'),
  { name: 'HetznerProvider Contract' },
);
