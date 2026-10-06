/**
 * Behavioral route tests for the deployment release provisioning trigger.
 *
 * Covers the provisioning code path inside POST /:projectId/environments/:envId/releases:
 * - First release to env without node triggers provisionDeploymentNode()
 * - Second release with existing node does NOT re-provision
 * - provisionDeploymentNode returning null still returns 201 with nodeId:null
 * - provisionDeploymentNode throwing still returns 201 (error caught)
 * - Provisioning FAILURE rolls back nodeId to NULL (Gap 7 fix)
 *
 * Tests use app.request() through the real Hono route with mocked
 * dependencies at system boundaries (D1, provisionNode).
 */
import type { ExecutionContext } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// ─── Mocks ──────────────────────────────────────────────────────────────

// Track all DB operations for realistic assertions
interface DbCall {
  op: 'select' | 'insert' | 'update' | 'delete';
  table?: string;
  values?: Record<string, unknown>;
  whereArgs?: unknown[];
}

const dbCalls: DbCall[] = [];

// State: simulates D1 rows
let envRows: Array<{
  id: string;
  projectId: string;
  nodeId: string | null;
  status: string;
  resolvedReservationJson?: string | null;
}> = [];
let releaseRows: Array<{ version: number }> = [];
/** node_mode reported for the node the environment is already linked to. */
let existingNodeMode: 'shared' | 'exclusive' = 'shared';

// Mock provisionDeploymentNode
const mockProvisionDeploymentNode = vi.fn();
const mockResolveDeploymentPlacement = vi.hoisted(() => vi.fn());
const mockFindDeploymentNodeWithCapacity = vi.hoisted(() => vi.fn());
const mockLinkEnvironmentToNode = vi.hoisted(() => vi.fn());
const mockLinkEnvironmentToLegacyNode = vi.hoisted(() => vi.fn());
const mockClaimDeploymentEnvironmentRelocation = vi.hoisted(() => vi.fn());
const mockCompleteDeploymentEnvironmentRelocation = vi.hoisted(() => vi.fn());
const mockRestoreDeploymentEnvironmentRelocation = vi.hoisted(() => vi.fn());
const mockResolveDeploymentManifestReservation = vi.hoisted(() => vi.fn());
const mockTeardownDeploymentEnvironmentOnNode = vi.hoisted(() => vi.fn());
const recordDeploymentReleaseLifecycleEventBestEffort = vi.hoisted(() =>
  vi.fn(async () => undefined)
);
vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: (...args: unknown[]) => mockProvisionDeploymentNode(...args),
  resolveDeploymentPlacement: (...args: unknown[]) => mockResolveDeploymentPlacement(...args),
  findDeploymentNodeWithCapacity: (...args: unknown[]) =>
    mockFindDeploymentNodeWithCapacity(...args),
  linkEnvironmentToNode: (...args: unknown[]) => mockLinkEnvironmentToNode(...args),
  linkEnvironmentToLegacyNode: (...args: unknown[]) => mockLinkEnvironmentToLegacyNode(...args),
  claimDeploymentEnvironmentRelocation: (...args: unknown[]) =>
    mockClaimDeploymentEnvironmentRelocation(...args),
  completeDeploymentEnvironmentRelocation: (...args: unknown[]) =>
    mockCompleteDeploymentEnvironmentRelocation(...args),
  restoreDeploymentEnvironmentRelocation: (...args: unknown[]) =>
    mockRestoreDeploymentEnvironmentRelocation(...args),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentReleaseLifecycleEventBestEffort,
}));

vi.mock('../../../src/services/deployment-volumes', () => ({
  attachEnvironmentVolumesToLinkedNode: vi.fn().mockResolvedValue([]),
  createMissingManifestVolumes: vi.fn().mockResolvedValue(undefined),
  detachEnvironmentVolumes: vi.fn().mockResolvedValue([]),
  listEnvironmentVolumes: vi.fn().mockResolvedValue([]),
  markDeploymentReleaseVolumeAttachFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/node-agent', () => ({
  teardownDeploymentEnvironmentOnNode: (...args: unknown[]) =>
    mockTeardownDeploymentEnvironmentOnNode(...args),
}));

// Mock image resolver (no-op for these tests)
vi.mock('../../../src/services/image-resolver', () => ({
  createImageResolver: () => vi.fn(),
  ImageResolveError: class extends Error {},
}));

// Mock registry credentials (no-op)
vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: vi.fn().mockRejectedValue(new Error('no registry')),
}));

// Mock encryption
vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn().mockResolvedValue('decrypted-value'),
}));

// Mock compose renderer
vi.mock('../../../src/services/compose-renderer', () => ({
  collectSecretNames: vi.fn().mockReturnValue([]),
  renderCompose: vi.fn().mockReturnValue('version: "3"\nservices:\n  web:\n    image: test'),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'release-test-id',
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ error: String(e) })),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
  requireProjectCapability: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/middleware/error', () => ({
  errors: {
    badRequest: (msg: string) =>
      Object.assign(new Error(msg), { statusCode: 400, error: 'BAD_REQUEST', message: msg }),
    notFound: (msg: string) =>
      Object.assign(new Error(msg), { statusCode: 404, error: 'NOT_FOUND', message: msg }),
    conflict: (msg: string) =>
      Object.assign(new Error(msg), { statusCode: 409, error: 'CONFLICT', message: msg }),
  },
}));

// Manifest validation passthrough
vi.mock('@simple-agent-manager/shared', () => ({
  DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS: 250,
  DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB: 256,
  DEFAULT_DEPLOYMENT_SERVICE_DISK_MB: 1024,
  validateManifest: (body: unknown) => ({
    success: true,
    manifest: body,
  }),
  isDigestReference: (s: string) => s.startsWith('sha256:'),
  resolveDeploymentManifestReservation: (...args: unknown[]) =>
    mockResolveDeploymentManifestReservation(...args),
}));

// Mock drizzle with realistic state tracking
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
  desc: (col: unknown) => col,
  inArray: (col: unknown, vals: unknown) => [col, vals],
  isNull: (col: unknown) => ['isNull', col],
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentEnvironments: {
    id: 'de.id',
    projectId: 'de.projectId',
    nodeId: 'de.nodeId',
    status: 'de.status',
    resolvedReservationJson: 'de.resolvedReservationJson',
  },
  deploymentReleases: {
    id: 'dr.id',
    environmentId: 'dr.environmentId',
    statusUpdatedAt: 'dr.statusUpdatedAt',
    version: 'dr.version',
    status: 'dr.status',
    manifest: 'dr.manifest',
    createdBy: 'dr.createdBy',
    createdAt: 'dr.createdAt',
  },
  deploymentSecrets: {
    environmentId: 'ds.environmentId',
    name: 'ds.name',
    encryptedValue: 'ds.encryptedValue',
    iv: 'ds.iv',
  },
  nodes: {
    id: 'n.id',
    status: 'n.status',
    nodeMode: 'n.nodeMode',
    providerInstanceId: 'n.providerInstanceId',
  },
  projects: { id: 'p.id' },
}));

/**
 * Realistic mock D1 that routes queries based on table references in
 * from()/where() chains, returning our state arrays.
 */
function createMockDb() {
  return {
    select: vi.fn().mockImplementation((fields?: Record<string, unknown>) => {
      return {
        from: vi.fn().mockImplementation((_table: unknown) => {
          return {
            where: vi.fn().mockImplementation(() => {
              return {
                limit: vi.fn().mockImplementation(() => {
                  // Route based on call order within a single request:
                  // Call 1: requireOwnedEnvironment (envRows)
                  // Call 2: check env nodeId (envRows nodeId)
                  // Heuristic: if fields include nodeId, it's the nodeId check
                  if (fields && 'nodeId' in fields) {
                    return Promise.resolve(
                      envRows.map((r) => ({
                        nodeId: r.nodeId,
                        status: r.status,
                        resolvedReservationJson: r.resolvedReservationJson ?? null,
                      }))
                    );
                  }
                  if (fields && 'nodeMode' in fields) {
                    return Promise.resolve([{ nodeMode: existingNodeMode }]);
                  }
                  if (fields && 'providerInstanceId' in fields) {
                    return Promise.resolve([
                      { status: 'running', providerInstanceId: 'provider-node-existing' },
                    ]);
                  }
                  return Promise.resolve(envRows);
                }),
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue(releaseRows),
                }),
              };
            }),
          };
        }),
      };
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: unknown) => {
        dbCalls.push({ op: 'insert', values: vals as Record<string, unknown> });
        return Promise.resolve();
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(() => {
          dbCalls.push({ op: 'update', values });
          return Promise.resolve(undefined);
        }),
      })),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

// ─── Test App ────────────────────────────────────────────────────────────

async function createTestApp() {
  const { deploymentReleaseRoutes } = await import('../../../src/routes/deployment-releases');
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', deploymentReleaseRoutes);
  return app;
}

const mockEnv = {
  DATABASE: {} as any,
  KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as any,
  BASE_DOMAIN: 'example.com',
  ENCRYPTION_KEY: 'test-key',
} as unknown as Env;

function validManifest() {
  return {
    version: 1,
    services: {
      web: {
        image: {
          registry: 'docker.io',
          repository: 'myapp/web',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: [{ service: 'web', port: 3000, mode: 'public' }],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('POST /:projectId/environments/:envId/releases — provisioning trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbCalls.length = 0;
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: null, status: 'active' }];
    releaseRows = [];
    existingNodeMode = 'shared';
    mockResolveDeploymentPlacement.mockResolvedValue({
      provider: 'hetzner',
      location: 'fsn1',
      vmSize: 'small',
    });
    mockFindDeploymentNodeWithCapacity.mockImplementation(async (_env, _userId, placement) => ({
      nodeId: 'node-existing',
      placement,
    }));
    mockLinkEnvironmentToNode.mockResolvedValue(true);
    mockLinkEnvironmentToLegacyNode.mockResolvedValue(false);
    mockClaimDeploymentEnvironmentRelocation.mockResolvedValue('relocation-claim');
    mockCompleteDeploymentEnvironmentRelocation.mockResolvedValue(true);
    mockRestoreDeploymentEnvironmentRelocation.mockResolvedValue(undefined);
    mockTeardownDeploymentEnvironmentOnNode.mockResolvedValue(undefined);
    mockResolveDeploymentManifestReservation.mockReturnValue({
      version: 3,
      cpuMillis: 250,
      memoryMb: 256,
      diskMb: 1024,
      exclusiveNode: false,
      source: 'task',
      sourceId: 'env-1',
      diagnostics: ['deployment-manifest-reservation:v1'],
    });
  });

  it.each([
    {
      name: 'configured values',
      overrides: {
        DEPLOYMENT_DEFAULT_CPU_LIMIT_MILLIS: '400',
        DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB: '640',
        DEPLOYMENT_DEFAULT_ROOT_DISK_MB: '2048',
      },
      expected: { cpuMillis: 400, memoryMb: 640, diskMb: 2048 },
    },
    {
      name: 'invalid values',
      overrides: {
        DEPLOYMENT_DEFAULT_CPU_LIMIT_MILLIS: 'invalid',
        DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB: '0',
        DEPLOYMENT_DEFAULT_ROOT_DISK_MB: '-1',
      },
      expected: { cpuMillis: 250, memoryMb: 256, diskMb: 1024 },
    },
  ])(
    'passes $name through the release submission reservation boundary',
    async ({ overrides, expected }) => {
      mockProvisionDeploymentNode.mockResolvedValue(null);
      const app = await createTestApp();

      const response = await app.request(
        '/api/projects/proj-1/environments/env-1/releases',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validManifest()),
        },
        { ...mockEnv, ...overrides }
      );

      expect(response.status).toBe(201);
      expect(mockResolveDeploymentManifestReservation).toHaveBeenCalledWith(
        expect.anything(),
        'env-1',
        expected
      );
    }
  );

  it('first release to env without node triggers provisionDeploymentNode()', async () => {
    mockProvisionDeploymentNode.mockResolvedValue({
      nodeId: 'node-new-1',
      provisioningPromise: Promise.resolve(),
    });

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBe('node-new-1');

    expect(mockProvisionDeploymentNode).toHaveBeenCalledWith(
      'env-1',
      'proj-1',
      'test-user-id',
      expect.anything(),
      {
        requiresVolumes: false,
        releaseId: 'release-test-id',
        reservation: {
          version: 3,
          cpuMillis: 250,
          memoryMb: 256,
          diskMb: 1024,
          exclusiveNode: false,
          source: 'task',
          sourceId: 'env-1',
          diagnostics: ['deployment-manifest-reservation:v1'],
        },
        providerOverride: 'hetzner',
        vmLocationOverride: 'fsn1',
        vmSizeOverride: 'small',
      }
    );
    expect(recordDeploymentReleaseLifecycleEventBestEffort).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        projectId: 'proj-1',
        releaseId: 'release-test-id',
        environmentId: 'env-1',
        status: 'created',
        version: 1,
        source: 'deployment_release_submission.create',
      })
    );
  });

  it('second release with existing node does NOT re-provision', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing', status: 'active' }];

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBe('node-existing');

    // provisionDeploymentNode should NOT have been called
    expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
  });

  it('moves a larger release off an incompatible shared node and provisions replacement capacity', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing', status: 'active' }];
    mockFindDeploymentNodeWithCapacity.mockResolvedValue(null);
    mockProvisionDeploymentNode.mockResolvedValue({
      nodeId: 'node-replacement',
      provisioningPromise: Promise.resolve(),
    });

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ nodeId: 'node-replacement' });
    expect(mockFindDeploymentNodeWithCapacity).toHaveBeenCalledWith(
      mockEnv,
      'test-user-id',
      expect.anything(),
      false,
      { nodeId: 'node-existing', excludeEnvironmentId: 'env-1', nodeMode: 'shared' }
    );
    expect(mockClaimDeploymentEnvironmentRelocation).toHaveBeenCalledWith(
      expect.objectContaining({
        envId: 'env-1',
        nodeId: 'node-existing',
        expectedReservationJson: null,
      })
    );
    expect(mockCompleteDeploymentEnvironmentRelocation).toHaveBeenCalledWith(
      expect.objectContaining({ claimJson: 'relocation-claim' })
    );
    expect(mockProvisionDeploymentNode).toHaveBeenCalledOnce();
  });

  it('fails only the losing release when relocation authority or its CAS claim is lost', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing', status: 'active' }];
    mockFindDeploymentNodeWithCapacity.mockResolvedValue(null);
    mockClaimDeploymentEnvironmentRelocation.mockResolvedValue(null);

    const app = await createTestApp();
    const response = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    expect(response.status).toBe(201);
    expect(mockTeardownDeploymentEnvironmentOnNode).not.toHaveBeenCalled();
    expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
    expect(
      dbCalls.some(
        ({ values }) => values?.status === 'error' || values?.observedStatus === 'failed'
      )
    ).toBe(false);
    expect(dbCalls.some(({ values }) => values?.status === 'failed')).toBe(true);
  });

  it.each([
    {
      name: 'exclusive (requiresVolumes)',
      requiresVolumes: true,
      exclusiveNode: true,
    },
    { name: 'shared', requiresVolumes: false, exclusiveNode: false },
  ])(
    'adopts the legacy node an environment already runs on when capacity admission refuses it ($name)',
    async ({ requiresVolumes, exclusiveNode }) => {
      // Production 2026-09-21: pre-node-pool deployment nodes have no
      // capacity_pool_id and no observed hardware, so findDeploymentNodeWithCapacity
      // returns null and linkEnvironmentToNode can never succeed for them.
      envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-legacy', status: 'error' }];
      existingNodeMode = requiresVolumes ? 'exclusive' : 'shared';
      mockProvisionDeploymentNode.mockResolvedValue(null);
      mockFindDeploymentNodeWithCapacity.mockResolvedValue(null);
      mockLinkEnvironmentToNode.mockResolvedValue(false);
      mockLinkEnvironmentToLegacyNode.mockResolvedValue(true);
      mockResolveDeploymentManifestReservation.mockReturnValue({
        version: 3,
        cpuMillis: 250,
        memoryMb: 256,
        diskMb: 1024,
        exclusiveNode,
        source: 'task',
        sourceId: 'env-1',
        diagnostics: ['deployment-manifest-reservation:v1'],
      });
      const manifest = validManifest();
      if (requiresVolumes) {
        manifest.services.web.volumes = [{ name: 'data', mountPath: '/data' }];
        manifest.volumes = { data: { sizeGb: 10 } };
      }

      const app = await createTestApp();
      const response = await app.request(
        '/api/projects/proj-1/environments/env-1/releases',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(manifest),
        },
        mockEnv
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ nodeId: 'node-legacy' });
      expect(mockLinkEnvironmentToLegacyNode).toHaveBeenCalledWith(
        expect.objectContaining({
          envId: 'env-1',
          nodeId: 'node-legacy',
          userId: 'test-user-id',
          releaseId: 'release-test-id',
          requiresVolumes,
          expectedReservationJson: null,
        })
      );
      // The environment is never failed and never retired, and no replacement
      // node is provisioned.
      expect(dbCalls.some(({ values }) => values?.status === 'failed')).toBe(false);
      expect(dbCalls.some(({ values }) => values?.status === 'error')).toBe(false);
      expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
      expect(mockTeardownDeploymentEnvironmentOnNode).not.toHaveBeenCalled();
      // A legacy node can never satisfy the placement-authority predicate the
      // relocation claim requires, so the volume-attach step is skipped outright
      // rather than attempted and swallowed.
      expect(mockClaimDeploymentEnvironmentRelocation).not.toHaveBeenCalled();
    }
  );

  it('falls through to the existing failure path when legacy adoption refuses', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing', status: 'active' }];
    existingNodeMode = 'exclusive';
    mockProvisionDeploymentNode.mockResolvedValue(null);
    mockFindDeploymentNodeWithCapacity.mockResolvedValue(null);
    mockLinkEnvironmentToNode.mockResolvedValue(false);
    mockLinkEnvironmentToLegacyNode.mockResolvedValue(false);
    mockResolveDeploymentManifestReservation.mockReturnValue({
      version: 3,
      cpuMillis: 250,
      memoryMb: 256,
      diskMb: 1024,
      exclusiveNode: true,
      source: 'task',
      sourceId: 'env-1',
      diagnostics: ['deployment-manifest-reservation:v1'],
    });
    const manifest = validManifest();
    manifest.services.web.volumes = [{ name: 'data', mountPath: '/data' }];
    manifest.volumes = { data: { sizeGb: 10 } };

    const app = await createTestApp();
    const response = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      },
      mockEnv
    );

    expect(response.status).toBe(201);
    expect(mockLinkEnvironmentToLegacyNode).toHaveBeenCalledOnce();
    expect(dbCalls.some(({ values }) => values?.status === 'failed')).toBe(true);
    expect(
      dbCalls.some(
        ({ values }) =>
          values?.observedErrorMessage ===
          'Deployment node placement failed: Existing exclusive deployment node cannot admit the declared resource reservation'
      )
    ).toBe(true);
  });

  it('fences shared-to-exclusive volume migration before teardown and guarded completion', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing', status: 'active' }];
    mockProvisionDeploymentNode.mockResolvedValue({
      nodeId: 'node-exclusive',
      provisioningPromise: Promise.resolve(),
    });
    const volumeManifest = validManifest();
    volumeManifest.services.web.volumes = [{ name: 'data', mountPath: '/data' }];
    volumeManifest.volumes = { data: { sizeGb: 10 } };

    const app = await createTestApp();
    const response = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(volumeManifest),
      },
      mockEnv
    );

    expect(response.status).toBe(201);
    expect(mockClaimDeploymentEnvironmentRelocation).toHaveBeenCalledWith(
      expect.objectContaining({
        envId: 'env-1',
        nodeId: 'node-existing',
        userId: 'test-user-id',
      })
    );
    expect(mockClaimDeploymentEnvironmentRelocation.mock.invocationCallOrder[0]).toBeLessThan(
      mockTeardownDeploymentEnvironmentOnNode.mock.invocationCallOrder[0]!
    );
    expect(mockCompleteDeploymentEnvironmentRelocation).toHaveBeenCalledWith(
      expect.objectContaining({ claimJson: 'relocation-claim' })
    );
    expect(mockProvisionDeploymentNode).toHaveBeenCalledOnce();
  });

  it('records a release for a stopped environment without provisioning a node', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: null, status: 'stopped' }];

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBeNull();
    expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
  });

  it('provisionDeploymentNode returning null still returns 201 with nodeId:null', async () => {
    mockProvisionDeploymentNode.mockResolvedValue(null);

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBeNull();
  });

  it('provisionDeploymentNode throwing still returns 201 (error caught)', async () => {
    mockProvisionDeploymentNode.mockRejectedValue(new Error('provisioning exploded'));

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv
    );

    // Release creation must still succeed
    expect(res.status).toBe(201);
    const body = await res.json();
    // nodeId should be null because provisioning threw
    expect(body.nodeId).toBeNull();
  });

  it.each([
    {
      name: 'before fresh provisioning',
      nodeId: null,
      requiresVolumes: false,
      failOnGuardCall: 2,
      expectedClaim: false,
    },
    {
      name: 'before existing shared-node admission',
      nodeId: 'node-existing',
      requiresVolumes: false,
      failOnGuardCall: 2,
      expectedClaim: false,
    },
    {
      name: 'after relocation claim and before teardown',
      nodeId: 'node-existing',
      requiresVolumes: true,
      failOnGuardCall: 3,
      expectedClaim: true,
    },
  ])(
    'cancels stale callback placement $name without placement or environment failure mutation',
    async ({ nodeId, requiresVolumes, failOnGuardCall, expectedClaim }) => {
      envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId, status: 'active' }];
      const stale = Object.assign(new Error('callback incarnation changed'), { name: 'AppError' });
      let guardCalls = 0;
      const assertCurrent = vi.fn(async () => {
        guardCalls += 1;
        if (guardCalls === failOnGuardCall) throw stale;
      });
      const reservation = {
        version: 3 as const,
        cpuMillis: 500,
        memoryMb: 512,
        diskMb: 1024,
        exclusiveNode: requiresVolumes,
        source: 'task' as const,
        sourceId: 'env-1',
      };
      const { placeReleaseOnDeploymentNode } =
        await import('../../../src/routes/deployment-release-submission');

      await expect(
        placeReleaseOnDeploymentNode({
          db: createMockDb() as never,
          env: mockEnv,
          envId: 'env-1',
          projectId: 'proj-1',
          userId: 'test-user-id',
          releaseId: 'release-test-id',
          requiresVolumes,
          placement: {
            projectId: 'proj-1',
            provider: 'hetzner',
            location: 'fsn1',
            vmSize: 'small',
            reservation,
          } as never,
          reservation,
          beforeExternalMutation: assertCurrent,
        })
      ).rejects.toBe(stale);

      expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
      expect(mockLinkEnvironmentToNode).not.toHaveBeenCalled();
      expect(mockTeardownDeploymentEnvironmentOnNode).not.toHaveBeenCalled();
      expect(mockClaimDeploymentEnvironmentRelocation).toHaveBeenCalledTimes(expectedClaim ? 1 : 0);
      expect(mockRestoreDeploymentEnvironmentRelocation).toHaveBeenCalledTimes(
        expectedClaim ? 1 : 0
      );
      expect(dbCalls.filter((call) => call.op === 'update')).toEqual([]);
    }
  );

  it('does not mark the environment failed when a newer release wins a failed fresh-node link', async () => {
    mockProvisionDeploymentNode.mockResolvedValueOnce(null);
    const superseded = Object.assign(new Error('newer release won'), { name: 'AppError' });
    let guardCalls = 0;
    const assertCurrent = vi.fn(async () => {
      guardCalls += 1;
      if (guardCalls === 3) throw superseded;
    });
    const reservation = {
      version: 3 as const,
      cpuMillis: 500,
      memoryMb: 512,
      diskMb: 1024,
      exclusiveNode: false,
      source: 'task' as const,
      sourceId: 'env-1',
    };
    const { placeReleaseOnDeploymentNode } =
      await import('../../../src/routes/deployment-release-submission');

    await expect(
      placeReleaseOnDeploymentNode({
        db: createMockDb() as never,
        env: mockEnv,
        envId: 'env-1',
        projectId: 'proj-1',
        userId: 'test-user-id',
        releaseId: 'release-test-id',
        requiresVolumes: false,
        placement: {
          projectId: 'proj-1',
          provider: 'hetzner',
          location: 'fsn1',
          vmSize: 'small',
          reservation,
        } as never,
        reservation,
        beforeExternalMutation: assertCurrent,
      })
    ).rejects.toBe(superseded);
    expect(dbCalls.filter((call) => call.op === 'update')).toEqual([]);
  });

  it('fences async provisioning failure state after a newer release becomes latest', async () => {
    const statements: Array<{ sql: string; binds: unknown[] }> = [];
    const d1 = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          binds: [] as unknown[],
          bind: vi.fn((...binds: unknown[]) => {
            statement.binds = binds;
            return statement;
          }),
          first: vi.fn(async () => ({ id: 'release-test-id' })),
          run: vi.fn(async () => {
            statements.push({ sql, binds: statement.binds });
            return { meta: { changes: 0 } };
          }),
        };
        return statement;
      }),
    };
    const env = { ...mockEnv, DATABASE: d1 } as unknown as Env;
    mockProvisionDeploymentNode.mockResolvedValueOnce({
      nodeId: 'node-release-a',
      provisioningPromise: Promise.reject(new Error('provider failed after release B won')),
    });
    let observed: Promise<unknown> | undefined;
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        observed = promise;
      }),
    } as unknown as ExecutionContext;
    const reservation = {
      version: 3 as const,
      cpuMillis: 500,
      memoryMb: 512,
      diskMb: 1024,
      exclusiveNode: false,
      source: 'task' as const,
      sourceId: 'env-1',
    };
    const { placeReleaseOnDeploymentNode } =
      await import('../../../src/routes/deployment-release-submission');

    await expect(
      placeReleaseOnDeploymentNode({
        db: createMockDb() as never,
        env,
        envId: 'env-1',
        projectId: 'proj-1',
        userId: 'test-user-id',
        releaseId: 'release-test-id',
        requiresVolumes: false,
        placement: {
          projectId: 'proj-1',
          provider: 'hetzner',
          location: 'fsn1',
          vmSize: 'small',
          reservation,
        } as never,
        reservation,
        executionCtx,
      })
    ).resolves.toBe('node-release-a');
    await observed;

    const environmentFailure = statements.find(
      ({ sql }) => sql.includes('UPDATE deployment_environments') && sql.includes("ELSE 'error'")
    );
    expect(environmentFailure?.binds.at(-1)).toBe('release-test-id');
    expect(dbCalls.filter((call) => call.op === 'update')).toHaveLength(1);
    expect(dbCalls[0]?.values).toMatchObject({ status: 'failed' });
  });

  it('restores a relocation claim without failure status when guarded completion loses', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing', status: 'active' }];
    mockFindDeploymentNodeWithCapacity.mockResolvedValueOnce(null);
    mockCompleteDeploymentEnvironmentRelocation.mockResolvedValueOnce(false);
    const superseded = Object.assign(new Error('newer release won'), { name: 'AppError' });
    let guardCalls = 0;
    const assertCurrent = vi.fn(async () => {
      guardCalls += 1;
      if (guardCalls === 6) throw superseded;
    });
    const reservation = {
      version: 3 as const,
      cpuMillis: 4_000,
      memoryMb: 8_192,
      diskMb: 10_240,
      exclusiveNode: false,
      source: 'task' as const,
      sourceId: 'env-1',
    };
    const { placeReleaseOnDeploymentNode } =
      await import('../../../src/routes/deployment-release-submission');

    await expect(
      placeReleaseOnDeploymentNode({
        db: createMockDb() as never,
        env: mockEnv,
        envId: 'env-1',
        projectId: 'proj-1',
        userId: 'test-user-id',
        releaseId: 'release-test-id',
        requiresVolumes: false,
        placement: {
          projectId: 'proj-1',
          provider: 'hetzner',
          location: 'fsn1',
          vmSize: 'large',
          reservation,
        } as never,
        reservation,
        beforeExternalMutation: assertCurrent,
      })
    ).rejects.toBe(superseded);
    expect(mockRestoreDeploymentEnvironmentRelocation).toHaveBeenCalledWith(
      expect.objectContaining({ claimJson: 'relocation-claim' })
    );
    expect(dbCalls.filter((call) => call.op === 'update')).toEqual([]);
  });

  it.each([false, true])(
    'defers a newer release without failure while an older volume attachment claim is held (requiresVolumes=%s)',
    async (requiresVolumes) => {
      envRows = [
        {
          id: 'env-1',
          projectId: 'proj-1',
          nodeId: 'node-existing',
          status: 'active',
          resolvedReservationJson: JSON.stringify({
            version: 3,
            cpuMillis: 500,
            memoryMb: 512,
            diskMb: 1024,
            exclusiveNode: true,
            source: 'task',
            sourceId: 'env-1',
            samRelocationClaim: true,
          }),
        },
      ];
      const reservation = {
        version: 3 as const,
        cpuMillis: 500,
        memoryMb: 512,
        diskMb: 1024,
        exclusiveNode: requiresVolumes,
        source: 'task' as const,
        sourceId: 'env-1',
      };
      const { DeploymentPlacementCancelledError, placeReleaseOnDeploymentNode } =
        await import('../../../src/routes/deployment-release-submission');

      await expect(
        placeReleaseOnDeploymentNode({
          db: createMockDb() as never,
          env: mockEnv,
          envId: 'env-1',
          projectId: 'proj-1',
          userId: 'test-user-id',
          releaseId: 'release-b',
          requiresVolumes,
          placement: {
            projectId: 'proj-1',
            provider: 'hetzner',
            location: 'fsn1',
            vmSize: 'small',
            reservation,
          } as never,
          reservation,
        })
      ).rejects.toBeInstanceOf(DeploymentPlacementCancelledError);

      expect(mockLinkEnvironmentToNode).not.toHaveBeenCalled();
      expect(mockClaimDeploymentEnvironmentRelocation).not.toHaveBeenCalled();
      expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
      expect(dbCalls.filter((call) => call.op === 'update')).toEqual([]);
    }
  );
});
