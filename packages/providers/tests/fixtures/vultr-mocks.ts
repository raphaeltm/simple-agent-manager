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
 * One page of a cursor-paginated Vultr list response.
 * `next` is the cursor the provider will send on the FOLLOWING request; an empty
 * string terminates pagination (mirrors Vultr's `meta.links.next`).
 */
export interface VultrMockPage<T = Record<string, unknown>> {
  items: T[];
  next: string;
}

/**
 * Resolve which page to serve for a cursor-paginated list request.
 *
 * The provider drives pagination by echoing `meta.links.next` back as the
 * `?cursor=` query param, so we map an incoming cursor to the page that FOLLOWS
 * the page whose `next` equals that cursor. No `?cursor=` → the first page. This
 * matches VultrVolumeClient.fetchAllBlocks / VultrProvider.fetchAllInstances /
 * fetchAllOs exactly, so it generalizes to N pages, not just two.
 */
function resolvePage<T>(pages: VultrMockPage<T>[], url: string): VultrMockPage<T> {
  const match = url.match(/[?&]cursor=([^&]+)/);
  if (!match) return pages[0] ?? { items: [], next: '' };
  const cursor = decodeURIComponent(match[1]!);
  const prevIdx = pages.findIndex((p) => p.next === cursor);
  return pages[prevIdx + 1] ?? { items: [], next: '' };
}

/**
 * Create a mock fetch routing to the appropriate Vultr API v2 response.
 * Covers every Provider interface method plus os/account/blocks endpoints.
 *
 * Multi-page cursor scenarios: pass `instancesPages` / `blocksPages` / `osPages`
 * (each an ordered `VultrMockPage[]`) to exercise the pagination loops. When a
 * `*Pages` override is present it takes precedence over the single-page
 * `listInstances` / `listBlocks` / `os` overrides for that resource; otherwise
 * the default single-page (empty `meta.links.next`) behavior is preserved so
 * existing callers are unaffected.
 */
export function createVultrFetchMock(overrides?: {
  createInstance?: Record<string, unknown>;
  getInstance?: Record<string, unknown>;
  listInstances?: Record<string, unknown>[];
  instancesPages?: VultrMockPage[];
  os?: Array<{ id: number; name: string; arch: string; family: string }>;
  osPages?: VultrMockPage<{ id: number; name: string; arch: string; family: string }>[];
  createBlock?: Record<string, unknown>;
  getBlock?: Record<string, unknown>;
  listBlocks?: Record<string, unknown>[];
  blocksPages?: VultrMockPage[];
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
      if (overrides?.osPages) {
        const page = resolvePage(overrides.osPages, u);
        return jsonResponse({ os: page.items, meta: { total: page.items.length, links: { next: page.next, prev: '' } } });
      }
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
    // POST /blocks/:id/attach|detach — 404 for a non-existent block, mirroring the
    // DELETE handlers so the detach-404 catch path in vultr-volumes.ts is exercised.
    if (method === 'POST' && /\/v2\/blocks\/[^/]+\/(attach|detach)$/.test(u)) {
      return u.includes('non-existent') ? notFound() : noContent();
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
      if (overrides?.instancesPages) {
        const page = resolvePage(overrides.instancesPages, u);
        return jsonResponse({ instances: page.items, meta: { total: page.items.length, links: { next: page.next, prev: '' } } });
      }
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
      if (overrides?.blocksPages) {
        const page = resolvePage(overrides.blocksPages, u);
        return jsonResponse({ blocks: page.items, meta: { total: page.items.length, links: { next: page.next, prev: '' } } });
      }
      const blocks = overrides?.listBlocks ?? [];
      return jsonResponse({ blocks, meta: { total: blocks.length, links: { next: '', prev: '' } } });
    }

    return notFound();
  });
}
