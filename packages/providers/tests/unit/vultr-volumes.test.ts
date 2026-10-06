import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../../src/types';
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

  // M4: a POST /blocks HTTP failure surfaces as a mapped ProviderError (createVolume's
  // own try/catch wraps the vultrFetch error via mapProviderError).
  it('rejects with a mapped ProviderError when POST /blocks fails (500)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'kaboom', status: 500 }), { status: 500 }),
    );
    const provider = new VultrProvider('test-token');
    const err = await provider
      .createVolume({ name: 'v', sizeGb: 40, location: 'fra' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(500);
    expect(err.providerName).toBe('vultr');
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

  // H2 (discriminating): with the fixture now returning 404 for a non-existent block's
  // detach POST, the null MUST come from the detach-POST 404 catch — NOT a getVolume
  // re-fetch. Prove it by asserting the detach POST was issued and NO GET re-read followed.
  it('detachVolume returns null from the detach POST 404 without re-reading the block', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);

    const result = await provider.detachVolume({ volumeId: 'non-existent', serverId: 'i-5', location: 'fra' });
    expect(result).toBeNull();

    expect(findCall(fetchMock, 'POST', /\/v2\/blocks\/non-existent\/detach$/)).toBeDefined();
    // The discriminator: null from the detach 404 means no getVolume re-fetch happened.
    expect(findCall(fetchMock, 'GET', /\/v2\/blocks\/non-existent$/)).toBeUndefined();
  });

  it('detachVolume rethrows a non-404 error from the detach POST', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom', status: 500 }), { status: 500 }),
    );
    const provider = new VultrProvider('test-token');
    await expect(
      provider.detachVolume({ volumeId: 'b-1', serverId: 'i-5', location: 'fra' }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  // M4: attach POST succeeds but the post-attach getVolume 404s → "not found after attach".
  it('attachVolume throws "not found after attach" when the post-attach read 404s', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && /\/v2\/blocks\/[^/]+\/attach$/.test(u)) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      // The post-attach getVolume read 404s.
      if (method === 'GET' && /\/v2\/blocks\/[^/?]+$/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'gone', status: 404 }), { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'nf', status: 404 }), { status: 404 }));
    });
    globalThis.fetch = fetchMock;
    const provider = new VultrProvider('test-token');

    await expect(
      provider.attachVolume({ volumeId: 'b-1', serverId: 'i-5', location: 'fra' }),
    ).rejects.toThrow(/not found after attach/);
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

  // When currentSizeGb is omitted, resizeVolume reads the live size via getCurrentVolumeSize.
  // Proven discriminating: the fetched size (100) triggers the shrink guard for a 80GB target,
  // which is only reachable if getCurrentVolumeSize was actually consulted.
  it('resizeVolume without currentSizeGb reads the live size and rejects an implied shrink', async () => {
    const fetchMock = createVultrFetchMock({
      getBlock: createMockVultrBlock({ id: 'b-1', size_gb: 100, label: 'sam-name=vol' }),
    });
    const provider = newProvider(fetchMock);
    await expect(
      provider.resizeVolume({ volumeId: 'b-1', location: 'fra', sizeGb: 80 }),
    ).rejects.toThrow(/Cannot shrink/);
  });

  it('resizeVolume without currentSizeGb grows using the fetched current size', async () => {
    const fetchMock = createVultrFetchMock({
      getBlock: createMockVultrBlock({ id: 'b-1', size_gb: 40, label: 'sam-name=vol' }),
    });
    const provider = newProvider(fetchMock);
    const volume = await provider.resizeVolume({ volumeId: 'b-1', location: 'fra', sizeGb: 80 });
    const body = JSON.parse(findCall(fetchMock, 'PATCH', /\/v2\/blocks\/b-1$/)![1].body as string);
    expect(body).toEqual({ size_gb: 80 });
    expect(volume).toBeDefined();
  });

  it('resizeVolume without currentSizeGb throws when the block is not found', async () => {
    const provider = newProvider(createVultrFetchMock());
    await expect(
      provider.resizeVolume({ volumeId: 'non-existent', location: 'fra', sizeGb: 80 }),
    ).rejects.toThrow(/not found/);
  });

  // M4: PATCH succeeds but the post-resize getVolume 404s → "not found after resize".
  it('resizeVolume throws "not found after resize" when the post-resize read 404s', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'PATCH' && /\/v2\/blocks\/[^/?]+$/.test(u)) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === 'GET' && /\/v2\/blocks\/[^/?]+$/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'gone', status: 404 }), { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'nf', status: 404 }), { status: 404 }));
    });
    globalThis.fetch = fetchMock;
    const provider = new VultrProvider('test-token');

    await expect(
      // currentSizeGb provided so the pre-resize read is skipped; only the post-resize read 404s.
      provider.resizeVolume({ volumeId: 'b-1', location: 'fra', sizeGb: 80, currentSizeGb: 40 }),
    ).rejects.toThrow(/not found after resize/);
  });

  it('deleteVolume rethrows a non-404 provider error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom', status: 500 }), { status: 500 }),
    );
    const provider = new VultrProvider('test-token');
    await expect(
      provider.deleteVolume({ volumeId: 'b-1', location: 'fra' }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it('getVolume rethrows a non-404 provider error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom', status: 500 }), { status: 500 }),
    );
    const provider = new VultrProvider('test-token');
    await expect(
      provider.getVolume({ volumeId: 'b-1', location: 'fra' }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it('maps block status pending → creating and an unknown status → unknown', async () => {
    const fetchMock = createVultrFetchMock({
      listBlocks: [
        createMockVultrBlock({ id: 'pend', region: 'fra', status: 'pending', attached_to_instance: '', label: 'sam-name=p' }),
        createMockVultrBlock({ id: 'weird', region: 'fra', status: 'frobnicated', attached_to_instance: '', label: 'sam-name=w' }),
      ],
    });
    const provider = newProvider(fetchMock);
    const vols = await provider.listVolumes({ location: 'fra' });
    expect(vols.find((v) => v.id === 'pend')?.status).toBe('creating');
    expect(vols.find((v) => v.id === 'weird')?.status).toBe('unknown');
  });

  // H1: listVolumes walks the block cursor pagination, concatenating every page and
  // echoing page 1's cursor on the 2nd request.
  it('listVolumes concatenates all blocks across paginated responses', async () => {
    const fetchMock = createVultrFetchMock({
      blocksPages: [
        {
          items: [
            createMockVultrBlock({ id: 'b1', region: 'fra', label: 'sam-name=b1' }),
            createMockVultrBlock({ id: 'b2', region: 'fra', label: 'sam-name=b2' }),
          ],
          next: 'blk-cursor-2',
        },
        { items: [createMockVultrBlock({ id: 'b3', region: 'fra', label: 'sam-name=b3' })], next: '' },
      ],
    });
    const provider = newProvider(fetchMock);

    const vols = await provider.listVolumes({ location: 'fra' });
    expect(vols.map((v) => v.id)).toEqual(['b1', 'b2', 'b3']);

    const listCalls = fetchMock.mock.calls.filter(([url, init]) => {
      const m = ((init as RequestInit | undefined)?.method || 'GET').toUpperCase();
      return m === 'GET' && /\/v2\/blocks(\?|$)/.test(String(url));
    });
    expect(listCalls).toHaveLength(2);
    expect(String(listCalls[0]![0])).not.toContain('cursor=');
    expect(String(listCalls[1]![0])).toContain('cursor=blk-cursor-2');
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
