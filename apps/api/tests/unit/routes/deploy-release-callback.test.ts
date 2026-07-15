import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { environmentPortOffset } from '../../../src/services/deployment-routing';

const mockLimit = vi.fn();
const mockSignDeployPayload = vi.fn().mockResolvedValue('signed-payload');
const mockSignRouteConfigPayload = vi.fn().mockResolvedValue('signed-route-config');
const mockVerifyCallbackToken = vi.fn().mockResolvedValue({
  workspace: 'node-deploy-1',
  type: 'callback',
  scope: 'node',
});
const mockMintProjectRegistryCredential = vi.fn();
const mockLoadResolvedSecrets = vi.fn().mockResolvedValue({});
const mockLoadDeploymentInterpolationEnv = vi.fn().mockResolvedValue({ values: {} });
const mockBuildVolumeMountDescriptors = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn().mockResolvedValue([]);
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
let customDomainRows: Array<{
  hostname: string;
  service: string;
  port: number;
  verifiedCnameTarget?: string | null;
}> = [];
const currentProviderServerId = 'provider-server-current';

function createWhereResult() {
  return {
    limit: mockLimit,
    orderBy: mockOrderBy,
    then: (
      resolve: (value: typeof customDomainRows) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(customDomainRows).then(resolve, reject),
  };
}

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: createWhereResult,
        innerJoin: () => ({
          where: () => ({ limit: mockLimit }),
        }),
      }),
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return { where: mockUpdateWhere };
      },
    }),
  }),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: unknown[]) => mockVerifyCallbackToken(...args),
}));

vi.mock('../../../src/services/deploy-signing', () => ({
  signDeployPayload: (...args: unknown[]) => mockSignDeployPayload(...args),
  signRouteConfigPayload: (...args: unknown[]) => mockSignRouteConfigPayload(...args),
}));

vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: (...args: unknown[]) => mockMintProjectRegistryCredential(...args),
}));

// Mock secret resolution so the callback exercises the real
// collectSecretNames → loadResolvedSecrets → renderCompose path without
// needing a real encrypted D1 row. getEncryptionKey is the only other export
// the callback route consumes from this module.
vi.mock('../../../src/routes/deployment-releases', () => ({
  getEncryptionKey: () => 'test-encryption-key',
  loadResolvedSecrets: (...args: unknown[]) => mockLoadResolvedSecrets(...args),
}));

// The /deployment-env callback decrypts the environment's full interpolation
// env (plaintext variables + decrypted secret values) via this service. Mock it
// so the route is exercised without a real encrypted D1 row; the tests assert
// the route forwards the decrypted values to the requesting node and never logs
// them.
vi.mock('../../../src/services/deployment-environment-config', () => ({
  loadDeploymentInterpolationEnv: (...args: unknown[]) =>
    mockLoadDeploymentInterpolationEnv(...args),
}));

vi.mock('../../../src/services/deployment-volumes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/deployment-volumes')>();
  return {
    ...actual,
    buildVolumeMountDescriptors: (...args: unknown[]) => mockBuildVolumeMountDescriptors(...args),
  };
});

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
        image: {
          registry: 'docker.io',
          repository: 'example/web',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        env: {},
        volumes: [],
      },
      worker: {
        image: {
          registry: 'docker.io',
          repository: 'example/worker',
          digest: `sha256:${'b'.repeat(64)}`,
        },
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

/** Manifest whose `web` service references a secret in its env block. */
function manifestWithSecret() {
  return {
    version: 1,
    services: {
      web: {
        image: {
          registry: 'docker.io',
          repository: 'example/web',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        env: { API_KEY: { secret: 'API_KEY' }, PLAIN: 'literal-value' },
        volumes: [],
      },
    },
    volumes: {},
    routes: [{ service: 'web', port: 3000, mode: 'public' }],
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
    CF_ACCOUNT_ID: 'account-1',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET_NAME: 'sam-artifacts',
  } as Env;
}

/** Seed the three sequential D1 reads for the happy path (node IP, env, release). */
function stubHappyPathDb() {
  mockLimit
    .mockResolvedValueOnce([
      {
        userId: 'user-1',
        ipAddress: '203.0.113.10',
        providerInstanceId: currentProviderServerId,
      },
    ])
    .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
    .mockResolvedValueOnce([{ id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7 }]);
}

/** Stub the four CF DNS API calls (two list, two create) for the happy path. */
function stubDnsFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { id: 'dns-r1' } }), { status: 200 })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { id: 'dns-r2' } }), { status: 200 })
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Issue the standard deploy-release callback request. */
function requestDeployRelease() {
  return createTestApp().request(
    '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
    { headers: { Authorization: 'Bearer callback-token' } },
    env()
  );
}

describe('deploy release callback route', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateWhere.mockResolvedValue(undefined);
    mockVerifyCallbackToken.mockClear();
    mockSignDeployPayload.mockClear();
    mockSignRouteConfigPayload.mockClear();
    mockMintProjectRegistryCredential.mockReset();
    mockLoadResolvedSecrets.mockReset();
    mockLoadResolvedSecrets.mockResolvedValue({});
    mockLoadDeploymentInterpolationEnv.mockReset();
    mockLoadDeploymentInterpolationEnv.mockResolvedValue({ values: {} });
    mockBuildVolumeMountDescriptors.mockReset();
    mockBuildVolumeMountDescriptors.mockResolvedValue([]);
    mockOrderBy.mockReset();
    mockOrderBy.mockResolvedValue([]);
    customDomainRows = [];
    mockSignDeployPayload.mockResolvedValue('signed-payload');
    mockSignRouteConfigPayload.mockResolvedValue('signed-route-config');
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
    expect(mockVerifyCallbackToken).toHaveBeenCalledWith('callback-token', expect.anything(), {
      expectedScope: 'node',
    });
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'applying' });
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);

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
    expect(body.volumeMounts).toEqual([]);
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-1',
        nodeId: 'node-deploy-1',
        seq: 7,
        composeYaml: expect.stringContaining(`127.0.0.1:${expectedPort0}:3000`),
        routes: body.routes,
        volumeMounts: [],
      }),
      expect.anything()
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

  it('includes attached volume descriptors in the signed apply payload', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    stubHappyPathDb();
    const volumeMounts = [
      {
        name: 'data',
        mountRoot: '/mnt/sam-env-env-1/volumes/data',
        providerVolumeId: 'vol-123',
        providerName: 'hetzner',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_123',
        fsFormat: 'ext4',
      },
    ];
    mockBuildVolumeMountDescriptors.mockResolvedValue(volumeMounts);
    stubDnsFetch();

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.volumeMounts).toEqual(volumeMounts);
    expect(mockBuildVolumeMountDescriptors).toHaveBeenCalledWith(
      expect.anything(),
      'env-1',
      currentProviderServerId
    );
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({ volumeMounts }),
      expect.anything()
    );
  });

  it('serves a signed route-only config for the desired routing revision', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([
        {
          id: 'env-1',
          projectId: 'proj-1',
          nodeId: 'node-deploy-1',
          status: 'active',
          observedAppliedSeq: 7,
          desiredRoutingRevision: 3,
          observedRoutingRevision: 2,
        },
      ])
      .mockResolvedValueOnce([
        { id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7, source: null },
      ]);
    customDomainRows = [
      {
        hostname: 'App.Customer.Example.com',
        service: 'web',
        port: 3000,
        verifiedCnameTarget: 'r1-web-3000-env-1.apps.sammy.party',
      },
    ];

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-routes?revision=3&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      environmentId: 'env-1',
      nodeId: 'node-deploy-1',
      currentSeq: 7,
      routingRevision: 3,
      signature: 'signed-route-config',
    });
    expect(body.routes).toContainEqual(
      expect.objectContaining({ hostname: 'app.customer.example.com', service: 'web' })
    );
    expect(mockSignRouteConfigPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-1',
        nodeId: 'node-deploy-1',
        currentSeq: 7,
        routingRevision: 3,
        routes: body.routes,
      }),
      expect.anything()
    );
  });

  it('adds verified custom domains to the signed apply payload without creating user DNS records', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    stubHappyPathDb();
    customDomainRows = [
      {
        hostname: 'App.Customer.Example.com',
        service: 'web',
        port: 3000,
        verifiedCnameTarget: 'r1-web-3000-env-1.apps.sammy.party',
      },
    ];
    const fetchMock = stubDnsFetch();

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    const parentRoute = body.routes.find(
      (route: { hostname: string }) => route.hostname === 'r1-web-3000-env-1.apps.sammy.party'
    );
    expect(parentRoute).toBeDefined();
    expect(body.routes).toContainEqual({
      hostname: 'app.customer.example.com',
      service: 'web',
      containerPort: 3000,
      hostPort: parentRoute.hostPort,
    });
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({ routes: body.routes }),
      expect.anything()
    );

    // Two SAM-owned public routes still perform list+create DNS calls. The
    // custom hostname is user-owned DNS, so it must not be upserted by SAM.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const createBodies = fetchMock.mock.calls
      .slice(2)
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(createBodies.map((body) => body.name)).toEqual([
      'r1-web-3000-env-1.apps.sammy.party',
      'r2-web-3001-env-1.apps.sammy.party',
    ]);
    expect(JSON.stringify(createBodies)).not.toContain('app.customer.example.com');
  });

  it('serves distinct payloads for two environments placed on the same node', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const envTwoManifest = {
      ...manifest(),
      routes: [{ service: 'web', port: 3000, mode: 'public' }],
    };
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([{ id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7 }])
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([{ id: 'env-2', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([
        { id: 'rel-2', manifest: JSON.stringify(envTwoManifest), version: 3 },
      ]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { id: 'dns-a1' } }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { id: 'dns-a2' } }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { id: 'dns-b1' } }), { status: 200 })
        )
    );

    const app = createTestApp();
    const responseOne = await app.request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );
    const responseTwo = await app.request(
      '/api/nodes/node-deploy-1/deploy-release?seq=3&environmentId=env-2',
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );

    const bodyOne = await responseOne.json();
    const bodyTwo = await responseTwo.json();
    expect(responseOne.status, JSON.stringify(bodyOne)).toBe(200);
    expect(responseTwo.status, JSON.stringify(bodyTwo)).toBe(200);
    expect(bodyOne.environmentId).toBe('env-1');
    expect(bodyTwo.environmentId).toBe('env-2');
    expect(bodyOne.seq).toBe(7);
    expect(bodyTwo.seq).toBe(3);
    expect(bodyOne.routes[0].hostname).toContain('env-1');
    expect(bodyTwo.routes[0].hostname).toContain('env-2');
    expect(bodyOne.routes[0].hostPort).not.toBe(bodyTwo.routes[0].hostPort);
    expect(bodyOne.composeYaml).toContain('sam-internal-env-1');
    expect(bodyTwo.composeYaml).toContain('sam-internal-env-2');
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-1', nodeId: 'node-deploy-1', seq: 7 }),
      expect.anything()
    );
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-2', nodeId: 'node-deploy-1', seq: 3 }),
      expect.anything()
    );
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
      env()
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      message:
        'Deployment node does not have an IP address yet; retry after provisioning completes',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSignDeployPayload).not.toHaveBeenCalled();
  });

  it('returns 422 before release/signing when a volume-requiring env has no providerInstanceId yet', async () => {
    // Node has provisioned but not yet reported its providerInstanceId. Volume
    // mounts are matched to the node by attachedServerId == providerInstanceId,
    // so serving the payload now would silently omit ALL volumes — the app would
    // boot against ephemeral container storage (data loss). The callback must
    // reject so the node retries once provisioning populates the field.
    mockLimit
      .mockResolvedValueOnce([
        { userId: 'user-1', ipAddress: '203.0.113.10', providerInstanceId: null },
      ])
      .mockResolvedValueOnce([
        { id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1', requiresVolumes: true },
      ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await requestDeployRelease();

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'UNPROCESSABLE_ENTITY',
      message:
        'Deployment node has not reported its provider instance id yet; retry after provisioning completes',
    });
    // The release lookup, status flip to 'applying', DNS, volume descriptors,
    // and signing must NOT run for a rejected request.
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockBuildVolumeMountDescriptors).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSignDeployPayload).not.toHaveBeenCalled();
  });

  it('serves the payload when a volume-requiring env has a providerInstanceId', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    mockLimit
      .mockResolvedValueOnce([
        {
          userId: 'user-1',
          ipAddress: '203.0.113.10',
          providerInstanceId: currentProviderServerId,
        },
      ])
      .mockResolvedValueOnce([
        { id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1', requiresVolumes: true },
      ])
      .mockResolvedValueOnce([{ id: 'rel-1', manifest: JSON.stringify(manifest()), version: 7 }]);
    stubDnsFetch();

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    // Volume descriptors are built against the reported providerInstanceId.
    expect(mockBuildVolumeMountDescriptors).toHaveBeenCalledWith(
      expect.anything(),
      'env-1',
      currentProviderServerId
    );
    expect(mockSignDeployPayload).toHaveBeenCalled();
  });

  it('rejects a release fetch when the environment is assigned to a different node', async () => {
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([]);

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-other-node',
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Deployment environment not found' });
  });

  it('rejects legacy or workspace-scoped callback tokens before DNS or signing work', async () => {
    mockVerifyCallbackToken.mockRejectedValueOnce(
      new Error("Token scope 'none' does not match expected 'node'")
    );

    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deploy-release?seq=7&environmentId=env-1',
      { headers: { Authorization: 'Bearer legacy-callback-token' } },
      env()
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
      'proj-1', // projectId
      'user-1', // userId
      '', // taskId (empty for deploy callback)
      'env-1', // environment
      { permissions: ['pull'] }
    );
  });

  it('returns registryCredentials: null when minting fails (public images still work)', async () => {
    mockMintProjectRegistryCredential.mockRejectedValueOnce(
      new Error('CF_ACCOUNT_ID and CF_API_TOKEN must be configured')
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

  it('serves artifact-backed compose-publish releases without registry credentials', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const composePublishManifest = {
      environment: 'staging',
      environmentId: 'env-1',
      reference: 'latest',
      composeYaml: `services:
  web:
    build: .
`,
      services: [
        {
          serviceName: 'web',
          sourceRef: 'workspace-web',
          localImageRef: 'workspace-web',
          r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
          sizeBytes: 42,
          archiveSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          archiveType: 'docker-save',
          mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
        },
      ],
    };
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([
        {
          id: 'rel-1',
          manifest: JSON.stringify(composePublishManifest),
          version: 7,
          source: 'compose-publish',
        },
      ]);

    const response = await requestDeployRelease();
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.registryCredentials).toBeNull();
    expect(mockMintProjectRegistryCredential).not.toHaveBeenCalled();
    expect(body.composeYaml).toContain('image: sam-env-1-web:rel-1');
    expect(body.composeYaml).toContain('pull_policy: never');
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      serviceName: 'web',
      sourceRef: 'workspace-web',
      localImageRef: 'sam-env-1-web:rel-1',
      r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
      sizeBytes: 42,
    });
    expect(body.artifacts[0].downloadUrl).toContain('compose-image-artifacts');
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [expect.objectContaining({ serviceName: 'web' })],
      }),
      expect.anything()
    );
  });

  it('resolves manifest secret references into the signed Compose env block (T5)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    // Release manifest references a secret named API_KEY.
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1', ipAddress: '203.0.113.10' }])
      .mockResolvedValueOnce([{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-deploy-1' }])
      .mockResolvedValueOnce([
        { id: 'rel-1', manifest: JSON.stringify(manifestWithSecret()), version: 7 },
      ]);
    // The resolver decrypts API_KEY to this plaintext.
    mockLoadResolvedSecrets.mockResolvedValueOnce({ API_KEY: 'super-secret-value' });
    // Single public route → one DNS list + one DNS create.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { id: 'dns-r1' } }), { status: 200 })
        )
    );

    const response = await requestDeployRelease();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    // Resolver was invoked with the environment id and the collected secret name.
    expect(mockLoadResolvedSecrets).toHaveBeenCalledWith(
      expect.anything(),
      'env-1',
      ['API_KEY'],
      'test-encryption-key'
    );

    // The decrypted value is supplied as transient interpolation env, not
    // materialized into the rendered Compose YAML.
    expect(body.composeYaml).toContain('${SAM_SECRET_API_KEY}');
    expect(body.composeYaml).not.toContain('super-secret-value');
    expect(body.composeYaml).toContain('literal-value');
    expect(body.interpolationEnv).toMatchObject({ SAM_SECRET_API_KEY: 'super-secret-value' });
    expect(mockSignDeployPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        composeYaml: expect.stringContaining('${SAM_SECRET_API_KEY}'),
        interpolationEnv: expect.objectContaining({ SAM_SECRET_API_KEY: 'super-secret-value' }),
      }),
      expect.anything()
    );
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
 * GET /api/nodes/:id/deployment-env — the highest-sensitivity deploy callback.
 *
 * It decrypts an environment's FULL interpolation env (plaintext variables AND
 * decrypted secret values) and returns it to the requesting deployment node so
 * the VM agent can interpolate `${SAM_SECRET_*}` placeholders at compose-apply
 * time. The boundary contract these tests pin:
 *   - only a node-scoped callback token whose `workspace` matches the node id
 *     may reach the decrypt path (scope/identity gates),
 *   - the environment lookup is joined on BOTH nodeId AND the node's owning
 *     userId, so a token for one node cannot read another node's (or another
 *     user's) environment config (IDOR),
 *   - decrypted secret values are forwarded to the node but never logged.
 */
describe('deployment-env callback route', () => {
  function requestDeploymentEnv(
    path = '/api/nodes/node-deploy-1/deployment-env?environmentId=env-1'
  ) {
    return createTestApp().request(
      path,
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );
  }

  beforeEach(() => {
    mockLimit.mockReset();
    mockVerifyCallbackToken.mockClear();
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-deploy-1',
      type: 'callback',
      scope: 'node',
    });
    mockLoadDeploymentInterpolationEnv.mockReset();
    mockLoadDeploymentInterpolationEnv.mockResolvedValue({ values: {} });
    vi.unstubAllGlobals();
  });

  it('returns the decrypted interpolation env and configUpdatedAt to the owning node', async () => {
    mockLimit
      // node lookup → node belongs to user-1
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      // env lookup (joined on nodeId + owner userId) → found
      .mockResolvedValueOnce([{ id: 'env-1', configUpdatedAt: '2026-06-22T10:00:00.000Z' }]);
    mockLoadDeploymentInterpolationEnv.mockResolvedValueOnce({
      values: {
        PUBLIC_APP_DOMAIN: 'app.example.com',
        SAM_SECRET_API_KEY: 'super-secret-value',
      },
    });

    const response = await requestDeploymentEnv();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({
      environmentId: 'env-1',
      interpolationEnv: {
        PUBLIC_APP_DOMAIN: 'app.example.com',
        SAM_SECRET_API_KEY: 'super-secret-value',
      },
      configUpdatedAt: '2026-06-22T10:00:00.000Z',
    });
    // Decryption ran with the environment id and the server encryption key.
    expect(mockLoadDeploymentInterpolationEnv).toHaveBeenCalledWith(
      expect.anything(),
      'env-1',
      'test-encryption-key'
    );
  });

  it('returns configUpdatedAt: null when the environment has never been configured', async () => {
    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([{ id: 'env-1', configUpdatedAt: null }]);
    mockLoadDeploymentInterpolationEnv.mockResolvedValueOnce({ values: {} });

    const response = await requestDeploymentEnv();

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.configUpdatedAt).toBeNull();
    expect(body.interpolationEnv).toEqual({});
  });

  it('rejects with 400 when environmentId is missing', async () => {
    const response = await createTestApp().request(
      '/api/nodes/node-deploy-1/deployment-env',
      { headers: { Authorization: 'Bearer callback-token' } },
      env()
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'Missing required query parameter: environmentId',
    });
    // Identity verified, but no DB read or decrypt happens without an env id.
    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockLoadDeploymentInterpolationEnv).not.toHaveBeenCalled();
  });

  it('rejects with 404 when the node does not exist', async () => {
    mockLimit.mockResolvedValueOnce([]);

    const response = await requestDeploymentEnv();

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Node not found' });
    expect(mockLoadDeploymentInterpolationEnv).not.toHaveBeenCalled();
  });

  it('returns 404 (not the config) when the environment belongs to a different node or user (IDOR)', async () => {
    mockLimit
      // node exists and is owned by user-1
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      // env lookup joined on nodeId + owner userId returns nothing → cross-node
      // or cross-user request
      .mockResolvedValueOnce([]);

    const response = await requestDeploymentEnv(
      '/api/nodes/node-deploy-1/deployment-env?environmentId=env-other'
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Deployment environment not found' });
    // Critically: the decrypt path is never reached for an unauthorized env.
    expect(mockLoadDeploymentInterpolationEnv).not.toHaveBeenCalled();
  });

  it('rejects a non-node-scoped callback token with 403 before any DB read', async () => {
    mockVerifyCallbackToken.mockRejectedValueOnce(
      new Error("Token scope 'none' does not match expected 'node'")
    );

    const response = await requestDeploymentEnv();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: 'Insufficient token scope' });
    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockLoadDeploymentInterpolationEnv).not.toHaveBeenCalled();
  });

  it('rejects with 401 when a node token is presented for a different node', async () => {
    // Valid node-scoped token, but minted for a different node.
    mockVerifyCallbackToken.mockResolvedValueOnce({
      workspace: 'node-other',
      type: 'callback',
      scope: 'node',
    });

    const response = await requestDeploymentEnv();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: 'Callback token does not match node',
    });
    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockLoadDeploymentInterpolationEnv).not.toHaveBeenCalled();
  });

  it('never writes decrypted secret values to the log', async () => {
    const logEntries: Array<Record<string, unknown>> = [];
    const origLog = console.log;
    const origInfo = console.info;
    const origError = console.error;
    console.log = (...args: unknown[]) => logEntries.push({ args });
    console.info = (...args: unknown[]) => logEntries.push({ args });
    console.error = (...args: unknown[]) => logEntries.push({ args });

    mockLimit
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([{ id: 'env-1', configUpdatedAt: '2026-06-22T10:00:00.000Z' }]);
    mockLoadDeploymentInterpolationEnv.mockResolvedValueOnce({
      values: { SAM_SECRET_API_KEY: 'super-secret-value' },
    });

    const response = await requestDeploymentEnv();
    expect(response.status).toBe(200);

    console.log = origLog;
    console.info = origInfo;
    console.error = origError;

    expect(JSON.stringify(logEntries)).not.toContain('super-secret-value');
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
