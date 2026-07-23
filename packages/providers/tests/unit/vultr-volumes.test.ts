import { afterEach, describe, expect, it, vi } from 'vitest';

import { VultrProvider } from '../../src/vultr';
import { VULTR_VOLUME_CAPABILITIES, VULTR_VOLUME_MAX_SIZE_GB } from '../../src/vultr-volumes';
import { createMockVultrBlock, createVultrFetchMock } from '../fixtures/vultr-mocks';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function findCall(mock: ReturnType<typeof vi.fn>, method: string, matcher: RegExp) {
  return mock.mock.calls.find(([url, init]) => {
    const m = ((init as RequestInit | undefined)?.method || 'GET').toUpperCase();
    return m === method && matcher.test(String(url));
  }) as [string, RequestInit] | undefined;
}

function newProvider(fetchMock: ReturnType<typeof vi.fn>) {
  globalThis.fetch = fetchMock;
  return new VultrProvider('test-token');
}

describe('VultrProvider volumes — createVolume', () => {
  it('sends the correct create payload and encodes labels + name into the single Vultr label', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);

    await provider.createVolume({
      name: 'sam-env-data',
      sizeGb: 40,
      location: 'fra',
      labels: { 'sam-environment': 'env-1', 'sam-volume-name': 'data' },
    });

    const body = JSON.parse(findCall(fetchMock, 'POST', /\/v2\/blocks$/)![1].body as string);
    expect(body.region).toBe('fra');
    expect(body.size_gb).toBe(40);
    expect(body.block_type).toBe('high_perf');
    expect(body.label).toBe('sam-name=sam-env-data;sam-environment=env-1;sam-volume-name=data');
  });

  it('round-trips name + labels back through getVolume', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);
    const volume = await provider.getVolume({ volumeId: 'vultr-block-1', location: 'fra' });
    expect(volume?.name).toBe('sam-env-data');
    expect(volume?.labels).toEqual({ 'sam-environment': 'env-1', 'sam-volume-name': 'data' });
    expect(volume?.sizeGb).toBe(40);
    expect(volume?.location).toBe('fra');
    expect(volume?.status).toBe('available');
  });

  it.each([
    [5, />= 10GB/],
    [40.5, /integer/],
    [VULTR_VOLUME_MAX_SIZE_GB + 1, /<=/],
  ])('rejects invalid size %s', async (size, pattern) => {
    const provider = newProvider(createVultrFetchMock());
    await expect(
      provider.createVolume({ name: 'v', sizeGb: size as number, location: 'fra' }),
    ).rejects.toThrow(pattern as RegExp);
  });
});

describe('VultrProvider volumes — attach/detach', () => {
  it('attachVolume posts instance_id + live and returns the attached volume', async () => {
    const fetchMock = createVultrFetchMock({
      getBlock: createMockVultrBlock({ id: 'b-1', attached_to_instance: 'i-5', mount_id: 'ewr-xyz', label: 'sam-name=vol' }),
    });
    const provider = newProvider(fetchMock);

    const volume = await provider.attachVolume({ volumeId: 'b-1', serverId: 'i-5', location: 'fra' });
    const body = JSON.parse(findCall(fetchMock, 'POST', /\/v2\/blocks\/b-1\/attach$/)![1].body as string);
    expect(body).toEqual({ instance_id: 'i-5', live: true });
    expect(volume.attachedServerId).toBe('i-5');
    expect(volume.linuxDevice).toBe('/dev/disk/by-id/virtio-ewr-xyz');
    expect(volume.status).toBe('attached');
  });

  it('detachVolume posts live:true then re-reads the volume', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);
    const volume = await provider.detachVolume({ volumeId: 'vultr-block-1', serverId: 'i-5', location: 'fra' });
    const body = JSON.parse(findCall(fetchMock, 'POST', /\/v2\/blocks\/vultr-block-1\/detach$/)![1].body as string);
    expect(body).toEqual({ live: true });
    expect(volume?.id).toBe('vultr-block-1');
  });

  it('detachVolume returns null when the block is already gone (404)', async () => {
    const provider = newProvider(createVultrFetchMock());
    const result = await provider.detachVolume({ volumeId: 'non-existent', serverId: 'i-5', location: 'fra' });
    expect(result).toBeNull();
  });
});

describe('VultrProvider volumes — resize/delete/list', () => {
  it('resizeVolume rejects a shrink before any API call', async () => {
    const provider = newProvider(createVultrFetchMock());
    await expect(
      provider.resizeVolume({ volumeId: 'b-1', location: 'fra', sizeGb: 20, currentSizeGb: 40 }),
    ).rejects.toThrow(/Cannot shrink/);
  });

  it('resizeVolume grows via PATCH size_gb', async () => {
    const fetchMock = createVultrFetchMock({
      getBlock: createMockVultrBlock({ id: 'b-1', size_gb: 80, label: 'sam-name=vol' }),
    });
    const provider = newProvider(fetchMock);
    const volume = await provider.resizeVolume({ volumeId: 'b-1', location: 'fra', sizeGb: 80, currentSizeGb: 40 });
    const body = JSON.parse(findCall(fetchMock, 'PATCH', /\/v2\/blocks\/b-1$/)![1].body as string);
    expect(body).toEqual({ size_gb: 80 });
    expect(volume.sizeGb).toBe(80);
  });

  it('deleteVolume is idempotent on 404', async () => {
    const provider = newProvider(createVultrFetchMock());
    await expect(provider.deleteVolume({ volumeId: 'non-existent', location: 'fra' })).resolves.toBeUndefined();
  });

  it('getVolume returns null on 404', async () => {
    const provider = newProvider(createVultrFetchMock());
    expect(await provider.getVolume({ volumeId: 'non-existent', location: 'fra' })).toBeNull();
  });

  it('listVolumes filters by location and labels', async () => {
    const fetchMock = createVultrFetchMock({
      listBlocks: [
        createMockVultrBlock({ id: 'a', region: 'fra', label: 'sam-name=a;env=prod' }),
        createMockVultrBlock({ id: 'b', region: 'ewr', label: 'sam-name=b;env=prod' }),
        createMockVultrBlock({ id: 'c', region: 'fra', label: 'sam-name=c;env=dev' }),
      ],
    });
    const provider = newProvider(fetchMock);
    const fra = await provider.listVolumes({ location: 'fra' });
    expect(fra.map((v) => v.id)).toEqual(['a', 'c']);
    const prod = await provider.listVolumes({ location: 'fra', labels: { env: 'prod' } });
    expect(prod.map((v) => v.id)).toEqual(['a']);
  });
});

describe('VULTR_VOLUME_CAPABILITIES', () => {
  it('advertises real block-storage support with region + single-label caveats', () => {
    expect(VULTR_VOLUME_CAPABILITIES.supported).toBe(true);
    expect(VULTR_VOLUME_CAPABILITIES.growOnlyResize).toBe(true);
    expect(VULTR_VOLUME_CAPABILITIES.requiresSameLocation).toBe(true);
    expect(VULTR_VOLUME_CAPABILITIES.minSizeGb).toBe(10);
    expect(VULTR_VOLUME_CAPABILITIES.notes?.some((n) => /region/i.test(n))).toBe(true);
    expect(VULTR_VOLUME_CAPABILITIES.notes?.some((n) => /label/i.test(n))).toBe(true);
  });
});
