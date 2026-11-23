import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../../src';
import { UpCloudProvider } from '../../src/upcloud';

const originalFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const storage = (overrides = {}) => ({
  uuid: 'vol-1',
  title: 'data',
  size: 20,
  state: 'online',
  zone: 'de-fra1',
  tier: 'maxiops',
  type: 'normal',
  created: '2026-07-25T00:00:00Z',
  labels: [{ key: 'managed-by', value: 'sam' }],
  servers: { server: [] },
  ...overrides,
});
const server = (overrides = {}) => ({
  uuid: 'srv-1',
  title: 'node',
  hostname: 'node',
  state: 'started',
  zone: 'de-fra1',
  plan: '2xCPU-4GB',
  created: '2026-07-25T00:00:00Z',
  labels: { label: [{ key: 'managed-by', value: 'sam' }] },
  ip_addresses: { ip_address: [] },
  storage_devices: { storage_device: [] },
  ...overrides,
});

function useFetch(handler: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) =>
    handler(String(input), init)
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('UpCloud lifecycle edge cases', () => {
  it('rejects a cross-zone attach before issuing the attach request', async () => {
    const fetchMock = useFetch((url) =>
      url.endsWith('/storage/vol-1')
        ? json({ storage: storage() })
        : json({ server: server({ zone: 'fi-hel1' }) })
    );
    await expect(
      new UpCloudProvider('u', 'p').attachVolume({
        volumeId: 'vol-1',
        serverId: 'srv-1',
        location: 'de-fra1',
      })
    ).rejects.toMatchObject({ category: 'invalid_config' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/storage/attach'))).toBe(
      false
    );
  });

  it('treats missing volumes and repeated deletion as idempotent', async () => {
    const fetchMock = useFetch(() =>
      json({ error: { error_code: 'STORAGE_NOT_FOUND', error_message: 'not found' } }, 404)
    );
    const provider = new UpCloudProvider('u', 'p');
    await expect(
      provider.deleteVolume({ volumeId: 'missing', location: 'de-fra1' })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unavailable plan before server creation', async () => {
    const fetchMock = useFetch((url) =>
      url.endsWith('/zone')
        ? json({ zones: { zone: [{ id: 'de-fra1' }] } })
        : json({ plans: { plan: [{ name: '1xCPU-1GB' }] } })
    );
    await expect(
      new UpCloudProvider('u', 'p').createVM({
        name: 'node',
        size: 'small',
        location: 'de-fra1',
        userData: '#cloud-config',
        labels: {},
      })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/server'))).toBe(false);
  });

  it('filters listed servers by every requested SAM label', async () => {
    useFetch(() =>
      json({
        servers: {
          server: [
            server({
              uuid: 'match',
              labels: {
                label: [
                  { key: 'managed-by', value: 'sam' },
                  { key: 'project', value: 'p1' },
                  { key: 'installation', value: '0123456789abcdef0123456789abcdef' },
                ],
              },
            }),
            server({
              uuid: 'other',
              labels: {
                label: [
                  { key: 'managed-by', value: 'sam' },
                  { key: 'project', value: 'p2' },
                ],
              },
            }),
          ],
        },
      })
    );
    await expect(
      new UpCloudProvider('u', 'p').listVMs({
        'managed-by': 'sam',
        project: 'p1',
        installation: '0123456789abcdef0123456789abcdef',
      })
    ).resolves.toEqual([expect.objectContaining({ id: 'match' })]);
  });

  it('does not match a server with duplicate installation labels', async () => {
    useFetch(() =>
      json({
        servers: {
          server: [
            server({
              uuid: 'ambiguous',
              labels: {
                label: [
                  { key: 'managed', value: 'simple-agent-manager' },
                  { key: 'env', value: 'production' },
                  { key: 'installation', value: 'foreign' },
                  { key: 'installation', value: '0123456789abcdef0123456789abcdef' },
                ],
              },
            }),
          ],
        },
      })
    );
    await expect(
      new UpCloudProvider('u', 'p').listVMs({
        managed: 'simple-agent-manager',
        env: 'production',
        installation: '0123456789abcdef0123456789abcdef',
      })
    ).resolves.toEqual([]);
  });
});

describe('UpCloud server listing pages', () => {
  const page = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => server({ uuid: `srv-${offset + i}` }));

  it('reads every page with limit and offset', async () => {
    const urls: string[] = [];
    useFetch((url) => {
      urls.push(String(url));
      const offset = Number(new URL(String(url)).searchParams.get('offset'));
      return json({ servers: { server: offset < 200 ? page(offset, 100) : page(offset, 7) } });
    });
    const vms = await new UpCloudProvider('u', 'p').listVMs();
    expect(vms).toHaveLength(207);
    expect(urls.map((u) => new URL(u).search)).toEqual([
      '?limit=100&offset=0',
      '?limit=100&offset=100',
      '?limit=100&offset=200',
    ]);
  });

  it('stops when a page adds no new server (parameters ignored)', async () => {
    let calls = 0;
    useFetch(() => {
      calls += 1;
      return json({ servers: { server: page(0, 150) } });
    });
    expect(await new UpCloudProvider('u', 'p').listVMs()).toHaveLength(150);
    expect(calls).toBe(2);
  });

  it('with requireComplete throws at the page limit instead of returning a partial list', async () => {
    useFetch((url) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset'));
      return json({ servers: { server: page(offset, 100) } });
    });
    await expect(
      new UpCloudProvider('u', 'p').listVMs(undefined, undefined, { requireComplete: true })
    ).rejects.toThrow(/incomplete/);
  });

  it('with requireComplete throws when a server is deleted between pages', async () => {
    let all = page(0, 150);
    let served = 0;
    useFetch((url) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset'));
      const body = json({ servers: { server: all.slice(offset, offset + 100) } });
      served += 1;
      // A deletion lands after the first page of the first pass.
      if (served === 1) all = all.filter((s) => s.uuid !== 'srv-5');
      return body;
    });
    await expect(
      new UpCloudProvider('u', 'p').listVMs(undefined, undefined, { requireComplete: true })
    ).rejects.toThrow(/changed while paging/);
  });

  it('with requireComplete throws when offset is ignored (a full page repeats)', async () => {
    useFetch(() => json({ servers: { server: page(0, 100) } }));
    await expect(
      new UpCloudProvider('u', 'p').listVMs(undefined, undefined, { requireComplete: true })
    ).rejects.toThrow(/repeated page/);
  });

  it('with requireComplete returns a stable multi-page list', async () => {
    useFetch((url) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset'));
      return json({ servers: { server: page(0, 150).slice(offset, offset + 100) } });
    });
    expect(
      await new UpCloudProvider('u', 'p').listVMs(undefined, undefined, { requireComplete: true })
    ).toHaveLength(150);
  });
});
