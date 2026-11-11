/**
 * check_dns_status asks the user's own workspace for a response (self-host T5). A node could
 * answer with a redirect to a loopback service, so redirects go through the guarded fetch:
 * public HTTPS hops are followed and httpStatus is the final status (its meaning before T5);
 * a hop to a refused address is reported, never requested.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleCheckDnsStatus } from '../../../src/routes/mcp/workspace-tools-direct';
import type { McpTokenData } from '../../../src/services/mcp-token';

const TOKEN = { taskId: '', projectId: 'p1', userId: 'u1', workspaceId: 'ws1' } as McpTokenData;
const ENV = { BASE_DOMAIN: 'sam.example.com' } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function resultOf(res: unknown): Record<string, unknown> {
  const text = (res as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

describe('check_dns_status', () => {
  it('follows a public HTTPS redirect and reports the final status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://ws-ws1.sam.example.com/login'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleCheckDnsStatus(1, TOKEN, ENV);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://ws-ws1.sam.example.com/',
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://ws-ws1.sam.example.com/login');
    expect(resultOf(res)).toMatchObject({ httpStatus: 200, dnsResolved: true, tlsValid: true });
  });

  it('a redirect chain longer than the hop limit is reported after limit + 1 requests', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let hop = 0;
    const fetchMock = vi.fn(async () =>
      redirect(`https://ws-ws1.sam.example.com/loop/${(hop += 1)}`)
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleCheckDnsStatus(1, TOKEN, ENV);

    // outbound.maxRedirects defaults to 3 (no settings database here, so the default applies).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(resultOf(res)).toMatchObject({ status: 'redirect_refused', refusal: 'redirect_limit' });
  });

  it('a redirect to a loopback service is reported, never requested', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => redirect('http://127.0.0.1:7001/'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleCheckDnsStatus(1, TOKEN, ENV);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resultOf(res)).toMatchObject({
      dnsResolved: true,
      status: 'redirect_refused',
      refusal: 'host',
    });
  });
});
