import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  matchesCustomDomainTarget,
  resolveHostnameTarget,
  verifyCustomDomainTarget,
} from '../../../src/services/deployment-domain-verify';

function env() {
  return {} as any;
}

/** Build a Cloudflare DoH JSON answer for a CNAME chain terminating in an A record. */
function dohAnswer(answers: Array<{ name: string; type: number; data: string }>) {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), { status: 200 });
}

const ROUTE_TARGET = 'r1-web-3000-prod.apps.example.com';
const NODE_IP = '203.0.113.10';

describe('resolveHostnameTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the CNAME chain and terminal A records, normalizing names', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      dohAnswer([
        { name: 'app.theircompany.com.', type: 5, data: 'R1-Web-3000-Prod.Apps.Example.Com.' },
        { name: 'r1-web-3000-prod.apps.example.com.', type: 1, data: NODE_IP },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveHostnameTarget('app.theircompany.com', env());
    expect(resolved.cnames).toEqual(['r1-web-3000-prod.apps.example.com']);
    expect(resolved.a).toEqual([NODE_IP]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('name=app.theircompany.com');
    expect(String(url)).toContain('type=A');
    expect((init as RequestInit).headers).toMatchObject({ accept: 'application/dns-json' });
  });

  it('returns empty arrays on a non-OK resolver response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('nope', { status: 502 })));
    const resolved = await resolveHostnameTarget('app.theircompany.com', env());
    expect(resolved).toEqual({ cnames: [], a: [] });
  });

  it('returns empty arrays when the resolver reports NXDOMAIN with no answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ Status: 3 }), { status: 200 })),
    );
    const resolved = await resolveHostnameTarget('missing.theircompany.com', env());
    expect(resolved).toEqual({ cnames: [], a: [] });
  });
});

describe('matchesCustomDomainTarget', () => {
  it('verifies when the CNAME chain includes the expected route hostname', () => {
    expect(
      matchesCustomDomainTarget({ cnames: [ROUTE_TARGET], a: [] }, ROUTE_TARGET, NODE_IP),
    ).toBe(true);
  });

  it('verifies via an A record equal to the node IP (flattened CNAME)', () => {
    expect(matchesCustomDomainTarget({ cnames: [], a: [NODE_IP] }, ROUTE_TARGET, NODE_IP)).toBe(
      true,
    );
  });

  it('does not verify when neither the CNAME nor the A record matches', () => {
    expect(
      matchesCustomDomainTarget(
        { cnames: ['some-other.apps.example.com'], a: ['198.51.100.99'] },
        ROUTE_TARGET,
        NODE_IP,
      ),
    ).toBe(false);
  });

  it('does not verify on an A-record match when no node IP is known', () => {
    expect(matchesCustomDomainTarget({ cnames: [], a: [NODE_IP] }, ROUTE_TARGET, undefined)).toBe(
      false,
    );
  });
});

describe('verifyCustomDomainTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true for a matching CNAME answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        dohAnswer([
          { name: 'app.theircompany.com.', type: 5, data: `${ROUTE_TARGET}.` },
          { name: `${ROUTE_TARGET}.`, type: 1, data: NODE_IP },
        ]),
      ),
    );
    await expect(
      verifyCustomDomainTarget('app.theircompany.com', ROUTE_TARGET, NODE_IP, env()),
    ).resolves.toBe(true);
  });

  it('returns false for a non-matching answer pointing elsewhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        dohAnswer([
          { name: 'app.theircompany.com.', type: 5, data: 'someone-else.example.net.' },
          { name: 'someone-else.example.net.', type: 1, data: '198.51.100.99' },
        ]),
      ),
    );
    await expect(
      verifyCustomDomainTarget('app.theircompany.com', ROUTE_TARGET, NODE_IP, env()),
    ).resolves.toBe(false);
  });

  it('returns true when the hostname is flattened to the node A record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        dohAnswer([{ name: 'app.theircompany.com.', type: 1, data: NODE_IP }]),
      ),
    );
    await expect(
      verifyCustomDomainTarget('app.theircompany.com', ROUTE_TARGET, NODE_IP, env()),
    ).resolves.toBe(true);
  });
});
