import { describe, expect, it } from 'vitest';

import {
  deriveReverseTunnelCredential,
  getReverseTunnelGatewaySecret,
  hashReverseTunnelCredential,
  resolveReverseTunnelPortRange,
} from '../../../src/services/node-reverse-tunnel-config';
import { resolveManagedNodeTransport } from '../../../src/services/node-tunnel-config';

const managedVm = { isDeploymentNode: false, runtime: 'vm', nodeClass: 'managed' };

describe('transport selection', () => {
  it('selects reverse-tunnel only when explicitly configured', () => {
    expect(resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: 'reverse-tunnel' }, managedVm)).toBe(
      'reverse-tunnel'
    );
  });

  it.each([undefined, '', ' ', 'vm-public-dns'])(
    'control: %j keeps the legacy public-DNS transport',
    (value) => {
      expect(resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: value }, managedVm)).toBeNull();
    }
  );

  it('control: cloudflare-tunnel is unchanged', () => {
    expect(
      resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: 'cloudflare-tunnel' }, managedVm)
    ).toBe('cloudflare-tunnel');
  });

  it.each(['reverse_tunnel', 'frp', 'Reverse-Tunnel'])('fails closed on %j', (value) => {
    expect(() => resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: value }, managedVm)).toThrow(
      /Unsupported VM_AGENT_TRANSPORT/
    );
  });

  it.each([
    ['a deployment node', { ...managedVm, isDeploymentNode: true }],
    ['an Instant container', { ...managedVm, runtime: 'cf-container' }],
    ['a user-owned machine', { ...managedVm, nodeClass: 'user-owned' }],
  ])('never gives %s the reverse tunnel', (_name, node) => {
    expect(resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: 'reverse-tunnel' }, node)).toBeNull();
  });
});

describe('port range', () => {
  it('defaults to 20000-29999', () => {
    expect(resolveReverseTunnelPortRange({})).toEqual({ start: 20000, end: 29999 });
  });

  it('accepts an explicit range', () => {
    expect(
      resolveReverseTunnelPortRange({
        REVERSE_TUNNEL_PORT_RANGE_START: '40000',
        REVERSE_TUNNEL_PORT_RANGE_END: '40010',
      })
    ).toEqual({ start: 40000, end: 40010 });
  });

  it.each([
    ['a privileged port', { REVERSE_TUNNEL_PORT_RANGE_START: '80' }],
    ['a non-number', { REVERSE_TUNNEL_PORT_RANGE_END: '30k' }],
    [
      'an inverted range',
      { REVERSE_TUNNEL_PORT_RANGE_START: '30000', REVERSE_TUNNEL_PORT_RANGE_END: '29000' },
    ],
    [
      'an oversized range',
      { REVERSE_TUNNEL_PORT_RANGE_START: '1024', REVERSE_TUNNEL_PORT_RANGE_END: '65535' },
    ],
  ])('fails closed on %s', (_name, env) => {
    expect(() => resolveReverseTunnelPortRange(env)).toThrow();
  });
});

describe('gateway secret and credentials', () => {
  it('treats an absent or short gateway secret as unconfigured', () => {
    expect(getReverseTunnelGatewaySecret({})).toBeNull();
    expect(
      getReverseTunnelGatewaySecret({ REVERSE_TUNNEL_GATEWAY_SECRET: 'x'.repeat(31) })
    ).toBeNull();
    expect(getReverseTunnelGatewaySecret({ REVERSE_TUNNEL_GATEWAY_SECRET: 'x'.repeat(32) })).toBe(
      'x'.repeat(32)
    );
  });

  it('derives a stable base64url credential bound to the lease identity', async () => {
    const env = { ENCRYPTION_KEY: 'k'.repeat(44) };
    const identity = { leaseId: 'l1', nodeId: 'N1', runtimeIncarnationId: 'i1' };
    const a = await deriveReverseTunnelCredential(env, identity);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await deriveReverseTunnelCredential(env, identity)).toBe(a);
    for (const other of [
      { ...identity, leaseId: 'l2' },
      { ...identity, nodeId: 'N2' },
      { ...identity, runtimeIncarnationId: 'i2' },
    ]) {
      expect(await deriveReverseTunnelCredential(env, other)).not.toBe(a);
    }
    expect(
      await deriveReverseTunnelCredential({ ENCRYPTION_KEY: 'z'.repeat(44) }, identity)
    ).not.toBe(a);
    expect(await hashReverseTunnelCredential(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
