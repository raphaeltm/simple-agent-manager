/**
 * Rule 74 pair for deployment nodes on the box's reverse tunnel. The condition is "this
 * installation carries app ingress through the box"; the signal is the installed transport
 * extension plus a node's stored transport. They diverge on a Cloudflare install, where a
 * deployment node must keep today's transport and its public app ingress, whatever the role.
 *
 * Every value goes through the real resolver (`resolveManagedNodeTransport`) and the real
 * release-record writer (`upsertReleaseRouteRecords`); only the DNS write itself is recorded. The
 * provider label (`app-ingress=tunnel`) is asserted through the real `provisionNode` in
 * node-reverse-tunnel-lifecycle.test.ts, on both sides.
 */
import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const upserts = vi.hoisted(() => [] as Array<{ hostname: string; ip: string }>);
vi.mock('../../../src/services/dns-app-routes', () => ({
  upsertAppRouteDNSRecord: vi.fn(async (hostname: string, ip: string) => {
    upserts.push({ hostname, ip });
    return `record-${hostname}`;
  }),
}));

const { installReverseTunnelTransport } =
  await import('../../../src/selfhost/reverse-tunnel/transport');
const { upsertReleaseRouteRecords } = await import('../../../src/services/app-route-dns-target');
const { resolveManagedNodeTransport } = await import('../../../src/services/node-tunnel-config');

const DEPLOYMENT = { runtime: 'vm', nodeClass: 'managed', nodeRole: 'deployment' } as const;
const ROUTES = [{ hostname: 'r1-web-80-env1.apps.example.test' }];
const NODE_IP = '198.51.100.7';
const BOX_IP = '203.0.113.5';

beforeEach(() => {
  upserts.length = 0;
});

// Runs first: the Cloudflare Worker never installs the reverse-tunnel extension.
describe('Cloudflare-shaped installation (no extension installed): divergence', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['vm-public-dns', null],
    ['cloudflare-tunnel', 'cloudflare-tunnel'],
  ] as const)('VM_AGENT_TRANSPORT=%j keeps a deployment node on %j', (configured, expected) => {
    const env = { VM_AGENT_TRANSPORT: configured } as Pick<Env, 'VM_AGENT_TRANSPORT'>;
    expect(resolveManagedNodeTransport(env, DEPLOYMENT)).toBe(expected);
  });

  it('a box-shaped transport value fails closed instead of exposing anything', () => {
    expect(() =>
      resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: 'reverse-tunnel' }, DEPLOYMENT)
    ).toThrow(/Unsupported VM_AGENT_TRANSPORT/);
  });

  it.each([null, 'cloudflare-tunnel', 'reverse-tunnel'])(
    'points route records at the node (transport %j)',
    async (transport) => {
      await upsertReleaseRouteRecords(ROUTES, { transport, ipAddress: NODE_IP }, {} as Env);
      expect(upserts).toEqual([{ hostname: ROUTES[0]!.hostname, ip: NODE_IP }]);
    }
  );
});

describe('box installation (reverse-tunnel extension installed): convergence', () => {
  beforeEach(() => {
    installReverseTunnelTransport(generateCloudInit);
  });

  it('selects the tunnel for deployment and workspace nodes alike', () => {
    const env = { VM_AGENT_TRANSPORT: 'reverse-tunnel' } as Pick<Env, 'VM_AGENT_TRANSPORT'>;
    expect(resolveManagedNodeTransport(env, DEPLOYMENT)).toBe('reverse-tunnel');
    expect(resolveManagedNodeTransport(env, { ...DEPLOYMENT, nodeRole: 'workspace' })).toBe(
      'reverse-tunnel'
    );
    // Not every node: Instant containers and user-owned machines stay off the tunnel.
    expect(resolveManagedNodeTransport(env, { ...DEPLOYMENT, runtime: 'cf-container' })).toBeNull();
    expect(resolveManagedNodeTransport(env, { ...DEPLOYMENT, nodeClass: 'user-owned' })).toBeNull();
  });

  it('points route records at the box with DNS on the box, even with no node IP', async () => {
    const env = {
      SAM_DNS_PROVIDER: 'box',
      SAM_DNS_PUBLIC_IPV4: BOX_IP,
      DATABASE: {},
    } as unknown as Env;
    await upsertReleaseRouteRecords(ROUTES, { transport: 'reverse-tunnel', ipAddress: null }, env);
    expect(upserts).toEqual([{ hostname: ROUTES[0]!.hostname, ip: BOX_IP }]);
  });

  it('writes nothing without DNS on the box (the operator wildcard covers *.apps)', async () => {
    await upsertReleaseRouteRecords(ROUTES, { transport: 'reverse-tunnel', ipAddress: NODE_IP }, {
      DATABASE: {},
    } as unknown as Env);
    expect(upserts).toEqual([]);
  });

  it('fails closed when DNS is on the box but its address is missing', async () => {
    const env = { SAM_DNS_PROVIDER: 'box', DATABASE: {} } as unknown as Env;
    await expect(
      upsertReleaseRouteRecords(ROUTES, { transport: 'reverse-tunnel', ipAddress: NODE_IP }, env)
    ).rejects.toThrow(/SAM_DNS_PUBLIC_IPV4/);
    expect(upserts).toEqual([]);
  });
});
