import { vi } from 'vitest';

/**
 * Factory for creating mock Scaleway server response objects.
 */
export function createMockScalewayServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'test-server',
    state: 'running',
    public_ip: { address: '1.2.3.4' },
    public_ips: [{ address: '1.2.3.4' }],
    commercial_type: 'DEV1-XL',
    creation_date: '2024-01-24T12:00:00Z',
    tags: [],
    ...overrides,
  };
}

/**
 * Create a mock fetch that routes requests to the appropriate Scaleway API response.
 * Covers all Provider interface methods.
 */
export function createScalewayFetchMock(overrides?: {
  /** Override the server returned by createVM */
  createServer?: Record<string, unknown>;
  /** Override the server returned by getVM */
  getServer?: Record<string, unknown>;
  /** Override the servers returned by listVMs */
  listServers?: Record<string, unknown>[];
  /** Override images returned by resolveImageId */
  images?: Array<{ id: string; name: string }>;
  /**
   * Override responses for the IP poll GET /servers/:id calls during createVM.
   * If a function, called on each poll attempt (for simulating delayed IP allocation).
   */
  pollServer?: Record<string, unknown> | (() => Record<string, unknown>);
}) {
  const defaultImages = overrides?.images ?? [
    { id: 'img-uuid-1234', name: 'ubuntu_noble' },
  ];

  // Track whether we're in a createVM flow (after POST /servers, before result)
  let createVmInProgress = false;

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const urlStr = url.toString();

    // GET /images → resolveImageId
    if (method === 'GET' && urlStr.includes('/images')) {
      return Promise.resolve(
        new Response(JSON.stringify({ images: defaultImages }), { status: 200 }),
      );
    }

    // POST /servers/:id/action → performAction (poweron, poweroff, terminate)
    if (method === 'POST' && urlStr.includes('/action')) {
      return Promise.resolve(
        new Response(JSON.stringify({ task: { id: 'task-1', status: 'pending' } }), { status: 202 }),
      );
    }

    // PATCH /servers/:id/user_data/cloud-init → set cloud-init
    if (method === 'PATCH' && urlStr.includes('/user_data/cloud-init')) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    // POST /servers → createVM
    if (method === 'POST' && urlStr.match(/\/servers$/)) {
      createVmInProgress = true;
      const server = overrides?.createServer ?? createMockScalewayServer({
        id: 'new-server-uuid',
        name: 'contract-test',
        state: 'stopped',
        public_ip: null,
        public_ips: [],
        commercial_type: 'DEV1-M',
        creation_date: '2024-01-01T00:00:00Z',
      });
      return Promise.resolve(
        new Response(JSON.stringify({ server }), { status: 201 }),
      );
    }

    // DELETE /servers/:id → deleteVM
    if (method === 'DELETE' && urlStr.includes('/servers/')) {
      if (urlStr.includes('non-existent')) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    // GET /servers/:id → getVM or IP poll (single server, not list)
    if (method === 'GET' && urlStr.match(/\/servers\/[^/?]+$/) && !urlStr.includes('?')) {
      if (urlStr.includes('non-existent')) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
        );
      }

      // During createVM flow, use pollServer override if provided
      if (createVmInProgress && overrides?.pollServer) {
        const server = typeof overrides.pollServer === 'function'
          ? overrides.pollServer()
          : overrides.pollServer;
        return Promise.resolve(
          new Response(JSON.stringify({ server }), { status: 200 }),
        );
      }

      const server = overrides?.getServer ?? createMockScalewayServer();
      return Promise.resolve(
        new Response(JSON.stringify({ server }), { status: 200 }),
      );
    }

    // GET /servers → listVMs
    if (method === 'GET' && (urlStr.match(/\/servers$/) || urlStr.includes('/servers?'))) {
      const servers = overrides?.listServers ?? [];
      return Promise.resolve(
        new Response(JSON.stringify({ servers }), { status: 200 }),
      );
    }

    // GET /projects → validateToken
    if (method === 'GET' && urlStr.includes('/projects')) {
      return Promise.resolve(
        new Response(JSON.stringify({ projects: [] }), { status: 200 }),
      );
    }

    // Default: 404
    return Promise.resolve(
      new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
    );
  });
}
