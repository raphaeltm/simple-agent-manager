/**
 * Behaviour of the single control-plane -> node routing decision (services/node-agent-route.ts):
 * the node row's runtime decides the Instant container path before any transport, every
 * non-reverse transport keeps its public backend hostname, and a reverse-tunnel node is routed
 * only to an in-range loopback lease port.
 */
import { describe, expect, it } from 'vitest';

import {
  NodeAgentRouteError,
  nodeAgentRouteFromRow,
  type NodeAgentRouteRow,
} from '../../../src/services/node-agent-route';

const env = {
  BASE_DOMAIN: 'example.test',
  REVERSE_TUNNEL_PORT_RANGE_START: '20000',
  REVERSE_TUNNEL_PORT_RANGE_END: '20009',
};
const row = (over: Partial<NodeAgentRouteRow>): NodeAgentRouteRow => ({
  runtime: 'vm',
  transport: null,
  leasePort: null,
  ...over,
});

describe('nodeAgentRouteFromRow', () => {
  it.each([
    ['reverse-tunnel', 20001],
    ['vm-public-dns', null],
    ['cloudflare-tunnel', null],
    [null, null],
  ] as const)(
    'routes a cf-container node to the container whatever its transport (%s)',
    (transport, leasePort) => {
      expect(
        nodeAgentRouteFromRow('NODE1', row({ runtime: 'cf-container', transport, leasePort }), env)
      ).toEqual({ kind: 'container', runtime: 'cf-container' });
    }
  );

  it.each(['vm-public-dns', 'cloudflare-tunnel', null])(
    'routes a vm node on %s to its public backend hostname',
    (transport) => {
      expect(nodeAgentRouteFromRow('NODE1', row({ transport }), env)).toEqual({
        kind: 'public',
        origin: 'https://node1.vm.example.test:8443',
      });
    }
  );

  it('routes a reverse-tunnel node to its in-range loopback lease port', () => {
    expect(
      nodeAgentRouteFromRow('NODE1', row({ transport: 'reverse-tunnel', leasePort: 20009 }), env)
    ).toEqual({ kind: 'reverse-tunnel', port: 20009, origin: 'http://127.0.0.1:20009' });
  });

  it.each([19999, 20010, 8080, 7001])(
    'refuses a reverse-tunnel lease port outside the range (%i)',
    (leasePort) => {
      expect(() =>
        nodeAgentRouteFromRow('NODE1', row({ transport: 'reverse-tunnel', leasePort }), env)
      ).toThrow(NodeAgentRouteError);
    }
  );

  it('refuses a reverse-tunnel node without a lease, and fails closed on a malformed range', () => {
    expect(() => nodeAgentRouteFromRow('NODE1', row({ transport: 'reverse-tunnel' }), env)).toThrow(
      NodeAgentRouteError
    );
    expect(() =>
      nodeAgentRouteFromRow('NODE1', row({ transport: 'reverse-tunnel', leasePort: 20001 }), {
        ...env,
        REVERSE_TUNNEL_PORT_RANGE_END: 'not-a-port',
      })
    ).toThrow(NodeAgentRouteError);
  });
});
