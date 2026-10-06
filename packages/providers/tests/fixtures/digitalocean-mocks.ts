import { vi } from 'vitest';

export function createMockDigitalOceanDroplet(overrides: Record<string, unknown> = {}) {
  return { id: 12345, name: 'sam-node', status: 'active', size_slug: 's-2vcpu-4gb', created_at: '2026-01-01T00:00:00Z', networks: { v4: [{ ip_address: '192.0.2.10', type: 'public' }] }, tags: ['sam-project:project-1'], ...overrides };
}

export function createMockDigitalOceanVolume(overrides: Record<string, unknown> = {}) {
  return { id: 'do-volume-1', name: 'sam-env-data', size_gigabytes: 40, region: { slug: 'fra1' }, droplet_ids: [], created_at: '2026-01-01T00:00:00Z', tags: ['sam-name:sam-env-data', 'sam-environment:env-1', 'sam-volume-name:data'], ...overrides };
}

function json(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status })); }
function empty() { return Promise.resolve(new Response(null, { status: 204 })); }
function notFound() { return json({ id: 'not_found', message: 'Not found', request_id: 'req-test' }, 404); }

export interface DigitalOceanMockPage<T = Record<string, unknown>> { items: T[]; hasNext: boolean }
function pageFor<T>(pages: DigitalOceanMockPage<T>[], url: string) {
  const page = Number(new URL(url).searchParams.get('page') ?? '1');
  return pages[page - 1] ?? { items: [], hasNext: false };
}
function listBody(key: 'droplets' | 'volumes', page: DigitalOceanMockPage) {
  return { [key]: page.items, links: page.hasNext ? { pages: { next: `https://api.digitalocean.com/v2/${key}?page=2` } } : {} };
}

export function createDigitalOceanFetchMock(overrides?: {
  createDroplet?: Record<string, unknown>; getDroplet?: Record<string, unknown>; dropletPages?: DigitalOceanMockPage[];
  createVolume?: Record<string, unknown>; getVolume?: Record<string, unknown>; volumePages?: DigitalOceanMockPage[]; actionStatuses?: string[];
}) {
  let actionRead = 0;
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = String(url);
    if (method === 'GET' && u.endsWith('/v2/account')) return json({ account: { status: 'active' } });
    if (method === 'POST' && /\/v2\/droplets$/.test(u)) return json({ droplet: overrides?.createDroplet ?? createMockDigitalOceanDroplet({ status: 'new', networks: { v4: [] } }) }, 202);
    if (method === 'POST' && /\/v2\/droplets\/[^/]+\/actions$/.test(u)) return json({ action: { id: 99, status: 'in-progress', type: 'power_on' } }, 201);
    if (method === 'DELETE' && /\/v2\/droplets\/[^/]+$/.test(u)) return u.includes('missing') || u.includes('non-existent') ? notFound() : empty();
    if (method === 'GET' && /\/v2\/droplets\/[^/?]+$/.test(u)) return u.includes('missing') || u.includes('non-existent') ? notFound() : json({ droplet: overrides?.getDroplet ?? createMockDigitalOceanDroplet() });
    if (method === 'GET' && /\/v2\/droplets\?/.test(u)) { const page = pageFor(overrides?.dropletPages ?? [{ items: [], hasNext: false }], u); return json(listBody('droplets', page)); }
    if (method === 'POST' && /\/v2\/volumes$/.test(u)) return json({ volume: overrides?.createVolume ?? createMockDigitalOceanVolume() }, 201);
    if (method === 'POST' && /\/v2\/volumes\/[^/]+\/actions$/.test(u)) return json({ action: { id: 77, status: overrides?.actionStatuses?.[0] ?? 'completed', type: 'attach' } }, 202);
    if (method === 'GET' && /\/v2\/actions\/\d+$/.test(u)) { actionRead += 1; const statuses = overrides?.actionStatuses ?? ['completed']; return json({ action: { id: 77, status: statuses[Math.min(actionRead, statuses.length - 1)], type: 'attach' } }); }
    if (method === 'DELETE' && /\/v2\/volumes\/[^/]+$/.test(u)) return u.includes('missing') || u.includes('non-existent') ? notFound() : empty();
    if (method === 'GET' && /\/v2\/volumes\/[^/?]+$/.test(u)) return u.includes('missing') || u.includes('non-existent') ? notFound() : json({ volume: overrides?.getVolume ?? createMockDigitalOceanVolume() });
    if (method === 'GET' && /\/v2\/volumes\?/.test(u)) { const page = pageFor(overrides?.volumePages ?? [{ items: [], hasNext: false }], u); return json(listBody('volumes', page)); }
    return notFound();
  });
}
