import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyDigitalOceanError,
  DigitalOceanProvider,
  extractPublicIp,
  mapDigitalOceanStatus,
} from '../../src/digitalocean';
import { ProviderError } from '../../src/types';
import {
  validateDigitalOceanDropletResponse,
  validateDigitalOceanVolumesResponse,
} from '../../src/validation-digitalocean';
import {
  createDigitalOceanFetchMock,
  createMockDigitalOceanDroplet,
} from '../fixtures/digitalocean-mocks';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function provider(
  mock: ReturnType<typeof vi.fn>,
  options: ConstructorParameters<typeof DigitalOceanProvider>[1] = {}
) {
  globalThis.fetch = mock;
  return new DigitalOceanProvider('secret-token', {
    ipPollTimeoutMs: 100,
    ipPollIntervalMs: 1,
    ...options,
  });
}
function findCall(mock: ReturnType<typeof vi.fn>, method: string, matcher: RegExp) {
  return mock.mock.calls.find(
    ([url, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method &&
      matcher.test(String(url))
  );
}

describe('DigitalOceanProvider droplets', () => {
  it('creates a droplet with plain cloud-init, colon tags, stable image, and integer id conversion', async () => {
    const mock = createDigitalOceanFetchMock({ createDroplet: createMockDigitalOceanDroplet() });
    const vm = await provider(mock).createVM({
      name: 'SAM Node !!!',
      size: 'small',
      location: 'fra1',
      image: '',
      userData: '#cloud-config\nruncmd: []',
      labels: { 'sam-project': '01ABC' },
    });
    const call = findCall(mock, 'POST', /\/v2\/droplets$/);
    const body = JSON.parse(call?.[1].body as string);
    expect(body).toEqual(
      expect.objectContaining({
        name: 'sam-node',
        region: 'fra1',
        size: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        user_data: '#cloud-config\nruncmd: []',
        tags: ['sam-project:01ABC'],
        backups: false,
        ipv6: false,
        monitoring: false,
      })
    );
    expect(vm).toMatchObject({ id: '12345', ip: '192.0.2.10', status: 'running' });
    expect((call?.[1].headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('accepts a numeric image id override and polls asynchronously for public IPv4', async () => {
    const mock = createDigitalOceanFetchMock({
      createDroplet: createMockDigitalOceanDroplet({ status: 'new', networks: { v4: [] } }),
      getDroplet: createMockDigitalOceanDroplet(),
    });
    const vm = await provider(mock).createVM({
      name: 'node',
      size: 'small',
      location: 'fra1',
      image: '1234',
      userData: 'plain',
    });
    const body = JSON.parse(findCall(mock, 'POST', /\/v2\/droplets$/)?.[1].body as string);
    expect(body.image).toBe(1234);
    expect(vm.ip).toBe('192.0.2.10');
    expect(findCall(mock, 'GET', /\/v2\/droplets\/12345$/)).toBeDefined();
  });

  it('returns empty IP after a hard-bounded best-effort poll', async () => {
    const mock = createDigitalOceanFetchMock({
      createDroplet: createMockDigitalOceanDroplet({ status: 'new', networks: { v4: [] } }),
      getDroplet: createMockDigitalOceanDroplet({ networks: { v4: [] } }),
    });
    const start = Date.now();
    const vm = await provider(mock, { ipPollTimeoutMs: 15, ipPollIntervalMs: 3 }).createVM({
      name: 'node',
      size: 'small',
      location: 'fra1',
      image: '',
      userData: 'plain',
    });
    expect(vm.ip).toBe('');
    expect(Date.now() - start).toBeLessThan(150);
  });

  it('lists all pages then filters decoded labels', async () => {
    const mock = createDigitalOceanFetchMock({
      dropletPages: [
        { items: [createMockDigitalOceanDroplet({ id: 1, tags: ['env:prod'] })], hasNext: true },
        { items: [createMockDigitalOceanDroplet({ id: 2, tags: ['env:dev'] })], hasNext: false },
      ],
    });
    const vms = await provider(mock).listVMs({ env: 'prod' });
    expect(vms.map((vm) => vm.id)).toEqual(['1']);
    expect(mock.mock.calls.filter(([url]) => String(url).includes('/v2/droplets?'))).toHaveLength(
      2
    );
  });

  it('validates token, powers droplets, and handles missing resources idempotently', async () => {
    const mock = createDigitalOceanFetchMock();
    const p = provider(mock);
    await expect(p.validateToken()).resolves.toBe(true);
    await p.powerOff('123');
    await p.powerOn('123');
    expect(
      JSON.parse(findCall(mock, 'POST', /\/droplets\/123\/actions$/)?.[1].body as string).type
    ).toBe('power_off');
    await expect(p.deleteVM('missing')).resolves.toBeUndefined();
    await expect(p.getVM('missing')).resolves.toBeNull();
  });

  it('sanitizes provider error messages without exposing token', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'unauthorized', message: 'Unable to authenticate you' }),
          { status: 401 }
        )
      );
    const p = new DigitalOceanProvider('super-secret');
    const error = await p.validateToken().catch((value) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ category: 'auth_error', statusCode: 401 });
    expect(String(error)).not.toContain('super-secret');
  });
});

describe('DigitalOcean pure mappings', () => {
  it.each([
    ['new', 'initializing'],
    ['active', 'running'],
    ['off', 'off'],
    ['archive', 'off'],
    ['other', 'initializing'],
  ])('maps %s', (status, expected) => expect(mapDigitalOceanStatus(status)).toBe(expected));
  it('extracts only a public IPv4', () =>
    expect(
      extractPublicIp([
        { ip_address: '10.0.0.1', type: 'private' },
        { ip_address: '203.0.113.1', type: 'public' },
      ])
    ).toBe('203.0.113.1'));
  it.each([
    [401, '', 'auth_error'],
    [403, '', 'auth_error'],
    [429, '', 'rate_limited'],
    [500, '', 'transient_capacity'],
    [422, 'no capacity', 'transient_capacity'],
    [400, 'bad', 'invalid_config'],
    [404, 'missing', 'invalid_config'],
    [418, 'teapot', 'unknown'],
  ])('classifies %s %s', (status, message, expected) =>
    expect(classifyDigitalOceanError(status as number, message)).toBe(expected)
  );
  it('rejects malformed network, tag, volume-id, and pagination payload shapes', () => {
    expect(() =>
      validateDigitalOceanDropletResponse(
        { droplet: { id: 1, status: 'active', networks: { v4: 'bad' } } },
        'test'
      )
    ).toThrow(/networks.v4/);
    expect(() =>
      validateDigitalOceanDropletResponse(
        { droplet: { id: 1, status: 'active', tags: ['ok', 2] } },
        'test'
      )
    ).toThrow(/tags/);
    expect(() =>
      validateDigitalOceanVolumesResponse(
        { volumes: [{ id: 'v', size_gigabytes: 1, droplet_ids: ['bad'] }], links: { pages: {} } },
        'test'
      )
    ).toThrow(/droplet_ids/);
    expect(
      validateDigitalOceanVolumesResponse({ volumes: [{ id: 'v', size_gigabytes: 1 }] }, 'test')
        .hasNextPage
    ).toBe(false);
  });
});
