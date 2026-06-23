import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const WORKSPACES = { __table: 'workspaces', id: 'workspaces.id' };
const DEPLOYMENT_RELEASES = {
  __table: 'deployment_releases',
  environmentId: 'deployment_releases.environmentId',
  version: 'deployment_releases.version',
};
const DEPLOYMENT_ENVIRONMENTS = {
  __table: 'deployment_environments',
  id: 'deployment_environments.id',
  projectId: 'deployment_environments.projectId',
  name: 'deployment_environments.name',
  status: 'deployment_environments.status',
  nodeId: 'deployment_environments.nodeId',
  agentDeployEnabled: 'deployment_environments.agentDeployEnabled',
  agentDeployEnabledBy: 'deployment_environments.agentDeployEnabledBy',
  agentDeployEnabledAt: 'deployment_environments.agentDeployEnabledAt',
  agentDeployDisabledAt: 'deployment_environments.agentDeployDisabledAt',
  allowedDeployProfileIdsJson: 'deployment_environments.allowedDeployProfileIdsJson',
};

let workspaceRows: Array<{ projectId: string | null; userId: string }> = [];
let latestVersionRows: Array<{ version: number }> = [];
let environmentRows: Array<{
  id: string;
  nodeId: string | null;
  agentDeployEnabled: boolean;
  agentDeployEnabledBy?: string | null;
  agentDeployEnabledAt?: string | null;
  agentDeployDisabledAt?: string | null;
  allowedDeployProfileIdsJson?: string | null;
}> = [];
const inserted: Array<Record<string, unknown>> = [];
let verifiedPayload: { workspace: string; type: string; scope?: string } = {
  workspace: 'ws-1',
  type: 'callback',
  scope: 'workspace',
};

vi.mock('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  desc: (col: unknown) => col,
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  // The provisioning import chain (deployment-provisioning -> observability)
  // pulls observability-schema.ts, which uses sql`...` at module load time.
  sql: (strings: TemplateStringsArray, ...exprs: unknown[]) => ({ strings, exprs }),
}));

vi.mock('../../../src/db/schema', () => ({
  workspaces: WORKSPACES,
  deploymentReleases: DEPLOYMENT_RELEASES,
  deploymentEnvironments: DEPLOYMENT_ENVIRONMENTS,
}));

// Node provisioning is best-effort and must never fail the durable release.
// Stub it so the release-recording slice stays focused; nodeId resolves to null.
vi.mock('../../../src/services/deployment-provisioning', () => ({
  DEPLOYMENT_MODEL_RUNNER_VM_SIZE: 'medium',
  provisionDeploymentNode: vi.fn(async () => null),
}));

function createMockDb() {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === WORKSPACES) {
          return {
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(workspaceRows),
            }),
          };
        }
        if (table === DEPLOYMENT_ENVIRONMENTS) {
          return {
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(environmentRows),
            }),
          };
        }
        // deployment_releases latest-version lookup
        return {
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(latestVersionRows),
            }),
          }),
        };
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      }),
    })),
  };
}

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => verifiedPayload),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'release-ulid-1',
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function buildApp() {
  const { composePublishReleaseCallbackRoute } =
    await import('../../../src/routes/projects/compose-publish-release-callback');
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
  });
  app.route('/api/projects', composePublishReleaseCallbackRoute);
  return app;
}

function request(app: Hono, projectId: string, body: unknown, env: Record<string, unknown> = {}) {
  return app.request(
    `/api/projects/${projectId}/compose-publish-release`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DATABASE: {}, ...env }
  );
}

const validSubmission = {
  environment: 'staging',
  environmentId: 'env-1',
  reference: 'sam-registry.local:5050/test-one',
  composeYaml: 'services:\n  web:\n    build: .\n',
  services: [{ serviceName: 'web', sourceRef: 'a', pushedRef: 'b', digest: 'sha256:abc' }],
  submittedBy: {
    taskId: 'task-1',
    agentProfileId: 'profile-1',
  },
};

describe('compose-publish-release callback (vertical slice)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserted.length = 0;
    workspaceRows = [{ projectId: 'proj-1', userId: 'user-1' }];
    latestVersionRows = [{ version: 4 }];
    environmentRows = [
      {
        id: 'env-1',
        nodeId: null,
        agentDeployEnabled: true,
        agentDeployEnabledBy: 'user-1',
        agentDeployEnabledAt: '2026-06-21T00:00:00.000Z',
        agentDeployDisabledAt: null,
        allowedDeployProfileIdsJson: null,
      },
    ];
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'workspace' };
  });

  it('records a compose-publish release with the next version and source discriminator', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(200);
    const body = await res.json();
    // nodeId is null here: the stubbed provisioner returns null (no node linked),
    // which is the best-effort path that never fails the durable release.
    expect(body).toEqual({
      releaseId: 'release-ulid-1',
      version: 5,
      status: 'created',
      nodeId: null,
    });

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.environmentId).toBe('env-1');
    expect(row.version).toBe(5);
    expect(row.status).toBe('created');
    expect(row.source).toBe('compose-publish');
    expect(row.createdBy).toBe('user-1');
    // The full captured submission is stored verbatim in the manifest column.
    expect(JSON.parse(row.manifest as string)).toMatchObject({
      environment: 'staging',
      environmentId: 'env-1',
      reference: validSubmission.reference,
      services: validSubmission.services,
      submittedBy: {
        userId: 'user-1',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        agentProfileId: 'profile-1',
      },
    });
  });

  it('validates and records artifact-backed service descriptors', async () => {
    const headCalls: string[] = [];
    const r2 = {
      head: vi.fn(async (key: string) => {
        headCalls.push(key);
        return { size: 42 };
      }),
    };
    const artifactSubmission = {
      ...validSubmission,
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

    const app = await buildApp();
    const res = await request(app, 'proj-1', artifactSubmission, { R2: r2 });

    expect(res.status).toBe(200);
    expect(headCalls).toEqual([
      'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
    ]);
    const manifest = JSON.parse(inserted[0].manifest as string);
    expect(manifest.services[0]).toMatchObject({
      serviceName: 'web',
      r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
      archiveSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('rejects artifact descriptors outside the workspace-scoped key prefix', async () => {
    const app = await buildApp();
    const res = await request(
      app,
      'proj-1',
      {
        ...validSubmission,
        services: [
          {
            serviceName: 'web',
            sourceRef: 'workspace-web',
            localImageRef: 'workspace-web',
            r2Key: 'compose-image-artifacts/proj-1/env-1/other-ws/upload-1/web.docker-save.tar',
            sizeBytes: 42,
            archiveSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            archiveType: 'docker-save',
            mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
          },
        ],
      },
      { R2: { head: vi.fn() } }
    );

    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it('starts at version 1 when the environment has no prior releases', async () => {
    latestVersionRows = [];
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);
    expect(inserted[0].version).toBe(1);
  });

  it('rejects when the workspace project does not match the route param', async () => {
    workspaceRows = [{ projectId: 'proj-OTHER', userId: 'user-1' }];
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('rejects when the workspace is not linked to a project', async () => {
    workspaceRows = [{ projectId: null, userId: 'user-1' }];
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('rejects when the requested target environment is not enabled for agent deployment', async () => {
    environmentRows = [{ id: 'env-1', nodeId: null, agentDeployEnabled: false }];
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('rejects when the submitted agent profile is not allowed for the environment', async () => {
    environmentRows = [
      {
        id: 'env-1',
        nodeId: null,
        agentDeployEnabled: true,
        allowedDeployProfileIdsJson: JSON.stringify(['profile-allowed']),
      },
    ];
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('rejects a submission missing agentProfileId', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', {
      ...validSubmission,
      submittedBy: { taskId: 'task-1' },
    });

    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it('rejects a submission missing the target environment', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', { ...validSubmission, environment: undefined });

    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it('rejects a token whose scope is neither workspace nor node', async () => {
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'ai-proxy' };
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('rejects node-scoped tokens because the workspace claim is a node id', async () => {
    verifiedPayload = { workspace: 'node-1', type: 'callback', scope: 'node' };
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('rejects a submission missing composeYaml', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', { ...validSubmission, composeYaml: '   ' });

    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it('rejects a submission with no services', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', { ...validSubmission, services: [] });

    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });
});
