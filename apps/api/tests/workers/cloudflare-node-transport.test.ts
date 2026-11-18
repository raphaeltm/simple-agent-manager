import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../../src/index';
import { nodeTransportExtension } from '../../src/services/node-transport-extension';
import { seedNode, seedSignedInUser, seedUser, seedWorkspace } from './helpers/seed-d1';

// Deliberately import only the Cloudflare entry: installing the self-host wrapper would
// turn this into a missing-lease test instead of testing an unavailable transport driver.
afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare Worker without a self-host transport driver', () => {
  it('refuses a stored reverse-tunnel node before fetching, with a public-transport control', async () => {
    expect(nodeTransportExtension()).toBeUndefined();
    const userId = 'cf-transport-owner';
    const nodeId = 'CFTRANSPORTNODE';
    const workspaceId = '01KRRTPBNXNE00000000000000';
    await seedUser(userId);
    await seedNode(nodeId, userId, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, userId, { status: 'running' });
    const cookie = await seedSignedInUser(userId);
    const upstream = vi.fn(async () => Response.json({ cpu: { count: 2 } }));
    vi.stubGlobal('fetch', upstream);

    async function call(url: string) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(url, { headers: { Cookie: cookie } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }

    const systemInfo = `https://api.${env.BASE_DOMAIN}/api/nodes/${nodeId}/system-info`;
    const logs = `https://api.${env.BASE_DOMAIN}/api/nodes/${nodeId}/logs/stream`;
    const workspace = `https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}/transport-proof`;
    await env.DATABASE.prepare("UPDATE nodes SET transport = 'reverse-tunnel' WHERE id = ?")
      .bind(nodeId)
      .run();

    expect((await call(systemInfo)).status).toBe(503);
    for (const url of [logs, workspace]) {
      const refused = await call(url);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ error: 'NODE_UNREACHABLE' });
    }
    expect(upstream).not.toHaveBeenCalled();

    // The same authenticated resources remain routable on a Cloudflare transport.
    await env.DATABASE.prepare("UPDATE nodes SET transport = 'vm-public-dns' WHERE id = ?")
      .bind(nodeId)
      .run();
    const control = await call(systemInfo);
    expect(control.status).toBe(200);
    expect(await control.json()).toMatchObject({ cpu: { count: 2 } });
    expect((await call(workspace)).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `https://${nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:8443/system-info`
    );
  });
});
