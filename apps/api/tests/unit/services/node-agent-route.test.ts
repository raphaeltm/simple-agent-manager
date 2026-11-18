import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { fetchNodeAgent } from '../../../src/services/node-agent';
import {
  NodeAgentRouteError,
  resolveNodeAgentRoute,
  retargetNodeAgentUrl,
} from '../../../src/services/node-agent-route';
import { provisionsExtensionTransportNodes } from '../../../src/services/node-transport-extension';

/**
 * The shared route seam as the Cloudflare Worker runs it: no transport extension is installed
 * in this file. Public transports cost no read beyond the node row the caller already loads,
 * and a tunnel-only transport fails closed instead of guessing the public hostname.
 */
const env = {
  BASE_DOMAIN: 'example.test',
  VM_AGENT_PROTOCOL: 'https',
  VM_AGENT_PORT: '8443',
  VM_AGENT_TRANSPORT: 'reverse-tunnel',
} as Env;

function countingD1(row: Record<string, unknown> | null) {
  const prepare = vi.fn(() => {
    const statement = {
      bind: () => statement,
      first: async () => row,
      all: async () => ({ results: row ? [row] : [] }),
      raw: async () => (row ? [Object.values(row)] : []),
      run: async () => ({ success: true, meta: {} }),
    };
    return statement;
  });
  return { prepare } as unknown as D1Database & { prepare: typeof prepare };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveNodeAgentRoute without an installed extension (Cloudflare)', () => {
  it.each([null, 'vm-public-dns', 'cloudflare-tunnel'])(
    'routes transport %j to the public backend hostname',
    async (transport) => {
      await expect(
        resolveNodeAgentRoute(env, 'NODEA', { runtime: 'vm', transport })
      ).resolves.toEqual({ kind: 'public', origin: 'https://nodea.vm.example.test:8443' });
    }
  );

  it('routes an Instant node to its container', async () => {
    await expect(
      resolveNodeAgentRoute(env, 'NODEA', { runtime: 'cf-container', transport: null })
    ).resolves.toEqual({ kind: 'container' });
  });

  it('fails closed for a reverse-tunnel node: no DNS record exists to guess', async () => {
    await expect(
      resolveNodeAgentRoute(env, 'NODEA', { runtime: 'vm', transport: 'reverse-tunnel' })
    ).rejects.toBeInstanceOf(NodeAgentRouteError);
  });

  it('never treats the installation flag as an installed transport', () => {
    expect(provisionsExtensionTransportNodes(env)).toBe(false);
    expect(provisionsExtensionTransportNodes({ VM_AGENT_TRANSPORT: undefined })).toBe(false);
  });
});

describe('fetchNodeAgent on Cloudflare', () => {
  it('makes exactly the one node read it always made, then fetches the public hostname', async () => {
    const database = countingD1({ runtime: 'vm', transport: 'cloudflare-tunnel' });
    const nodeFetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', nodeFetch);
    const url = 'https://nodea.vm.example.test:8443/system-info';
    await fetchNodeAgent('NODEA', { ...env, DATABASE: database }, url, { method: 'GET' }, 1000);
    expect(database.prepare).toHaveBeenCalledTimes(1);
    expect(nodeFetch.mock.calls[0]?.[0]).toBe(url);
  });

  it('refuses a reverse-tunnel node without fetching anything', async () => {
    const database = countingD1({ runtime: 'vm', transport: 'reverse-tunnel' });
    const nodeFetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', nodeFetch);
    await expect(
      fetchNodeAgent(
        'NODEA',
        { ...env, DATABASE: database },
        'https://nodea.vm.example.test:8443/health',
        { method: 'GET' },
        1000
      )
    ).rejects.toBeInstanceOf(NodeAgentRouteError);
    expect(nodeFetch).not.toHaveBeenCalled();
  });
});

describe('retargetNodeAgentUrl', () => {
  it('keeps path and query and swaps only the origin for an extension route', () => {
    const url = 'https://nodea.vm.example.test:8443/workspaces/w/ports/3000/a%20b?token=t&x=1';
    expect(retargetNodeAgentUrl(url, { kind: 'extension', origin: 'http://127.0.0.1:20001' })).toBe(
      'http://127.0.0.1:20001/workspaces/w/ports/3000/a%20b?token=t&x=1'
    );
    expect(retargetNodeAgentUrl(url, { kind: 'public', origin: 'https://ignored' })).toBe(url);
  });
});
