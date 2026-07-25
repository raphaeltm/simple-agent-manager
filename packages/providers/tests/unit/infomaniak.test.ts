import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyInfomaniakError,
  InfomaniakProvider,
  mapInfomaniakStatus,
} from '../../src/infomaniak';
import { ProviderError } from '../../src/types';

const AUTH_URL = 'https://identity.test/v3';
const COMPUTE = 'https://compute.test/v2.1/project';
const VOLUME = 'https://volume.test/v3/project';
const IMAGE = 'https://image.test';
const NETWORK = 'https://network.test';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function auth(
  catalog = [
    { type: 'compute', endpoints: [{ region: 'dc4-a', interface: 'public', url: COMPUTE }] },
    { type: 'volumev3', endpoints: [{ region: 'dc4-a', interface: 'public', url: VOLUME }] },
    { type: 'image', endpoints: [{ region: 'dc4-a', interface: 'public', url: IMAGE }] },
    { type: 'network', endpoints: [{ region: 'dc4-a', interface: 'public', url: NETWORK }] },
  ]
): Response {
  return json({ token: { project: { id: 'project' }, catalog } }, 201, {
    'x-subject-token': 'subject-token',
  });
}
function volume(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vol-1',
    name: 'data',
    size: 20,
    status: 'available',
    attachments: [],
    volume_type: 'CEPH_1_perf1',
    created_at: '2026-07-25T00:00:00Z',
    metadata: { env: 'e1' },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('InfomaniakProvider', () => {
  it('authenticates with explicit Keystone application credentials and validates the full catalog', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth());
    const provider = new InfomaniakProvider('credential-id', 'one-time-secret', {
      authUrl: AUTH_URL,
    });
    await expect(provider.validateToken()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_URL}/auth/tokens`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          auth: {
            identity: {
              methods: ['application_credential'],
              application_credential: { id: 'credential-id', secret: 'one-time-secret' },
            },
          },
        }),
      })
    );
  });

  it('rejects malformed Keystone catalogs at runtime', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth([]));
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(provider.validateToken()).rejects.toThrow('catalog is missing compute');
  });

  it('creates a Cinder volume with exact region/type/metadata payload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(json({ volume: volume({ status: 'creating' }) }, 202));
    const provider = new InfomaniakProvider('id', 'secret', {
      authUrl: AUTH_URL,
      volumeType: 'CEPH_1_perf1',
    });
    const result = await provider.createVolume({
      name: 'data',
      sizeGb: 20,
      location: 'dc4-a',
      labels: { env: 'e1' },
    });
    expect(result).toMatchObject({
      id: 'vol-1',
      sizeGb: 20,
      status: 'creating',
      location: 'dc4-a',
      labels: { env: 'e1' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${VOLUME}/volumes`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Auth-Token': 'subject-token' }),
        body: JSON.stringify({
          volume: { name: 'data', size: 20, volume_type: 'CEPH_1_perf1', metadata: { env: 'e1' } },
        }),
      })
    );
  });

  it('refuses attached-volume deletion without issuing DELETE', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({ volume: volume({ status: 'in-use', attachments: [{ server_id: 'server-1' }] }) })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(
      provider.deleteVolume({ volumeId: 'vol-1', location: 'dc4-a' })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires detach before grow-only resize', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(
        json({ volume: volume({ status: 'in-use', attachments: [{ server_id: 'server-1' }] }) })
      );
    const provider = new InfomaniakProvider('id', 'secret', { authUrl: AUTH_URL });
    await expect(
      provider.resizeVolume({ volumeId: 'vol-1', location: 'dc4-a', sizeGb: 30 })
    ).rejects.toThrow('Detach');
  });

  it('normalizes status and errors', () => {
    expect(mapInfomaniakStatus('ACTIVE')).toBe('running');
    expect(mapInfomaniakStatus('SHUTOFF')).toBe('off');
    expect(classifyInfomaniakError(401, '')).toBe('auth_error');
    expect(classifyInfomaniakError(409, 'Quota exceeded')).toBe('quota_exceeded');
    expect(classifyInfomaniakError(503, 'No valid host')).toBe('transient_capacity');
    expect(new ProviderError('infomaniak', 400, 'bad').providerName).toBe('infomaniak');
  });
});
