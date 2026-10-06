import { afterEach, describe, expect, it, vi } from 'vitest';

import { DigitalOceanProvider } from '../../src/digitalocean';
import {
  DIGITALOCEAN_VOLUME_CAPABILITIES,
  DIGITALOCEAN_VOLUME_MAX_SIZE_GB,
  sanitizeDigitalOceanVolumeName,
} from '../../src/digitalocean-volumes';
import {
  createDigitalOceanFetchMock,
  createMockDigitalOceanVolume,
} from '../fixtures/digitalocean-mocks';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
function provider(mock: ReturnType<typeof vi.fn>, timeout = 100) {
  globalThis.fetch = mock;
  return new DigitalOceanProvider('token', {
    actionPollTimeoutMs: timeout,
    actionPollIntervalMs: 1,
    ipPollIntervalMs: 1,
  });
}
function findCall(mock: ReturnType<typeof vi.fn>, method: string, matcher: RegExp) {
  return mock.mock.calls.find(
    ([url, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method &&
      matcher.test(String(url))
  );
}

describe('DigitalOcean block storage', () => {
  it('sanitizes the provider name and round-trips the exact SAM name via tags', async () => {
    const exactName = `SAM-${'A'.repeat(70)}`;
    const mock = createDigitalOceanFetchMock({
      createVolume: createMockDigitalOceanVolume({
        name: sanitizeDigitalOceanVolumeName(exactName),
        tags: [`sam-name:${exactName}`, 'env:prod'],
      }),
    });
    const volume = await provider(mock).createVolume({
      name: exactName,
      sizeGb: 40,
      location: 'fra1',
      labels: { env: 'prod' },
    });
    const body = JSON.parse(findCall(mock, 'POST', /\/v2\/volumes$/)?.[1].body as string);
    expect(body.name).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    expect(body.name).toHaveLength(64);
    expect(body.tags).toEqual([`sam-name:${exactName}`, 'env:prod']);
    expect(volume.name).toBe(exactName);
  });
  it.each([
    [0, />= 1GB/],
    [1.5, /integer/],
    [DIGITALOCEAN_VOLUME_MAX_SIZE_GB + 1, /<=/],
  ])('rejects invalid size %s', async (size, pattern) => {
    await expect(
      provider(createDigitalOceanFetchMock()).createVolume({
        name: 'data',
        sizeGb: size as number,
        location: 'fra1',
      })
    ).rejects.toThrow(pattern as RegExp);
  });
  it('attaches with integer droplet id, polls the action, and returns deterministic linuxDevice', async () => {
    const mock = createDigitalOceanFetchMock({
      actionStatuses: ['in-progress', 'completed'],
      getVolume: createMockDigitalOceanVolume({ droplet_ids: [123] }),
    });
    const volume = await provider(mock).attachVolume({
      volumeId: 'do-volume-1',
      serverId: '123',
      location: 'fra1',
    });
    const body = JSON.parse(
      findCall(mock, 'POST', /\/volumes\/do-volume-1\/actions$/)?.[1].body as string
    );
    expect(body).toEqual({ type: 'attach', droplet_id: 123, region: 'fra1' });
    expect(findCall(mock, 'GET', /\/v2\/actions\/77$/)).toBeDefined();
    expect(volume).toMatchObject({
      attachedServerId: '123',
      status: 'attached',
      linuxDevice: '/dev/disk/by-id/scsi-0DO_Volume_sam-env-data',
    });
  });
  it('rejects invalid string droplet ids before calling DO', async () => {
    const mock = createDigitalOceanFetchMock();
    await expect(
      provider(mock).attachVolume({ volumeId: 'v', serverId: 'not-an-int', location: 'fra1' })
    ).rejects.toThrow(/Invalid DigitalOcean droplet id/);
    expect(findCall(mock, 'POST', /\/actions$/)).toBeUndefined();
  });
  it('detaches from the authoritative attached droplet and returns null when missing', async () => {
    const mock = createDigitalOceanFetchMock({
      getVolume: createMockDigitalOceanVolume({ droplet_ids: [456] }),
    });
    await provider(mock).detachVolume({
      volumeId: 'do-volume-1',
      serverId: '123',
      location: 'fra1',
    });
    const body = JSON.parse(findCall(mock, 'POST', /\/actions$/)?.[1].body as string);
    expect(body).toEqual({ type: 'detach', droplet_id: 456, region: 'fra1' });
    await expect(
      provider(createDigitalOceanFetchMock()).detachVolume({
        volumeId: 'missing',
        serverId: '123',
        location: 'fra1',
      })
    ).resolves.toBeNull();
  });
  it('grows via async resize and rejects shrink before action POST', async () => {
    const mock = createDigitalOceanFetchMock({
      getVolume: createMockDigitalOceanVolume({ size_gigabytes: 80 }),
    });
    const volume = await provider(mock).resizeVolume({
      volumeId: 'do-volume-1',
      location: 'fra1',
      sizeGb: 80,
      currentSizeGb: 40,
    });
    expect(JSON.parse(findCall(mock, 'POST', /\/actions$/)?.[1].body as string)).toEqual({
      type: 'resize',
      size_gigabytes: 80,
      region: 'fra1',
    });
    expect(volume.sizeGb).toBe(80);
    const shrinkMock = createDigitalOceanFetchMock();
    await expect(
      provider(shrinkMock).resizeVolume({
        volumeId: 'v',
        location: 'fra1',
        sizeGb: 20,
        currentSizeGb: 40,
      })
    ).rejects.toThrow(/Cannot shrink/);
    expect(findCall(shrinkMock, 'POST', /\/actions$/)).toBeUndefined();
  });
  it('surfaces errored and timed-out async actions', async () => {
    await expect(
      provider(createDigitalOceanFetchMock({ actionStatuses: ['errored'] })).attachVolume({
        volumeId: 'v',
        serverId: '123',
        location: 'fra1',
      })
    ).rejects.toThrow(/errored/);
    await expect(
      provider(createDigitalOceanFetchMock({ actionStatuses: ['in-progress'] }), 8).attachVolume({
        volumeId: 'v',
        serverId: '123',
        location: 'fra1',
      })
    ).rejects.toThrow(/did not complete within/);
  });
  it('lists all pages with region and label filtering; get/delete are 404-idempotent', async () => {
    const mock = createDigitalOceanFetchMock({
      volumePages: [
        {
          items: [createMockDigitalOceanVolume({ id: 'a', tags: ['sam-name:a', 'env:prod'] })],
          hasNext: true,
        },
        {
          items: [createMockDigitalOceanVolume({ id: 'b', tags: ['sam-name:b', 'env:dev'] })],
          hasNext: false,
        },
      ],
    });
    const volumes = await provider(mock).listVolumes({ location: 'fra1', labels: { env: 'prod' } });
    expect(volumes.map((volume) => volume.id)).toEqual(['a']);
    expect(mock.mock.calls.filter(([url]) => String(url).includes('/v2/volumes?'))).toHaveLength(2);
    expect(
      String(mock.mock.calls.find(([url]) => String(url).includes('/v2/volumes?'))?.[0])
    ).toContain('region=fra1');
    const missing = provider(createDigitalOceanFetchMock());
    await expect(missing.getVolume({ volumeId: 'missing', location: 'fra1' })).resolves.toBeNull();
    await expect(
      missing.deleteVolume({ volumeId: 'missing', location: 'fra1' })
    ).resolves.toBeUndefined();
  });
  it('handles missing post-attach volumes, already-detached volumes, and resize lookup misses', async () => {
    await expect(
      provider(createDigitalOceanFetchMock()).attachVolume({
        volumeId: 'missing',
        serverId: '123',
        location: 'fra1',
      })
    ).rejects.toThrow(/not found after attach/);
    const detachedMock = createDigitalOceanFetchMock({
      getVolume: createMockDigitalOceanVolume({ droplet_ids: [] }),
    });
    const detached = await provider(detachedMock).detachVolume({
      volumeId: 'do-volume-1',
      location: 'fra1',
    });
    expect(detached?.status).toBe('available');
    expect(findCall(detachedMock, 'POST', /\/actions$/)).toBeUndefined();
    await expect(
      provider(createDigitalOceanFetchMock()).resizeVolume({
        volumeId: 'missing',
        location: 'fra1',
        sizeGb: 40,
      })
    ).rejects.toThrow(/not found/);
  });
});

describe('DigitalOcean volume capabilities', () => {
  it('advertises real, grow-only, same-region storage and deterministic path behavior', () => {
    expect(DIGITALOCEAN_VOLUME_CAPABILITIES).toMatchObject({
      supported: true,
      minSizeGb: 1,
      maxSizeGb: 16384,
      growOnlyResize: true,
      requiresSameLocation: true,
    });
    expect(DIGITALOCEAN_VOLUME_CAPABILITIES.notes?.join(' ')).toMatch(/scsi-0DO_Volume/);
  });
});
