import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../../src/types';
import {
  classifyVultrError,
  findVultrOs,
  mapVultrStatus,
  VultrProvider,
} from '../../src/vultr';
import { createMockVultrInstance, createVultrFetchMock } from '../fixtures/vultr-mocks';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Decode a Workers-style base64 (btoa of UTF-8 bytes) back to a string. */
function decodeBase64(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
}

function findCall(mock: ReturnType<typeof vi.fn>, method: string, matcher: RegExp) {
  return mock.mock.calls.find(([url, init]) => {
    const m = ((init as RequestInit | undefined)?.method || 'GET').toUpperCase();
    return m === method && matcher.test(String(url));
  }) as [string, RequestInit] | undefined;
}

function newProvider(fetchMock: ReturnType<typeof vi.fn>, options = {}) {
  globalThis.fetch = fetchMock;
  return new VultrProvider('test-token', { ipPollTimeoutMs: 50, ipPollIntervalMs: 5, ...options });
}

describe('VultrProvider createVM', () => {
  it('sends the correct create payload (resolved os_id, plan, base64 user_data, tags, hygiene flags)', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);

    await provider.createVM({
      name: 'My Node',
      size: 'small',
      location: 'fra',
      userData: '#cloud-config\nhostname: sam\n',
      labels: { 'managed-by': 'sam', 'node-id': 'n1' },
    });

    const createCall = findCall(fetchMock, 'POST', /\/v2\/instances$/);
    expect(createCall).toBeDefined();
    const body = JSON.parse(createCall![1].body as string);
    expect(body.region).toBe('fra');
    expect(body.plan).toBe('vc2-2c-4gb');
    expect(body.os_id).toBe(1743); // Ubuntu 24.04 LTS x64 from GET /os
    expect(body.label).toBe('My Node');
    expect(body.hostname).toBe('my-node'); // sanitized
    expect(body.backups).toBe('disabled');
    expect(body.activation_email).toBe(false);
    expect(body.tags).toEqual(['managed-by=sam', 'node-id=n1']);
    expect(decodeBase64(body.user_data)).toBe('#cloud-config\nhostname: sam\n');

    // Auth header present
    expect((createCall![1].headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('accepts an explicit numeric os_id via config.image without calling GET /os', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);

    await provider.createVM({
      name: 'node',
      size: 'medium',
      location: 'ewr',
      userData: 'x',
      image: '2075',
    });

    const body = JSON.parse(findCall(fetchMock, 'POST', /\/v2\/instances$/)![1].body as string);
    expect(body.os_id).toBe(2075);
    expect(body.plan).toBe('vc2-4c-8gb');
    expect(findCall(fetchMock, 'GET', /\/v2\/os/)).toBeUndefined();
  });

  it('polls for main_ip and returns the real IP once allocated', async () => {
    // create returns 0.0.0.0; the poll GET returns a ready instance with a real IP
    const fetchMock = createVultrFetchMock({
      createInstance: createMockVultrInstance({ id: 'i-1', main_ip: '0.0.0.0', status: 'pending' }),
      getInstance: createMockVultrInstance({ id: 'i-1', main_ip: '203.0.113.5', status: 'active' }),
    });
    const provider = newProvider(fetchMock);

    const vm = await provider.createVM({ name: 'node', size: 'small', location: 'fra', userData: 'x' });
    expect(vm.ip).toBe('203.0.113.5');
    expect(vm.id).toBe('i-1');
  });

  it('returns an empty IP (heartbeat backfill fallback) when the IP never allocates before timeout', async () => {
    const pending = createMockVultrInstance({ id: 'i-1', main_ip: '0.0.0.0', status: 'pending', power_status: 'stopped', server_status: 'none' });
    const fetchMock = createVultrFetchMock({ createInstance: pending, getInstance: pending });
    const provider = newProvider(fetchMock, { ipPollTimeoutMs: 20, ipPollIntervalMs: 5 });

    const vm = await provider.createVM({ name: 'node', size: 'small', location: 'fra', userData: 'x' });
    expect(vm.ip).toBe('');
    expect(vm.id).toBe('i-1');
  });

  it('rejects an unknown VM size before any API call', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);
    await expect(
      // @ts-expect-error intentionally invalid size
      provider.createVM({ name: 'n', size: 'huge', location: 'fra', userData: 'x' }),
    ).rejects.toThrow(/Unknown VM size/);
  });

  it('throws invalid_config when no matching OS is found', async () => {
    const fetchMock = createVultrFetchMock({ os: [{ id: 1, name: 'Debian 12 x64', arch: 'x64', family: 'debian' }] });
    const provider = newProvider(fetchMock);
    await expect(
      provider.createVM({ name: 'n', size: 'small', location: 'fra', userData: 'x' }),
    ).rejects.toMatchObject({ category: 'invalid_config' });
  });
});

describe('VultrProvider lifecycle', () => {
  it('deleteVM is idempotent on 404', async () => {
    const provider = newProvider(createVultrFetchMock());
    await expect(provider.deleteVM('non-existent-id')).resolves.toBeUndefined();
  });

  it('deleteVM issues DELETE /v2/instances/:id', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);
    await provider.deleteVM('i-9');
    expect(findCall(fetchMock, 'DELETE', /\/v2\/instances\/i-9$/)).toBeDefined();
  });

  it('getVM returns null on 404', async () => {
    const provider = newProvider(createVultrFetchMock());
    expect(await provider.getVM('non-existent-id')).toBeNull();
  });

  it('getVM maps an instance including decoded labels', async () => {
    const fetchMock = createVultrFetchMock({
      getInstance: createMockVultrInstance({ id: 'i-2', tags: ['managed-by=sam', 'node-id=n2'] }),
    });
    const provider = newProvider(fetchMock);
    const vm = await provider.getVM('i-2');
    expect(vm).toMatchObject({ id: 'i-2', ip: '192.0.2.10', serverType: 'vc2-2c-4gb', status: 'running' });
    expect(vm?.labels).toEqual({ 'managed-by': 'sam', 'node-id': 'n2' });
  });

  it('powerOff calls halt and powerOn calls start', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);
    await provider.powerOff('i-3');
    await provider.powerOn('i-3');
    expect(findCall(fetchMock, 'POST', /\/v2\/instances\/i-3\/halt$/)).toBeDefined();
    expect(findCall(fetchMock, 'POST', /\/v2\/instances\/i-3\/start$/)).toBeDefined();
  });

  it('validateToken hits GET /v2/account and returns true', async () => {
    const fetchMock = createVultrFetchMock();
    const provider = newProvider(fetchMock);
    expect(await provider.validateToken()).toBe(true);
    expect(findCall(fetchMock, 'GET', /\/v2\/account$/)).toBeDefined();
  });

  it('listVMs filters client-side by labels', async () => {
    const fetchMock = createVultrFetchMock({
      listInstances: [
        createMockVultrInstance({ id: 'a', tags: ['managed-by=sam', 'env=prod'] }),
        createMockVultrInstance({ id: 'b', tags: ['managed-by=other'] }),
        createMockVultrInstance({ id: 'c', tags: ['managed-by=sam', 'env=dev'] }),
      ],
    });
    const provider = newProvider(fetchMock);
    const all = await provider.listVMs();
    expect(all.map((v) => v.id)).toEqual(['a', 'b', 'c']);
    const filtered = await provider.listVMs({ 'managed-by': 'sam', env: 'prod' });
    expect(filtered.map((v) => v.id)).toEqual(['a']);
  });

  it('maps a 401 to auth_error category', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid API key', status: 401 }), { status: 401 }),
    );
    const provider = new VultrProvider('bad-token');
    await expect(provider.validateToken()).rejects.toMatchObject({ category: 'auth_error', statusCode: 401 });
  });
});

describe('mapVultrStatus', () => {
  it.each([
    ['pending', 'stopped', 'none', 'initializing'],
    ['active', 'running', 'ok', 'running'],
    ['active', 'running', 'installingbooting', 'starting'],
    ['active', 'running', 'none', 'starting'],
    ['active', 'stopped', 'ok', 'off'],
    ['suspended', 'stopped', 'ok', 'off'],
    ['resizing', 'running', 'ok', 'starting'],
  ])('status=%s power=%s server=%s → %s', (status, power, server, expected) => {
    expect(mapVultrStatus(status, power, server)).toBe(expected);
  });
});

describe('classifyVultrError', () => {
  it.each([
    [401, '', 'auth_error'],
    [403, '', 'auth_error'],
    [429, '', 'rate_limited'],
    [503, '', 'transient_capacity'],
    [400, 'Plan is not available in the selected location', 'transient_capacity'],
    [400, 'Invalid plan', 'invalid_config'],
    [422, 'bad field', 'invalid_config'],
    [404, 'not found', 'invalid_config'],
    [500, 'server error', 'unknown'],
  ])('status=%s msg=%s → %s', (status, msg, expected) => {
    expect(classifyVultrError(status as number, msg as string)).toBe(expected);
  });
});

describe('findVultrOs', () => {
  const list = [
    { id: 1, name: 'Debian 12 x64', arch: 'x64', family: 'debian' },
    { id: 1743, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' },
    { id: 2, name: 'Ubuntu 22.04 LTS x64', arch: 'x64', family: 'ubuntu' },
  ];
  it('matches exact name first', () => {
    expect(findVultrOs(list, 'Ubuntu 24.04 LTS x64')?.id).toBe(1743);
  });
  it('falls back to all-token-subset match', () => {
    expect(findVultrOs(list, 'ubuntu 24.04 x64')?.id).toBe(1743);
  });
  it('returns undefined when nothing matches', () => {
    expect(findVultrOs(list, 'windows server')).toBeUndefined();
  });
});

describe('ProviderError shape', () => {
  it('preserves provider name on thrown errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom', status: 500 }), { status: 500 }),
    );
    const provider = new VultrProvider('t');
    await expect(provider.validateToken()).rejects.toBeInstanceOf(ProviderError);
  });
});
