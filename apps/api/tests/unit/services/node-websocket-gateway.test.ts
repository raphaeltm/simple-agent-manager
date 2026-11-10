/**
 * The range check where Caddy's X-SAM-Upstream is minted (gatewayDecisionResponse). The route
 * seam (nodeAgentRouteFromRow) checks the same range first, so this guard is only observable by
 * handing it a route directly: these tests pin it on its own.
 */
import { describe, expect, it } from 'vitest';

import {
  gatewayDecisionResponse,
  markGatewayAuthorizationRequest,
} from '../../../src/services/node-websocket-gateway';

const env = { REVERSE_TUNNEL_PORT_RANGE_START: '20000', REVERSE_TUNNEL_PORT_RANGE_END: '29999' };
const upstream = {
  url: new URL('http://node/agent/ws?x=1'),
  headers: new Headers({ authorization: 'Bearer t', 'x-sam-node-id': 'N' }),
};

function decide(port: number, rangeEnv: Record<string, string> = env) {
  const request = new Request('https://ws-x.example.test/agent/ws');
  markGatewayAuthorizationRequest(request);
  return gatewayDecisionResponse(
    request,
    { kind: 'reverse-tunnel', port, origin: `http://127.0.0.1:${port}` },
    upstream,
    rangeEnv
  );
}

describe('gatewayDecisionResponse lease range check', () => {
  it.each([8080, 7001, 7000, 9000, 19999, 30000])(
    'refuses to name an upstream outside the range (%i)',
    async (port) => {
      const response = decide(port);
      expect(response.status).toBe(502);
      expect(response.headers.get('X-SAM-Upstream')).toBeNull();
      expect(response.headers.get('X-SAM-Upstream-Authorization')).toBeNull();
      expect(await response.json()).toMatchObject({ error: 'GATEWAY_UNSUPPORTED_TRANSPORT' });
    }
  );

  it.each([20000, 29999])('control: names an in-range upstream (%i)', (port) => {
    const response = decide(port);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${port}`);
    expect(response.headers.get('X-SAM-Upstream-Uri')).toBe('/agent/ws?x=1');
    expect(response.headers.get('X-SAM-Upstream-Authorization')).toBe('Bearer t');
  });

  it('fails closed on a malformed range', () => {
    const response = decide(20001, { ...env, REVERSE_TUNNEL_PORT_RANGE_END: 'nope' });
    expect(response.status).toBe(502);
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
  });
});
