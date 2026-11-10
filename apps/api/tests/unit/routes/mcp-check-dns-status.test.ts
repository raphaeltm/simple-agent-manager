/**
 * check_dns_status asks the user's own workspace for a response (self-host T5). On a
 * reverse-tunnel box the workspace proxy passes a node's 3xx through unchanged, so a node could
 * point the Worker at a loopback service if the redirect were followed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleCheckDnsStatus } from '../../../src/routes/mcp/workspace-tools-direct';
import type { McpTokenData } from '../../../src/services/mcp-token';

const TOKEN = { taskId: '', projectId: 'p1', userId: 'u1', workspaceId: 'ws1' } as McpTokenData;
const ENV = { BASE_DOMAIN: 'sam.example.com' } as Env;

afterEach(() => vi.unstubAllGlobals());

describe('check_dns_status', () => {
  it('reports a redirect from the workspace instead of following it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:7001/' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleCheckDnsStatus(1, TOKEN, ENV);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://ws-ws1.sam.example.com',
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    ]);
    const text = (res as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ httpStatus: 302, dnsResolved: true });
  });
});
