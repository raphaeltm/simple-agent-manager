import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const WORKSPACES = {
  __table: 'workspaces',
  id: 'workspaces.id',
  status: 'workspaces.status',
  nodeId: 'workspaces.node_id',
};
const NODES = { __table: 'nodes', id: 'nodes.id', status: 'nodes.status' };

let workspaceRows: Array<{
  projectId: string | null;
  userId: string;
  status: string;
  nodeId?: string | null;
  nodeStatus?: string | null;
}> = [];
let policyResult: { environmentId: string } | { error: string } = { environmentId: 'env-1' };
let verifiedPayload: { workspace: string; type: string; scope?: string } = {
  workspace: 'ws-1',
  type: 'callback',
  scope: 'workspace',
};

// createComposeImageArtifactUploads is the only real I/O boundary (AWS S3
// presigned URL signing) — mocked as the system boundary per rule 35.
// validateComposeImageArtifactDescriptor / validateCompletedComposeImageArtifacts
// / getComposeImageArtifactMaxBytes run for REAL (only R2.head is an I/O call,
// satisfied by the per-test mock env.R2).
const createUploadsMock = vi.hoisted(() =>
  vi.fn(
    async (
      _env: unknown,
      input: {
        services: Array<{ serviceName: string; sourceRef: string; localImageRef?: string }>;
      }
    ) =>
      input.services.map((svc, i) => ({
        serviceName: svc.serviceName,
        sourceRef: svc.sourceRef,
        localImageRef: svc.localImageRef || svc.sourceRef,
        r2Key: `compose-image-artifacts/proj-1/env-1/ws-1/upload-x/${svc.serviceName}.docker-save.tar`,
        uploadUrl: `https://signed.example/${i}`,
        expiresIn: 900,
        maxBytes: 2147483648,
        archiveType: 'docker-save',
        mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
      }))
  )
);

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('../../../src/db/schema', () => ({
  workspaces: WORKSPACES,
  nodes: NODES,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(workspaceRows),
          }),
        }),
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(workspaceRows),
        }),
      }),
    })),
  }),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => verifiedPayload),
}));

vi.mock('../../../src/services/deployment-control', () => ({
  assertAgentDeploymentAllowedForProfile: vi.fn(async () => policyResult),
}));

vi.mock('../../../src/services/compose-image-artifacts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/compose-image-artifacts')>();
  return {
    ...actual,
    createComposeImageArtifactUploads: (...args: unknown[]) =>
      createUploadsMock(...(args as [unknown, never])),
  };
});

vi.mock('../../../src/lib/logger', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function buildApp() {
  const { composeImageArtifactsCallbackRoute } =
    await import('../../../src/routes/projects/compose-image-artifacts-callback');
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
  });
  app.route('/api/projects', composeImageArtifactsCallbackRoute);
  return app;
}

function request(
  app: Hono,
  projectId: string,
  path: 'init' | 'complete',
  body: unknown,
  env: Record<string, unknown> = {}
) {
  return app.request(
    `/api/projects/${projectId}/compose-image-artifacts/${path}`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DATABASE: {}, ...env }
  );
}

describe('compose-image-artifacts callback (vertical slice)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRows = [
      {
        projectId: 'proj-1',
        userId: 'user-1',
        status: 'running',
        nodeId: 'node-1',
        nodeStatus: 'running',
      },
    ];
    policyResult = { environmentId: 'env-1' };
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'workspace' };
  });

  describe('POST /init', () => {
    const validInit = {
      environment: 'staging',
      environmentId: 'env-1',
      agentProfileId: 'profile-1',
      services: [{ serviceName: 'web', sourceRef: 'workspace-web' }],
    };

    it('creates upload targets for a valid init request', async () => {
      const app = await buildApp();
      const res = await request(app, 'proj-1', 'init', validInit);

      const body = (await res.json()) as { uploads: unknown[] };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.uploads).toHaveLength(1);
      expect(createUploadsMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: 'proj-1',
          workspaceId: 'ws-1',
          environmentId: 'env-1',
          services: [expect.objectContaining({ serviceName: 'web', sourceRef: 'workspace-web' })],
        })
      );
    });

    it('fails closed (400, not a 500) when a service item is missing serviceName/sourceRef', async () => {
      // Regression: previously an item missing these fields flowed unvalidated
      // into createComposeImageArtifactUploads, which throws a plain Error
      // that escaped uncaught to the global handler as a 500.
      const app = await buildApp();
      const res = await request(app, 'proj-1', 'init', {
        ...validInit,
        services: [{ localImageRef: 'x' }],
      });

      expect(res.status).toBe(400);
      expect(createUploadsMock).not.toHaveBeenCalled();
    });

    it('rejects a request with no services', async () => {
      const app = await buildApp();
      const res = await request(app, 'proj-1', 'init', { ...validInit, services: [] });

      expect(res.status).toBe(400);
      expect(createUploadsMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed (non-JSON) request body', async () => {
      const app = await buildApp();
      const res = await app.request(
        '/api/projects/proj-1/compose-image-artifacts/init',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        { DATABASE: {} }
      );

      expect(res.status).toBe(400);
      expect(createUploadsMock).not.toHaveBeenCalled();
    });

    it('requires environment, environmentId, and agentProfileId', async () => {
      const app = await buildApp();
      const res = await request(app, 'proj-1', 'init', {
        environment: 'staging',
        environmentId: 'env-1',
        services: validInit.services,
      });

      expect(res.status).toBe(400);
      expect(createUploadsMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /complete', () => {
    const validCompleteBase = {
      environment: 'staging',
      environmentId: 'env-1',
      agentProfileId: 'profile-1',
    };

    it('validates and returns completed artifact descriptors', async () => {
      const headCalls: string[] = [];
      const r2 = {
        head: vi.fn(async (key: string) => {
          headCalls.push(key);
          return { size: 42 };
        }),
      };
      const app = await buildApp();
      const res = await request(
        app,
        'proj-1',
        'complete',
        {
          ...validCompleteBase,
          artifacts: [
            {
              serviceName: 'web',
              sourceRef: 'workspace-web',
              localImageRef: 'workspace-web',
              r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
              sizeBytes: 42,
              archiveSha256: `sha256:${'a'.repeat(64)}`,
              archiveType: 'docker-save',
              mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
            },
          ],
        },
        { R2: r2 }
      );

      const body = (await res.json()) as { artifacts: Array<Record<string, unknown>> };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(headCalls).toEqual([
        'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
      ]);
      expect(body.artifacts[0]).toMatchObject({
        serviceName: 'web',
        r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
      });
    });

    it('rejects an artifact with a malformed archiveSha256', async () => {
      const app = await buildApp();
      const res = await request(
        app,
        'proj-1',
        'complete',
        {
          ...validCompleteBase,
          artifacts: [
            {
              serviceName: 'web',
              sourceRef: 'workspace-web',
              localImageRef: 'workspace-web',
              r2Key: 'compose-image-artifacts/proj-1/env-1/ws-1/upload-1/web.docker-save.tar',
              sizeBytes: 42,
              archiveSha256: 'not-a-digest',
              archiveType: 'docker-save',
              mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
            },
          ],
        },
        { R2: { head: vi.fn() } }
      );

      expect(res.status).toBe(400);
    });

    it('rejects a request with no artifacts', async () => {
      const app = await buildApp();
      const res = await request(
        app,
        'proj-1',
        'complete',
        { ...validCompleteBase, artifacts: [] },
        { R2: { head: vi.fn() } }
      );

      expect(res.status).toBe(400);
    });

    it('rejects a malformed (non-JSON) request body', async () => {
      const app = await buildApp();
      const res = await app.request(
        '/api/projects/proj-1/compose-image-artifacts/complete',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
          body: '{not valid json',
        },
        { DATABASE: {}, R2: { head: vi.fn() } }
      );

      expect(res.status).toBe(400);
    });
  });
});
