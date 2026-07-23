import { vi } from 'vitest';

/** Factory for a mock Vultr instance payload. */
export function createMockVultrInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vultr-instance-1',
    main_ip: '192.0.2.10',
    status: 'active',
    power_status: 'running',
    server_status: 'ok',
    region: 'fra',
    plan: 'vc2-2c-4gb',
    date_created: '2026-01-01T00:00:00Z',
    label: 'contract-test',
    tags: [],
    ...overrides,
  };
}

/** Factory for a mock Vultr block-storage payload. */
export function createMockVultrBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vultr-block-1',
    region: 'fra',
    size_gb: 40,
    label: 'sam-name=sam-env-data;sam-environment=env-1;sam-volume-name=data',
    block_type: 'high_perf',
    status: 'active',
    attached_to_instance: '',
    mount_id: '',
    date_created: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function noContent(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 204 }));
}

function notFound(): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ error: 'Not found', status: 404 }), { status: 404 }));
}

/**
 * Create a mock fetch routing to the appropriate Vultr API v2 response.
 * Covers every Provider interface method plus os/account/blocks endpoints.
 */
export function createVultrFetchMock(overrides?: {
  createInstance?: Record<string, unknown>;
  getInstance?: Record<string, unknown>;
  listInstances?: Record<string, unknown>[];
  os?: Array<{ id: number; name: string; arch: string; family: string }>;
  createBlock?: Record<string, unknown>;
  getBlock?: Record<string, unknown>;
  listBlocks?: Record<string, unknown>[];
}) {
  const os = overrides?.os ?? [
    { id: 1743, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' },
    { id: 387, name: 'Debian 12 x64', arch: 'x64', family: 'debian' },
  ];

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const u = url.toString();

    // GET /os
    if (method === 'GET' && u.includes('/v2/os')) {
      return jsonResponse({ os, meta: { total: os.length, links: { next: '', prev: '' } } });
    }
    // GET /account → validateToken
    if (method === 'GET' && u.includes('/v2/account')) {
      return jsonResponse({ account: { name: 'test', email: 't@example.com', acls: [] } });
    }
    // POST instance actions (halt / start / reboot)
    if (method === 'POST' && /\/v2\/instances\/[^/]+\/(halt|start|reboot)$/.test(u)) {
      return noContent();
    }
    // POST /blocks/:id/attach|detach
    if (method === 'POST' && /\/v2\/blocks\/[^/]+\/(attach|detach)$/.test(u)) {
      return noContent();
    }
    // POST /instances → createVM
    if (method === 'POST' && /\/v2\/instances$/.test(u)) {
      const instance = overrides?.createInstance ?? createMockVultrInstance({
        main_ip: '0.0.0.0',
        status: 'pending',
        power_status: 'stopped',
        server_status: 'none',
      });
      return jsonResponse({ instance }, 202);
    }
    // POST /blocks → createVolume
    if (method === 'POST' && /\/v2\/blocks$/.test(u)) {
      const block = overrides?.createBlock ?? createMockVultrBlock();
      return jsonResponse({ block }, 202);
    }
    // PATCH /blocks/:id → resize (204)
    if (method === 'PATCH' && /\/v2\/blocks\/[^/]+$/.test(u)) {
      return noContent();
    }
    // DELETE /instances/:id
    if (method === 'DELETE' && u.includes('/v2/instances/')) {
      return u.includes('non-existent') ? notFound() : noContent();
    }
    // DELETE /blocks/:id
    if (method === 'DELETE' && u.includes('/v2/blocks/')) {
      return u.includes('non-existent') ? notFound() : noContent();
    }
    // GET /instances/:id (single) → getVM / IP poll
    if (method === 'GET' && /\/v2\/instances\/[^/?]+$/.test(u)) {
      if (u.includes('non-existent')) return notFound();
      return jsonResponse({ instance: overrides?.getInstance ?? createMockVultrInstance() });
    }
    // GET /instances (list)
    if (method === 'GET' && /\/v2\/instances(\?|$)/.test(u)) {
      const instances = overrides?.listInstances ?? [];
      return jsonResponse({ instances, meta: { total: instances.length, links: { next: '', prev: '' } } });
    }
    // GET /blocks/:id (single)
    if (method === 'GET' && /\/v2\/blocks\/[^/?]+$/.test(u)) {
      if (u.includes('non-existent')) return notFound();
      return jsonResponse({ block: overrides?.getBlock ?? createMockVultrBlock() });
    }
    // GET /blocks (list)
    if (method === 'GET' && /\/v2\/blocks(\?|$)/.test(u)) {
      const blocks = overrides?.listBlocks ?? [];
      return jsonResponse({ blocks, meta: { total: blocks.length, links: { next: '', prev: '' } } });
    }

    return notFound();
  });
}
