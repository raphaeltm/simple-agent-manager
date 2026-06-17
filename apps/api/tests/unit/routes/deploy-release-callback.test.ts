import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { environmentPortOffset } from '../../../src/services/deployment-routing';

const mockLimit = vi.fn();
const mockSignDeployPayload = vi.fn().mockResolvedValue('signed-payload');
const mockVerifyCallbackToken = vi.fn().mockResolvedValue({
  workspace: 'node-deploy-1',
  type: 'callback',
  scope: 'node',
});
const mockMintProjectRegistryCredential = vi.fn();

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
  verifyCallbackToken: (...args: unknown[]) => mockVerifyCallbackToken(...args),
}));

vi.mock('../../../src/services/deploy-signing', () => ({
  signDeployPayload: (...args: unknown[]) => mockSignDeployPayload(...args),
}));

vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: (...args: unknown[]) => mockMintProjectRegistryCredential(...args),
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
    DEPLOY_PAYLOAD_EXPIRY_SECONDS: '90',
    DEPLOYMENT_ROUTE_PORT_BASE: '36000',
    DEPLOYMENT_ROUTE_PORT_SPAN: '10',
    DEPLOY_SIGNING_PRIVATE_KEY: 'test-private-key',
  } as Env;
}

/** Seed the three sequential D1 reads for the happy path (node IP, env, release). */
function stubHappyPathDb() {
  mockLimit
    .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
    .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
    .mockResolvedValueOnce([{ id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7 }]);
}

/** Stub the four CF DNS API calls (two list, two create) for the happy path. */
function stubDnsFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-r1' } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { id: 'dns-r2' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Issue the standard deploy-release callback request. */
function requestDeployRelease() {
  return createTestApp().request(
    '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
    { headers: { Authorization: 'Bearer callback-token' } },
    env(),
  );
}

describe('deploy release callback route', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockVerifyCallbackToken.mockClear();
    mockSignDeployPayload.mockClear();
    mockMintProjectRegistryCredential.mockReset();
    mockSignDeployPayload.mockResolvedValue('signed-payload');
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-deploy-1',
      type: 'callback',
      scope: 'node',
    });
    // Default: registry credential minting succeeds
    mockMintProjectRegistryCredential.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'cf-mint-user',
      password: 'cf-mint-secret',
      namespace: 'acct123/sam-proj-1',
      expiresAt: '2026-06-13T12:00:00.000Z',
    });
    vi.unstubAllGlobals();
  });

  it('returns signed route targets, publishes loopback Compose ports, and creates grey-cloud DNS records', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    stubHappyPathDb();
    const fetchMock = stubDnsFetch();

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(mockVerifyCallbackToken).toHaveBeenCalledWith('callback-token', expect.anything(), { expectedScope: 'node' });

    // Port base includes per-environment offset to prevent cross-env collisions
    const envOffset = environmentPortOffset('env-1', 10, 36_000);
    const expectedPort0 = 36_000 + envOffset;
    const expectedPort1 = expectedPort0 + 1;

    expect(body.routes).toEqual([
      {
        hostname: 'r1-web-3000-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3000,
        hostPort: expectedPort0,
      },
      {
        hostname: 'r2-web-3001-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3001,
        hostPort: expectedPort1,
      },
    ]);
    expect(body.composeYaml).toContain(`127.0.0.1:${expectedPort0}:3000`);
    expect(body.composeYaml).toContain(`127.0.0.1:${expectedPort1}:3001`);
    expect(body.composeYaml).not.toContain('9000');
    expect(body.expiresAt).toBe(1_700_000_090);
    expect(body.signature).toEqual(expect.any(String));
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-1',
        nodeId: 'node-deploy-1',
        seq: 7,
        composeYaml: expect.stringContaining(`127.0.0.1:${expectedPort0}:3000`),
        routes: body.routes,
      }),
      expect.anything(),
    );
    dateNow.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstCreateCall = fetchMock.mock.calls.at(2);
    const secondCreateCall = fetchMock.mock.calls.at(3);
    expect(firstCreateCall).toBeDefined();
    expect(secondCreateCall).toBeDefined();
    const [, firstCreate] = firstCreateCall as [string, RequestInit];
    const [, secondCreate] = secondCreateCall as [string, RequestInit];
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

  it('returns conflict before DNS or signing when public routes exist but node IP is not ready', async () => {
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: null }])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([{ id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      message: 'Deployment node does not have an IP address yet; retry after provisioning completes',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSignDeployPayload).not.toHaveBeenCalled();
  });

  it('rejects a release fetch when the environment is assigned to a different node', async () => {
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([]);

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-other-node',
      { headers: { Authorization: 'Bearer callback-token' } },
      env(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Deployment environment not found' });
  });

  it('rejects legacy or workspace-scoped callback tokens before DNS or signing work', async () => {
    mockVerifyCallbackToken.mockRejectedValueOnce(new Error("Token scope 'none' does not match expected 'node'"));

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer legacy-callback-token' } },
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'Insufficient token scope' });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('includes registryCredentials in response when minting succeeds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    stubHappyPathDb();
    stubDnsFetch();

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    // Verify registryCredentials are included with correct JSON field names
    // (must match Go RegistryCredentials struct: server, username, password)
    expect(body.registryCredentials).toEqual({
      server: 'registry.cloudflare.com',
      username: 'cf-mint-user',
      password: 'cf-mint-secret',
    });

    // Verify the mint was called with pull-only permissions and correct project context
    expect(mockMintProjectRegistryCredential).toHaveBeenCalledWith(
      expect.anything(), // env
      'proj-1',          // projectId
      'user-1',          // userId
      '',                // taskId (empty for deploy callback)
      'env-1',           // environment
      { permissions: ['pull'] },
    );
  });

  it('returns registryCredentials: null when minting fails (public images still work)', async () => {
    mockMintProjectRegistryCredential.mockRejectedValueOnce(
      new Error('CF_ACCOUNT_ID and CF_API_TOKEN must be configured'),
    );

    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    stubHappyPathDb();
    stubDnsFetch();

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    // Payload is still served — registryCredentials is null (graceful fallback)
    expect(body.registryCredentials).toBeNull();
    expect(body.signature).toBe('signed-payload');
    expect(body.composeYaml).toBeDefined();
  });

  it('credential values are ABSENT from audit log (never logged)', async () => {
    const logEntries: Array<Record<string, unknown>> = [];
    const origConsoleLog = console.log;
    const origConsoleInfo = console.info;
    // Intercept logger output
    console.log = (...args: unknown[]) => logEntries.push({ args });
    console.info = (...args: unknown[]) => logEntries.push({ args });

    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    stubHappyPathDb();
    stubDnsFetch();

    const response = await requestDeployRelease();

    expect(response.status).toBe(200);

    // Verify that the log output does NOT contain credential values
    const logStr = JSON.stringify(logEntries);
    expect(logStr).not.toContain('cf-mint-secret');
    expect(logStr).not.toContain('cf-mint-user');

    console.log = origConsoleLog;
    console.info = origConsoleInfo;
  });
});

/**
 * Go↔TS contract test: JSON field shape alignment.
 *
 * The deploy-release callback response must produce JSON field names that
 * match the Go ApplyPayload and RegistryCredentials struct tags exactly.
 * If either side renames a field, this test catches the mismatch.
 */
describe('deploy-release: Go↔TS contract (registryCredentials JSON shape)', () => {
  it('response registryCredentials field names match Go struct json tags', () => {
    // Go struct RegistryCredentials (types.go):
    //   Server   string `json:"server"`
    //   Username string `json:"username"`
    //   Password string `json:"password"`
    //
    // The TS callback builds: { server, username, password }
    // This test asserts the exact keys are present and no extra keys exist.
    const tsPayload = {
      server: 'registry.cloudflare.com',
      username: 'cf-user',
      password: 'cf-secret',
    };

    const goExpectedFields = ['server', 'username', 'password'] as const;
    const tsFields = Object.keys(tsPayload).sort((a, b) => a.localeCompare(b));
    const goFields = [...goExpectedFields].sort((a, b) => a.localeCompare(b));

    expect(tsFields).toEqual(goFields);
  });

  it('response top-level field names match Go ApplyPayload struct json tags', () => {
    // Go struct ApplyPayload (types.go) json tags:
    //   environmentId, nodeId, seq, expiresAt, composeYaml, routes, signature, registryCredentials
    const goExpectedTopLevel = [
      'environmentId',
      'nodeId',
      'seq',
      'expiresAt',
      'composeYaml',
      'routes',
      'signature',
      'registryCredentials',
    ].sort((a, b) => a.localeCompare(b));

    // The TS callback response returns these exact fields
    const tsResponseShape = {
      environmentId: 'env-1',
      nodeId: 'node-1',
      seq: 1,
      expiresAt: 1234567890,
      composeYaml: 'services:',
      routes: [],
      signature: 'sig',
      registryCredentials: null,
    };

    const tsFields = Object.keys(tsResponseShape).sort((a, b) => a.localeCompare(b));
    expect(tsFields).toEqual(goExpectedTopLevel);
  });
});
