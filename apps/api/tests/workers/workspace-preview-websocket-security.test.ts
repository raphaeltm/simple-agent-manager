import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { isolatePreviewResponse } from '../../src/lib/workspace-preview-security';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

describe('workspace preview WebSocket response isolation', () => {
  it('preserves the real workerd WebSocket slot and status 101 while filtering response headers', () => {
    const pair = new WebSocketPair();
    const response = new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: {
        'Set-Cookie': 'sam_port_access=evil; Path=/',
        'Clear-Site-Data': '"cookies"',
        'X-App-Protocol': 'preview',
      },
    });

    const isolated = isolatePreviewResponse(response);

    expect(isolated.status).toBe(101);
    expect(isolated.webSocket).toBe(pair[0]);
    expect(isolated.headers.get('set-cookie')).toBeNull();
    expect(isolated.headers.get('clear-site-data')).toBeNull();
    expect(isolated.headers.get('x-app-protocol')).toBe('preview');
  });

  it('isolates a real cf-container preview WebSocket through the Worker route', async () => {
    const workspaceId = '01KR1000000000000000000001';
    const suffix = crypto.randomUUID();
    const userId = `preview-user-${suffix}`;
    const nodeId = `preview-node-${suffix}`;
    await seedUser(userId);
    await seedNode(nodeId, userId, { status: 'running' });
    await env.DATABASE.prepare("UPDATE nodes SET runtime = 'cf-container' WHERE id = ?")
      .bind(nodeId)
      .run();
    await seedWorkspace(workspaceId, nodeId, userId, { status: 'running' });
    await env.DATABASE.prepare('UPDATE workspaces SET ports_public_enabled = 1 WHERE id = ?')
      .bind(workspaceId)
      .run();

    const response = await SELF.fetch(
      `https://ws-${workspaceId}--3000.test.example.com/socket?token=client-sam-token&port_token=client-port-token&channel=app`,
      {
        headers: {
          authorization: 'Bearer app-owned-token',
          connection: 'Upgrade',
          cookie: 'sam_port_access=invalid; vm_session=shared-session; preview_theme=dark',
          upgrade: 'websocket',
        },
      }
    );

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeDefined();
    expect(response.headers.get('x-preview-observed-authorization')).toBe('Bearer app-owned-token');
    expect(response.headers.get('x-preview-observed-cookie')).toBe('preview_theme=dark');
    expect(response.headers.get('x-preview-observed-path')).toBe(
      `/workspaces/${workspaceId}/ports/3000/socket`
    );
    expect(response.headers.get('x-preview-observed-channel')).toBe('app');
    expect(response.headers.get('x-preview-client-token-leaked')).toBe('false');
    expect(response.headers.get('x-preview-port-token-leaked')).toBe('false');
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.join('\n')).toContain('preview_session=ordinary');
    expect(setCookies.join('\n')).not.toContain('sam_port_access=');
    expect(setCookies.join('\n')).not.toMatch(/Domain=/i);
    expect(response.headers.get('clear-site-data')).toBe('"cache"');
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});
