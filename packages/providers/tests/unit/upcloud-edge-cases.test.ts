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
      new UpCloudProvider('u', 'p').listVMs({ 'managed-by': 'sam', project: 'p1' })
    ).resolves.toEqual([expect.objectContaining({ id: 'match' })]);
  });
});
