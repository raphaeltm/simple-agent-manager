import { describe, expect, it } from 'vitest';

import {
  deriveReverseTunnelCredential,
  getReverseTunnelGatewaySecret,
  hashReverseTunnelCredential,
  resolveReverseTunnelHeartbeatTimeoutSeconds,
  resolveReverseTunnelPortRange,
  resolveReverseTunnelPortReuseMinAgeSeconds,
} from '../../../src/services/node-reverse-tunnel-config';
import { resolveManagedNodeTransport } from '../../../src/services/node-tunnel-config';

const managedVm = { nodeRole: 'workspace', runtime: 'vm', nodeClass: 'managed' };

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

  it('control: cloudflare-tunnel still gives a deployment node the tunnel (#2646)', () => {
    expect(
      resolveManagedNodeTransport(
        { VM_AGENT_TRANSPORT: 'cloudflare-tunnel' },
        { ...managedVm, nodeRole: 'deployment' }
      )
    ).toBe('cloudflare-tunnel');
  });

  it.each(['reverse_tunnel', 'frp', 'Reverse-Tunnel'])('fails closed on %j', (value) => {
    expect(() => resolveManagedNodeTransport({ VM_AGENT_TRANSPORT: value }, managedVm)).toThrow(
      /Unsupported VM_AGENT_TRANSPORT/
    );
  });

  it.each([
    ['a deployment node', { ...managedVm, nodeRole: 'deployment' }],
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

describe('heartbeat timeout and port reuse age', () => {
  it('default to 90 s and 2 x 90 s', () => {
    expect(resolveReverseTunnelHeartbeatTimeoutSeconds({})).toBe(90);
    expect(resolveReverseTunnelPortReuseMinAgeSeconds({})).toBe(180);
  });

  it('derive the reuse age from a configured heartbeat timeout', () => {
    const env = { REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: ' 150 ' };
    expect(resolveReverseTunnelHeartbeatTimeoutSeconds(env)).toBe(150);
    expect(resolveReverseTunnelPortReuseMinAgeSeconds(env)).toBe(300);
  });

  it.each(['59', '3601', 'abc', '1.5', '-1', '90s'])(
    'refuse heartbeat timeout %j (fail closed: no lease)',
    (value) => {
      const env = { REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: value };
      expect(() => resolveReverseTunnelHeartbeatTimeoutSeconds(env)).toThrow(/60-3600/);
      expect(() => resolveReverseTunnelPortReuseMinAgeSeconds(env)).toThrow(/60-3600/);
    }
  );

  it('accept a longer reuse age and refuse one below the floor or malformed', () => {
    expect(
      resolveReverseTunnelPortReuseMinAgeSeconds({
        REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: '600',
      })
    ).toBe(600);
    expect(() =>
      resolveReverseTunnelPortReuseMinAgeSeconds({
        REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: '179',
      })
    ).toThrow(/at least 180/);
    expect(() =>
      resolveReverseTunnelPortReuseMinAgeSeconds({
        REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS: '120',
        REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: '200',
      })
    ).toThrow(/at least 240/);
    for (const value of ['86401', 'x', '1e3']) {
      expect(() =>
        resolveReverseTunnelPortReuseMinAgeSeconds({
          REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS: value,
        })
      ).toThrow(/REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS/);
    }
  });
});
