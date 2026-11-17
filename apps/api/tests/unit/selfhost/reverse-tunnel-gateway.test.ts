import { describe, expect, it, vi } from 'vitest';

import {
  createSelfHostGatewayRoutes,
  frpsPluginReply,
} from '../../../src/selfhost/reverse-tunnel/gateway';
import { isGatewayAuthorizationRequest } from '../../../src/services/node-websocket-gateway';

/** The re-dispatched request carries only what the normal handler would see from a client. */
const SECRET = ['gateway', 'fixture', 'value', 'for', 'unit', 'tests', 'only'].join('-');
const env = { BASE_DOMAIN: 'example.test', REVERSE_TUNNEL_GATEWAY_SECRET: SECRET };
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

describe('node-websocket forward_auth re-dispatch', () => {
  it('drops gateway inputs and client-address headers, and marks the inner request', async () => {
    let inner: Request | undefined;
    const routes = createSelfHostGatewayRoutes(async (request) => {
      inner = request;
      return new Response('refused', { status: 401 });
    });
    const response = await routes.fetch(
      new Request('http://api.example.test/api/self-host/gateway/node-websocket', {
        headers: {
          'X-SAM-Gateway-Secret': SECRET,
          'X-SAM-Gateway-Original-Host': 'ws-01krrtx0000000000000000000.example.test',
          'X-Forwarded-Host': 'api.example.test',
          'X-Forwarded-Uri': '/agent/ws?x=1',
          'X-Forwarded-Method': 'GET',
          Upgrade: 'websocket',
          Cookie: 'session=abc',
          'CF-Connecting-IP': '203.0.113.9',
          'X-Forwarded-For': '203.0.113.9',
          'X-Real-IP': '203.0.113.9',
        },
      }),
      env,
      ctx
    );
    expect(response.status).toBe(401);
    expect(inner?.url).toBe('https://ws-01krrtx0000000000000000000.example.test/agent/ws?x=1');
    expect(isGatewayAuthorizationRequest(inner!)).toBe(true);
    const headers = inner!.headers;
    for (const name of [
      'x-sam-gateway-secret',
      'x-sam-gateway-original-host',
      'x-forwarded-host',
      'x-forwarded-uri',
      'cf-connecting-ip',
      'x-forwarded-for',
      'x-real-ip',
    ]) {
      expect(headers.get(name), name).toBeNull();
    }
    // Liveness: the client's own credentials still reach the unchanged auth path.
    expect(headers.get('cookie')).toBe('session=abc');
    expect(headers.get('upgrade')).toBe('websocket');
  });
});

describe('frpsPluginReply', () => {
  it('applies a replacement only with unchange:false, and leaves every other allow unchanged', async () => {
    const replaced = await frpsPluginReply({
      allow: true,
      replacementContent: { user: 'n', run_id: 'r' },
    }).json();
    expect(replaced).toEqual({
      reject: false,
      unchange: false,
      content: { user: 'n', run_id: 'r' },
    });
    expect(await frpsPluginReply({ allow: true }).json()).toEqual({
      reject: false,
      unchange: true,
    });
    expect(await frpsPluginReply({ allow: false, code: 'x', reason: 'no' }).json()).toEqual({
      reject: true,
      reject_reason: 'no',
    });
  });
});
