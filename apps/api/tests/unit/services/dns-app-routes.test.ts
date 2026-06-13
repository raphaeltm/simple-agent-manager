import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupAppRouteDNSRecords,
  deleteAppRouteDNSRecord,
  upsertAppRouteDNSRecord,
} from '../../../src/services/dns';

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

describe('deleteAppRouteDNSRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds the record by name and deletes it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-1', name: 'r1-web.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteAppRouteDNSRecord('r1-web.apps.example.com', env())).resolves.toBe(true);

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
    expect(String(deleteUrl)).toContain('/dns_records/dns-1');
    expect(deleteInit.method).toBe('DELETE');
  });

  it('is a no-op when no matching record exists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteAppRouteDNSRecord('r1-web.apps.example.com', env())).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tolerates a record deleted concurrently (404 on delete)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-gone', name: 'r1-web.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteAppRouteDNSRecord('r1-web.apps.example.com', env())).resolves.toBe(true);
  });
});

describe('cleanupAppRouteDNSRecords', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes every matching record and returns the count actually removed', async () => {
    const fetchMock = vi.fn()
      // hostname 1: found + deleted
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-1', name: 'r1-web-3000-env.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // hostname 2: not found (no-op)
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const deleted = await cleanupAppRouteDNSRecords(
      ['r1-web-3000-env.apps.example.com', 'r2-api-8081-env.apps.example.com'],
      env(),
    );

    expect(deleted).toBe(1);
  });

  it('skips a failing record and continues deleting the rest', async () => {
    const fetchMock = vi.fn()
      // hostname 1: search fails -> error swallowed, count unaffected
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      // hostname 2: found + deleted
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 'dns-2', name: 'r2-api-8081-env.apps.example.com', type: 'A' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const deleted = await cleanupAppRouteDNSRecords(
      ['r1-web-3000-env.apps.example.com', 'r2-api-8081-env.apps.example.com'],
      env(),
    );

    expect(deleted).toBe(1);
  });

  it('returns zero for an empty hostname list without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupAppRouteDNSRecords([], env())).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
