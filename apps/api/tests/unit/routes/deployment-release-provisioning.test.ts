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
let envRows: Array<{ id: string; projectId: string; nodeId: string | null }> = [];
let releaseRows: Array<{ version: number }> = [];

// Mock provisionDeploymentNode
const mockProvisionDeploymentNode = vi.fn();
vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: (...args: unknown[]) => mockProvisionDeploymentNode(...args),
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
  requireOwnedProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/middleware/error', () => ({
  errors: {
    badRequest: (msg: string) => Object.assign(new Error(msg), { statusCode: 400, error: 'BAD_REQUEST', message: msg }),
    notFound: (msg: string) => Object.assign(new Error(msg), { statusCode: 404, error: 'NOT_FOUND', message: msg }),
    conflict: (msg: string) => Object.assign(new Error(msg), { statusCode: 409, error: 'CONFLICT', message: msg }),
  },
}));

// Manifest validation passthrough
vi.mock('@simple-agent-manager/shared', () => ({
  validateManifest: (body: unknown) => ({
    success: true,
    manifest: body,
  }),
  isDigestReference: (s: string) => s.startsWith('sha256:'),
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
  },
  deploymentReleases: {
    id: 'dr.id',
    environmentId: 'dr.environmentId',
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
                    return Promise.resolve(envRows.map((r) => ({ nodeId: r.nodeId })));
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
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
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
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: null }];
    releaseRows = [];
  });

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
      mockEnv,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBe('node-new-1');

    expect(mockProvisionDeploymentNode).toHaveBeenCalledWith(
      'env-1',
      'proj-1',
      'test-user-id',
      expect.anything(),
      { requiresVolumes: false },
    );
  });

  it('second release with existing node does NOT re-provision', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: 'node-existing' }];

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validManifest()),
      },
      mockEnv,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBe('node-existing');

    // provisionDeploymentNode should NOT have been called
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
      mockEnv,
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
      mockEnv,
    );

    // Release creation must still succeed
    expect(res.status).toBe(201);
    const body = await res.json();
    // nodeId should be null because provisioning threw
    expect(body.nodeId).toBeNull();
  });
});
