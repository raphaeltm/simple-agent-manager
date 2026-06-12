import { afterEach, describe, expect, it, vi } from 'vitest';

import { upsertAppRouteDNSRecord } from '../../../src/services/dns';

function env() {
  return {
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
    DNS_TTL_SECONDS: '120',
  } as any;
}

describe('upsertAppRouteDNSRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates grey-cloud A records for HTTP-01 ACME', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-new' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
      .resolves.toBe('dns-new');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, createInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(createInit.body)).toEqual({
      type: 'A',
      name: 'r1-web.apps.example.com',
      content: '203.0.113.10',
      ttl: 120,
      proxied: false,
    });
  });

  it('updates existing app route records idempotently', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-existing', name: 'r1-web.apps.example.com', type: 'A', content: '198.51.100.2', proxied: false }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-existing' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(upsertAppRouteDNSRecord('r1-web.apps.example.com', '203.0.113.10', env()))
      .resolves.toBe('dns-existing');

    const [url, updateInit] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain('/dns_records/dns-existing');
    expect(updateInit.method).toBe('PUT');
    expect(JSON.parse(updateInit.body)).toMatchObject({
      content: '203.0.113.10',
      proxied: false,
    });
  });
});
