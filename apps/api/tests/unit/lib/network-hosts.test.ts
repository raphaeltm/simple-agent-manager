/**
 * Host classifier and guarded fetch (self-host T5). Hosts are checked both as bare strings and
 * through `new URL(...).hostname`, because callers pass either and URL parsers canonicalise
 * some spellings (decimal, hex, octal, IPv4-mapped) before the classifier sees them.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assertOutboundUrl,
  classifyHost,
  guardedFetch,
  isAcceptableOperatorEndpoint,
  OutboundRequestRefusedError,
} from '../../../src/lib/network-hosts';

const FORBIDDEN = [
  // metadata and link-local
  '169.254.169.254',
  '169.254.0.1',
  '0xa9fea9fe', // 169.254.169.254 as one hex number
  '2852039166', // 169.254.169.254 as one decimal number
  '0251.0376.0251.0376', // octal
  '169.254.43518', // short form
  '169.254.169.254.', // trailing dot
  '[fe80::1]',
  'fe80::a:b',
  'febf::1',
  '[::ffff:169.254.169.254]',
  '::ffff:a9fe:a9fe',
  '[fd00:ec2::254]',
  '100.100.100.200', // Alibaba metadata
  'metadata',
  'metadata.google.internal',
  'METADATA.GOOGLE.INTERNAL.',
  'metadata.goog',
  'instance-data',
  // unspecified, multicast, reserved, documentation
  '0.0.0.0',
  '0',
  '0x0',
  '::',
  '[::]',
  '224.0.0.1',
  '255.255.255.255',
  '240.0.0.1',
  'ff02::1',
  '192.0.2.10',
  '198.51.100.1',
  '203.0.113.9',
  '2001:db8::1',
  // malformed
  '',
  '.',
  'fe80::1%eth0',
  '1.2.3.4.5',
  '256.1.1.1',
  'example.123',
  '::1::2',
];

const PRIVATE = [
  // loopback in every spelling
  '127.0.0.1',
  '127.1',
  '127.0.1',
  '2130706433',
  '0x7f000001',
  '0x7f.0x0.0x0.0x1',
  '0177.0.0.1',
  '017700000001',
  '127.0.0.1.',
  '127.255.255.254',
  'localhost',
  'LOCALHOST.',
  'api.localhost',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  '[::ffff:7f00:1]',
  '::127.0.0.1', // IPv4-compatible
  '::ffff:0:127.0.0.1', // IPv4-translated
  '64:ff9b::127.0.0.1', // NAT64
  '2002:7f00:1::', // 6to4 of 127.0.0.1
  // private ranges
  '10.0.0.1',
  '10.255.255.255',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '100.64.0.1',
  '100.127.255.255',
  '198.18.0.1',
  '::ffff:10.0.0.1',
  'fc00::1',
  'fd12:3456::1',
  'fec0::1',
  // private-network names
  'minio',
  'objectstore',
  'celld.',
  'printer.local',
  'db.internal',
  'host.localdomain',
  'router.lan',
  'nas.home.arpa',
];

const PUBLIC = [
  'api.openai.com',
  'llm.example.com',
  'example.com.',
  '8.8.8.8',
  '1.1.1.1',
  '172.15.255.255',
  '172.32.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '169.253.1.1',
  '192.169.0.1',
  '2606:4700:4700::1111',
  '[2a00:1450:4001::200e]',
  '::ffff:8.8.8.8',
  'xn--bcher-kva.example',
];

describe('classifyHost', () => {
  it.each(FORBIDDEN)('forbidden: %s', (host) => {
    expect(classifyHost(host)).toBe('forbidden');
  });

  it.each(PRIVATE)('private: %s', (host) => {
    expect(classifyHost(host)).toBe('private');
  });

  it.each(PUBLIC)('public: %s', (host) => {
    expect(classifyHost(host)).toBe('public');
  });

  it.each([
    ['http://2130706433/', 'private'],
    ['http://0x7f.1/', 'private'],
    ['http://0177.0.0.1/', 'private'],
    ['http://127.1/', 'private'],
    ['http://127.0.0.1./', 'private'],
    ['http://[::ffff:127.0.0.1]/', 'private'],
    ['http://[0:0:0:0:0:ffff:7f00:1]/', 'private'],
    ['http://LocalHost./', 'private'],
    ['http://0xa9.0xfe.0xa9.0xfe/', 'forbidden'],
    ['http://[::ffff:169.254.169.254]/', 'forbidden'],
    ['http://metadata.google.internal./', 'forbidden'],
    ['https://api.anthropic.com/', 'public'],
  ])('through URL parsing: %s is %s', (url, expected) => {
    expect(classifyHost(new URL(url).hostname)).toBe(expected);
  });
});

describe('isAcceptableOperatorEndpoint', () => {
  it.each([
    ['https://llm.example.com/v1', true],
    ['https://10.0.0.5/v1', true],
    ['http://127.0.0.1:11434/v1', true],
    ['http://ollama:11434/v1', true],
    ['http://llm.example.com/v1', false],
    ['https://169.254.169.254/', false],
    ['http://metadata.google.internal/', false],
    ['https://user:pw@llm.example.com/v1', false],
  ])('%s -> %s', (url, expected) => {
    expect(isAcceptableOperatorEndpoint(new URL(url))).toBe(expected);
  });
});

describe('assertOutboundUrl', () => {
  it.each([
    ['https://llm.example.com/v1', {}, null],
    ['https://127.0.0.1/v1', {}, 'host'],
    ['https://127.0.0.1/v1', { allowPrivateNetwork: true }, null],
    ['http://127.0.0.1:11434/v1', { allowPrivateNetwork: true }, null],
    ['http://llm.example.com/v1', { allowPrivateNetwork: true }, 'scheme'],
    ['https://169.254.169.254/', { allowPrivateNetwork: true }, 'host'],
    ['ftp://llm.example.com/', {}, 'scheme'],
    ['file:///etc/passwd', {}, 'scheme'],
    ['https://u:p@llm.example.com/', {}, 'userinfo'],
    ['not a url', {}, 'invalid_url'],
  ])('%s %j -> %s', (url, policy, reason) => {
    if (reason === null) {
      expect(() => assertOutboundUrl(url, policy)).not.toThrow();
      return;
    }
    try {
      assertOutboundUrl(url, policy);
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(OutboundRequestRefusedError);
      expect((err as OutboundRequestRefusedError).reason).toBe(reason);
    }
  });
});

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

describe('guardedFetch', () => {
  it('never lets the runtime follow redirects', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    await guardedFetch('https://a.example.com/', {}, { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith('https://a.example.com/', { redirect: 'manual' });
  });

  it('refuses a hop to a private address without sending it', async () => {
    const fetchFn = vi.fn(async () => redirect(302, 'http://127.0.0.1:7001/state'));
    await expect(guardedFetch('https://a.example.com/', {}, { fetchFn })).rejects.toMatchObject({
      reason: 'host',
      host: '127.0.0.1',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses a hop to the metadata server even for an opted-in operator endpoint', async () => {
    const fetchFn = vi.fn(async () => redirect(307, 'http://169.254.169.254/computeMetadata/v1/'));
    await expect(
      guardedFetch('http://127.0.0.1:11434/v1', {}, { fetchFn, allowPrivateNetwork: true })
    ).rejects.toMatchObject({ reason: 'host' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Location against the current URL and re-checks it', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect(301, '/moved'))
      .mockResolvedValueOnce(new Response('final'));
    const res = await guardedFetch('https://a.example.com/start', {}, { fetchFn });
    expect(await res.text()).toBe('final');
    expect(fetchFn.mock.calls[1]?.[0]).toBe('https://a.example.com/moved');
  });

  it('stops after maxRedirects hops', async () => {
    const fetchFn = vi.fn(async () => redirect(302, 'https://a.example.com/loop'));
    await expect(
      guardedFetch('https://a.example.com/', {}, { fetchFn, maxRedirects: 2 })
    ).rejects.toMatchObject({ reason: 'redirect_limit' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('maxRedirects 0 refuses the first redirect', async () => {
    const fetchFn = vi.fn(async () => redirect(302, 'https://b.example.com/'));
    await expect(
      guardedFetch('https://a.example.com/', {}, { fetchFn, maxRedirects: 0 })
    ).rejects.toMatchObject({ reason: 'redirect_limit' });
  });

  it('drops credential headers when a redirect leaves the origin', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect(307, 'https://b.example.com/x'))
      .mockResolvedValueOnce(new Response('ok'));
    await guardedFetch(
      'https://a.example.com/',
      {
        method: 'POST',
        body: '{}',
        headers: { Authorization: 'Bearer k', 'x-api-key': 'k', 'content-type': 'application/json' },
      },
      { fetchFn }
    );
    const headers = new Headers((fetchFn.mock.calls[1]?.[1] as RequestInit).headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
    expect((fetchFn.mock.calls[1]?.[1] as RequestInit).body).toBe('{}');
  });

  it('keeps credential headers on a same-origin redirect', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect(308, 'https://a.example.com/v2'))
      .mockResolvedValueOnce(new Response('ok'));
    await guardedFetch(
      'https://a.example.com/v1',
      { method: 'POST', body: '{}', headers: { Authorization: 'Bearer k' } },
      { fetchFn }
    );
    expect(new Headers((fetchFn.mock.calls[1]?.[1] as RequestInit).headers).get('authorization')).toBe(
      'Bearer k'
    );
  });

  it('turns a POST into a body-less GET on 303', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect(303, 'https://a.example.com/result'))
      .mockResolvedValueOnce(new Response('ok'));
    await guardedFetch(
      'https://a.example.com/',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      { fetchFn }
    );
    const next = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(next.method).toBe('GET');
    expect(next.body).toBeUndefined();
    expect(new Headers(next.headers).get('content-type')).toBeNull();
  });

  it('refuses to replay a streamed body on 307', async () => {
    const fetchFn = vi.fn(async () => redirect(307, 'https://a.example.com/again'));
    await expect(
      guardedFetch(
        'https://a.example.com/',
        { method: 'POST', body: new ReadableStream() },
        { fetchFn }
      )
    ).rejects.toMatchObject({ reason: 'redirect_unreplayable' });
  });

  it('returns a 3xx without Location, and non-redirect statuses, unchanged', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 304 }));
    const res = await guardedFetch('https://a.example.com/', {}, { fetchFn });
    expect(res.status).toBe(304);
  });

  it('applies the per-hop validator to every hop', async () => {
    const validateUrl = vi.fn((url: URL) => {
      if (url.pathname === '/bad') throw new Error('custom refusal');
    });
    const fetchFn = vi.fn(async () => redirect(302, 'https://a.example.com/bad'));
    await expect(
      guardedFetch('https://a.example.com/', {}, { fetchFn, validateUrl })
    ).rejects.toThrow('custom refusal');
    expect(validateUrl).toHaveBeenCalledTimes(2);
  });

  it('uses the global fetch when no fetchFn is given', async () => {
    const globalFetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', globalFetch);
    try {
      await guardedFetch('https://a.example.com/');
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
