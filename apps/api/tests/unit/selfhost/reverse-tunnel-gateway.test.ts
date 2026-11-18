import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';
import type { ReverseTunnelEnv } from '../../../src/selfhost/reverse-tunnel/env';
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
  it.each([
    [new Error('private upstream detail'), 500, 'INTERNAL_ERROR'],
    [new AppError(503, 'NODE_UNREACHABLE', 'No active route'), 503, 'NODE_UNREACHABLE'],
  ] as const)(
    'returns structured errors when redispatch throws (%s)',
    async (error, status, code) => {
      const routes = createSelfHostGatewayRoutes(async () => {
        throw error;
      });
      const response = await routes.fetch(
        new Request('http://api.example.test/api/self-host/gateway/node-websocket', {
          headers: {
            'X-SAM-Gateway-Secret': SECRET,
            'X-SAM-Gateway-Original-Host': 'ws-01krrtx0000000000000000000.example.test',
            'X-Forwarded-Uri': '/agent/ws',
            'X-Forwarded-Method': 'GET',
            Upgrade: 'websocket',
          },
        }),
        env,
        ctx
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toMatchObject({
        error: code,
        message: status === 500 ? 'Internal server error' : 'No active route',
      });
      expect(response.headers.get('X-SAM-Upstream')).toBeNull();
    }
  );

  it('returns a sanitized JSON failure when the frps lease lookup throws', async () => {
    const prepare = vi.fn(() => {
      throw new Error('private database detail');
    });
    const response = await createSelfHostGatewayRoutes(async () => new Response('unused')).fetch(
      new Request('http://api.example.test/api/self-host/gateway/frps-plugin?op=Login', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`frps:${SECRET}`)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: {
            user: 'node-a',
            metas: {
              node_id: 'node-a',
              incarnation: 'incarnation-a',
              credential: 'fixture-credential',
            },
          },
        }),
      }),
      { ...env, DATABASE: { prepare } } as unknown as ReverseTunnelEnv,
      ctx
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

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
