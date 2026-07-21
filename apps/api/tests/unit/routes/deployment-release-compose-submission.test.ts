/**
 * Vertical-slice route tests for Compose YAML release submission.
 *
 * Uses the real Compose parser/resolver and manifest validation while mocking
 * system boundaries: auth, D1, registry credential/resolver construction, and
 * deployment-node provisioning.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const FIXED_DIGEST = `sha256:${'a'.repeat(64)}`;

const mockProvisionDeploymentNode = vi.fn();
const mockResolveDeploymentPlacement = vi.fn();
const mockCreateMissingManifestVolumes = vi.fn();
const mockAttachEnvironmentVolumesToLinkedNode = vi.fn();
const mockMintProjectRegistryCredential = vi.fn();
const mockCreateImageResolver = vi.fn();
const mockResolver = vi.fn();

let envRows: Array<{ id: string; projectId: string; nodeId: string | null }> = [];
let releaseRows: Array<{ version: number }> = [];
let secretRows: Array<{ name: string }> = [];
let insertedReleases: Array<Record<string, unknown>> = [];

vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: (...args: unknown[]) => mockProvisionDeploymentNode(...args),
  resolveDeploymentPlacement: (...args: unknown[]) => mockResolveDeploymentPlacement(...args),
}));

vi.mock('../../../src/services/deployment-volumes', () => ({
  createMissingManifestVolumes: (...args: unknown[]) => mockCreateMissingManifestVolumes(...args),
  attachEnvironmentVolumesToLinkedNode: (...args: unknown[]) =>
    mockAttachEnvironmentVolumesToLinkedNode(...args),
  markDeploymentReleaseVolumeAttachFailed: vi.fn(),
}));

vi.mock('../../../src/services/image-resolver', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/image-resolver')>(
    '../../../src/services/image-resolver'
  );
  return {
    ...actual,
    createImageResolver: (...args: unknown[]) => mockCreateImageResolver(...args),
  };
});

vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: (...args: unknown[]) => mockMintProjectRegistryCredential(...args),
}));

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn().mockResolvedValue('decrypted-value'),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'release-compose-id',
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ error: String(e) })),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'test-user-id',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
  requireProjectCapability: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/middleware/error', async () => {
  const actual = await vi.importActual<typeof import('../../../src/middleware/error')>(
    '../../../src/middleware/error'
  );
  return {
    ...actual,
    errors: {
      badRequest: (msg: string) =>
        Object.assign(new Error(msg), { statusCode: 400, error: 'BAD_REQUEST', message: msg }),
      notFound: (msg: string) =>
        Object.assign(new Error(msg), { statusCode: 404, error: 'NOT_FOUND', message: msg }),
      conflict: (msg: string) =>
        Object.assign(new Error(msg), { statusCode: 409, error: 'CONFLICT', message: msg }),
    },
  };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
  desc: (col: unknown) => col,
  inArray: (col: unknown, vals: unknown) => [col, vals],
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentEnvironments: {
    id: 'de.id',
    projectId: 'de.projectId',
    nodeId: 'de.nodeId',
  },
  nodes: {
    id: 'n.id',
    nodeMode: 'n.nodeMode',
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

function createMockDb() {
  return {
    select: vi.fn().mockImplementation((fields?: Record<string, unknown>) => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          if (fields && 'name' in fields) {
            return Promise.resolve(secretRows);
          }

          const chain = {
            limit: vi.fn().mockImplementation(() => {
              if (fields && 'nodeId' in fields) {
                return Promise.resolve(envRows.map((r) => ({ nodeId: r.nodeId })));
              }
              return Promise.resolve(envRows);
            }),
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(releaseRows),
            }),
          };
          return chain;
        }),
      })),
    })),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        insertedReleases.push(vals);
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
  DATABASE: {},
  KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  BASE_DOMAIN: 'example.com',
  ENCRYPTION_KEY: 'test-key',
} as Env;

function composeYaml(overrides: { extraService?: string; secretName?: string } = {}) {
  const secretName = overrides.secretName ?? 'database-url';
  return `services:
  web:
    image: registry.sam.example/proj-1/web:v1.2.3
    environment:
      NODE_ENV: production
      DATABASE_URL:
        x-sam-secret: ${secretName}
    volumes:
      - app-data:/var/lib/app
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
${overrides.extraService ?? ''}volumes:
  app-data: {}
x-sam-routes:
  - service: web
    port: 3000
    mode: public
`;
}

function jsonManifest() {
  return {
    version: 1,
    services: {
      web: {
        image: {
          registry: 'registry.sam.example',
          repository: 'proj-1/web',
          digest: FIXED_DIGEST,
        },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: [{ service: 'web', port: 3000, mode: 'public' }],
  };
}

describe('POST /:projectId/environments/:envId/releases — Compose submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envRows = [{ id: 'env-1', projectId: 'proj-1', nodeId: null }];
    releaseRows = [];
    secretRows = [{ name: 'database-url' }];
    insertedReleases = [];

    mockResolver.mockResolvedValue(FIXED_DIGEST);
    mockCreateImageResolver.mockReturnValue(mockResolver);
    mockMintProjectRegistryCredential.mockResolvedValue({
      username: 'sam-pull-user',
      password: 'sam-pull-password',
      registry: 'registry.sam.example',
    });
    mockProvisionDeploymentNode.mockResolvedValue({
      nodeId: 'node-new-1',
      provisioningPromise: Promise.resolve(),
    });
    mockResolveDeploymentPlacement.mockResolvedValue({
      provider: 'hetzner',
      location: 'fsn1',
      vmSize: 'small',
    });
    mockCreateMissingManifestVolumes.mockResolvedValue([]);
    mockAttachEnvironmentVolumesToLinkedNode.mockResolvedValue([]);
  });

  it('accepts Compose YAML, persists a digest-pinned manifest, assigns version, and triggers provisioning', async () => {
    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/yaml' },
        body: composeYaml(),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'release-compose-id',
      environmentId: 'env-1',
      version: 1,
      status: 'created',
      createdBy: 'test-user-id',
      nodeId: 'node-new-1',
    });

    expect(insertedReleases).toHaveLength(1);
    const inserted = insertedReleases[0];
    if (!inserted) throw new Error('Expected a persisted release');
    expect(inserted['version']).toBe(1);
    const manifest = JSON.parse(inserted['manifest'] as string);
    expect(manifest.services.web.image).toEqual({
      registry: 'registry.sam.example',
      repository: 'proj-1/web',
      digest: FIXED_DIGEST,
    });
    expect(manifest.services.web.env).toEqual({
      NODE_ENV: 'production',
      DATABASE_URL: { secret: 'database-url' },
    });
    expect(manifest.services.web.healthCheck).toEqual({
      path: '/health',
      port: 3000,
      expectedStatus: 200,
    });
    expect(manifest.volumes).toEqual({ 'app-data': {} });
    expect(manifest.routes).toEqual([{ service: 'web', port: 3000, mode: 'public' }]);

    expect(mockResolver).toHaveBeenCalledWith('registry.sam.example', 'proj-1/web', 'v1.2.3');
    expect(mockProvisionDeploymentNode).toHaveBeenCalledWith(
      'env-1',
      'proj-1',
      'test-user-id',
      expect.anything(),
      {
        providerOverride: 'hetzner',
        requiresVolumes: true,
        vmLocationOverride: 'fsn1',
        vmSizeOverride: 'small',
      }
    );
    expect(mockCreateMissingManifestVolumes).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'test-user-id',
      expect.objectContaining({
        environmentId: 'env-1',
        location: 'fsn1',
        targetProvider: 'hetzner',
      })
    );
  });

  it('keeps the JSON manifest path working for application/json requests', async () => {
    releaseRows = [{ version: 4 }];

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jsonManifest()),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 5 });
    expect(insertedReleases).toHaveLength(1);
    const inserted = insertedReleases[0];
    if (!inserted) throw new Error('Expected a persisted release');
    expect(JSON.parse(inserted['manifest'] as string)).toEqual(jsonManifest());
  });

  it('returns COMPOSE_PARSE_FAILED with structured errors for invalid YAML', async () => {
    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/yaml' },
        body: 'services: [',
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('COMPOSE_PARSE_FAILED');
    expect(body.details.errors[0]).toEqual({
      path: '(root)',
      message: expect.stringContaining('Invalid YAML'),
    });
  });

  it('surfaces denylisted Compose fields as COMPOSE_PARSE_FAILED', async () => {
    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/x-yaml' },
        body: composeYaml().replace('    image:', '    privileged: true\n    image:'),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('COMPOSE_PARSE_FAILED');
    expect(body.details.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'services.web.privileged' })])
    );
  });

  it('returns MISSING_SECRETS when Compose references an unset environment secret', async () => {
    secretRows = [];

    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/yaml' },
        body: composeYaml({ secretName: 'missing-db-url' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('MISSING_SECRETS');
    expect(body.details.missingSecrets).toEqual(['missing-db-url']);
  });

  it('accepts multi-service Compose submissions and persists every service in the manifest', async () => {
    // The slice-2 single-service cap was removed: deployments must run the full
    // multi-service topology the user authored. A web + worker compose now
    // succeeds and both services are digest-pinned into the stored manifest.
    const app = await createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-yaml; charset=utf-8' },
        body: composeYaml({
          extraService: `  worker:
    image: registry.sam.example/proj-1/worker:v1.2.3
    environment: {}
`,
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(insertedReleases).toHaveLength(1);
    const manifest = JSON.parse(insertedReleases[0].manifest as string);
    expect(Object.keys(manifest.services).sort((a, b) => a.localeCompare(b))).toEqual([
      'web',
      'worker',
    ]);
  });

  it('scopes minted registry credentials to the SAM registry host for both YAML and JSON paths', async () => {
    const app = await createTestApp();

    await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/yaml' },
        body: composeYaml(),
      },
      mockEnv
    );

    await app.request(
      '/api/projects/proj-1/environments/env-1/releases',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...jsonManifest(),
          services: {
            web: {
              ...jsonManifest().services.web,
              image: {
                registry: 'registry.sam.example',
                repository: 'proj-1/web',
                tag: 'v2.0.0',
              },
            },
          },
        }),
      },
      mockEnv
    );

    expect(mockMintProjectRegistryCredential).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'test-user-id',
      '',
      undefined,
      { permissions: ['pull'] }
    );
    expect(mockCreateImageResolver).toHaveBeenCalledTimes(2);
    expect(mockCreateImageResolver).toHaveBeenNthCalledWith(1, {
      auth: { username: 'sam-pull-user', password: 'sam-pull-password' },
      authRegistryHost: 'registry.sam.example',
    });
    expect(mockCreateImageResolver).toHaveBeenNthCalledWith(2, {
      auth: { username: 'sam-pull-user', password: 'sam-pull-password' },
      authRegistryHost: 'registry.sam.example',
    });
  });
});
