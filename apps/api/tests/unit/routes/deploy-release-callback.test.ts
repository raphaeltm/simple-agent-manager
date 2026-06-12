import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mockLimit = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: mockLimit }),
        innerJoin: () => ({
          where: () => ({ limit: mockLimit }),
        }),
      }),
    }),
  }),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn().mockResolvedValue({
    workspace: 'node-deploy-1',
    type: 'callback',
    scope: 'node',
  }),
}));

vi.mock('../../../src/services/deploy-signing', () => ({
  signDeployPayload: vi.fn().mockResolvedValue('signed-payload'),
}));

const { deployReleaseCallbackRoute } = await import('../../../src/routes/deploy-release-callback');

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/nodes', deployReleaseCallbackRoute);
  return app;
}

function manifest() {
  return {
    version: 1,
    services: {
      web: {
        image: { registry: 'docker.io', repository: 'example/web', digest: `sha256:${'a'.repeat(64)}` },
        env: {},
        volumes: [],
      },
      worker: {
        image: { registry: 'docker.io', repository: 'example/worker', digest: `sha256:${'b'.repeat(64)}` },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: [
      { service: 'web', port: 3000, mode: 'public' },
      { service: 'worker', port: 9000, mode: 'private' },
      { service: 'web', port: 3001, mode: 'public' },
    ],
  };
}

function env(): Env {
  return {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'sammy.party',
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
    DNS_TTL_SECONDS: '120',
    DEPLOYMENT_ROUTE_PORT_BASE: '36000',
    DEPLOYMENT_ROUTE_PORT_SPAN: '10',
    DEPLOY_SIGNING_PRIVATE_KEY: 'test-private-key',
  } as Env;
}

describe('deploy release callback route', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    vi.unstubAllGlobals();
  });

  it('returns signed route targets, publishes loopback Compose ports, and creates grey-cloud DNS records', async () => {
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1' }])
      .mockResolvedValueOnce([{ id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7 }]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-r1' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-r2' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env(),
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.routes).toEqual([
      {
        hostname: 'r1-web-3000-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3000,
        hostPort: 36000,
      },
      {
        hostname: 'r2-web-3001-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3001,
        hostPort: 36001,
      },
    ]);
    expect(body.composeYaml).toContain('127.0.0.1:36000:3000');
    expect(body.composeYaml).toContain('127.0.0.1:36001:3001');
    expect(body.composeYaml).not.toContain('9000');
    expect(body.signature).toEqual(expect.any(String));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, firstCreate] = fetchMock.mock.calls[2]!;
    const [, secondCreate] = fetchMock.mock.calls[3]!;
    expect(JSON.parse(firstCreate.body)).toMatchObject({
      name: 'r1-web-3000-env-1.apps.sammy.party',
      content: '203.0.113.10',
      ttl: 120,
      proxied: false,
    });
    expect(JSON.parse(secondCreate.body)).toMatchObject({
      name: 'r2-web-3001-env-1.apps.sammy.party',
      content: '203.0.113.10',
      proxied: false,
    });
  });
});
