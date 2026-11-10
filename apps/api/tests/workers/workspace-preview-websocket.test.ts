import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

// The ordinary Node Response implementation cannot represent a 101 upgrade.
// Exercise the real entry point, D1 routing, JWT issuance and workerd sockets.
afterEach(() => vi.unstubAllGlobals());

describe('workspace preview WebSocket forwarding', () => {
  it.each(['vm', 'cf-container'] as const)(
    'preserves %s text/binary upgrades while stripping app cookies',
    async (runtime) => {
      const workspaceId =
        runtime === 'vm' ? '01KR1000000000000000000001' : '01KR1000000000000000000002';
      const nodeId = `preview-ws-${runtime}`;
      const userId = `preview-ws-user-${runtime}`;
      await seedUser(userId);
      await seedNode(nodeId, userId, { status: 'running' });
      await seedWorkspace(workspaceId, nodeId, userId);
      await env.DATABASE.prepare('UPDATE nodes SET runtime = ? WHERE id = ?')
        .bind(runtime, nodeId)
        .run();
      await env.DATABASE.prepare('UPDATE workspaces SET ports_public_enabled = 1 WHERE id = ?')
        .bind(workspaceId)
        .run();

      const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        expect(url.pathname).toBe(`/workspaces/${workspaceId}/ports/3000/hmr`);
        expect(url.searchParams.get('revision')).toBe('2');
        expect(url.searchParams.get('token')).toBeTruthy();
        expect(request.headers.get('upgrade')).toBe('websocket');
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].addEventListener('message', (event) => pair[1].send(event.data));
        pair[1].addEventListener('close', () => pair[1].close());
        return new Response(null, {
          status: 101,
          headers: {
            'Set-Cookie': 'sam_port_access=untrusted-app-cookie',
            'Sec-WebSocket-Protocol': 'vite-hmr',
          },
          webSocket: pair[0],
        });
      });
      vi.stubGlobal('fetch', upstream);
      const testEnv: Env = {
        ...env,
        CF_CONTAINER_ENABLED: 'true',
        ...(runtime === 'cf-container'
          ? {
              VM_AGENT_CONTAINER: {
                idFromName: () => nodeId,
                get: () => ({ fetch: upstream }),
              } as unknown as Env['VM_AGENT_CONTAINER'],
            }
          : {}),
      };
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request(
          `https://ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}/hmr?revision=2`,
          {
            headers: {
              Upgrade: 'websocket',
              Connection: 'Upgrade',
              'Sec-WebSocket-Protocol': 'vite-hmr',
            },
          }
        ),
        testEnv,
        context
      );
      expect(response.status).toBe(101);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('sec-websocket-protocol')).toBe('vite-hmr');
      const client = response.webSocket!;
      expect(client).toBeTruthy();
      client.accept();
      const receive = () =>
        new Promise<string | ArrayBuffer>((resolve) => {
          client.addEventListener('message', (event) => resolve(event.data), { once: true });
        });
      try {
        const text = receive();
        client.send('hmr-update');
        expect(await text).toBe('hmr-update');
        const binary = receive();
        client.send(new Uint8Array([0, 1, 255]));
        expect(new Uint8Array((await binary) as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 255]));
      } finally {
        client.close(1000);
        await waitOnExecutionContext(context);
      }
      expect(upstream).toHaveBeenCalledTimes(1);
    }
  );
});
