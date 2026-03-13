import { vi } from 'vitest';

/**
 * Factory for creating mock Hetzner server response objects.
 */
export function createMockServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    name: 'test-server',
    status: 'running',
    public_net: { ipv4: { ip: '1.2.3.4' } },
    server_type: { name: 'cx33' },
    created: '2024-01-24T12:00:00Z',
    labels: {},
    ...overrides,
  };
}

/**
 * Create a mock fetch that routes requests to the appropriate Hetzner API response.
 * Covers all Provider interface methods.
 */
export function createHetznerFetchMock(overrides?: {
  /** Override the server returned by createVM */
  createServer?: Record<string, unknown>;
  /** Override the server returned by getVM */
  getServer?: Record<string, unknown>;
  /** Override the servers returned by listVMs */
  listServers?: Record<string, unknown>[];
}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const urlStr = url.toString();

    // POST /servers → createVM
    if (method === 'POST' && urlStr.endsWith('/servers')) {
      const server = overrides?.createServer ?? createMockServer({
        id: 99999,
        name: 'contract-test',
        status: 'initializing',
        public_net: { ipv4: { ip: '10.0.0.1' } },
        server_type: { name: 'cx23' },
        created: '2024-01-01T00:00:00Z',
      });
      return Promise.resolve(
        new Response(JSON.stringify({ server }), { status: 201 }),
      );
    }

    // DELETE /servers/:id → deleteVM (404 for 'non-existent' IDs)
    if (method === 'DELETE' && urlStr.includes('/servers/')) {
      if (urlStr.includes('non-existent')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }

    // GET /servers/:id → getVM (404 for 'non-existent' IDs)
    if (method === 'GET' && urlStr.match(/\/servers\/[^/?]+$/) && !urlStr.includes('?')) {
      if (urlStr.includes('non-existent')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
        );
      }
      const server = overrides?.getServer ?? createMockServer({
        public_net: { ipv4: { ip: '10.0.0.2' } },
        server_type: { name: 'cx23' },
        created: '2024-01-01T00:00:00Z',
      });
      return Promise.resolve(
        new Response(JSON.stringify({ server }), { status: 200 }),
      );
    }

    // GET /servers → listVMs
    if (method === 'GET' && (urlStr.endsWith('/servers') || urlStr.includes('/servers?'))) {
      const servers = overrides?.listServers ?? [];
      return Promise.resolve(
        new Response(JSON.stringify({ servers }), { status: 200 }),
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
}
