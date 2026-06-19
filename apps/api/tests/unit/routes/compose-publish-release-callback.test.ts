import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const WORKSPACES = { __table: 'workspaces', id: 'workspaces.id' };
const DEPLOYMENT_RELEASES = {
  __table: 'deployment_releases',
  environmentId: 'deployment_releases.environmentId',
  version: 'deployment_releases.version',
};

let workspaceRows: Array<{ projectId: string | null; userId: string }> = [];
let latestVersionRows: Array<{ version: number }> = [];
let agentDeployEnvironmentId: string | null = 'env-1';
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
}));

vi.mock('../../../src/db/schema', () => ({
  workspaces: WORKSPACES,
  deploymentReleases: DEPLOYMENT_RELEASES,
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

vi.mock('../../../src/services/deployment-control', () => ({
  getProjectAgentDeployEnvironmentId: vi.fn(async () => agentDeployEnvironmentId),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'release-ulid-1',
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function buildApp() {
  const { composePublishReleaseCallbackRoute } = await import(
    '../../../src/routes/projects/compose-publish-release-callback'
  );
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

function request(app: Hono, projectId: string, body: unknown) {
  return app.request(
    `/api/projects/${projectId}/compose-publish-release`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DATABASE: {} },
  );
}

const validSubmission = {
  reference: 'sam-registry.local:5050/test-one',
  composeYaml: 'services:\n  web:\n    build: .\n',
  services: [
    { serviceName: 'web', sourceRef: 'a', pushedRef: 'b', digest: 'sha256:abc' },
  ],
};

describe('compose-publish-release callback (vertical slice)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserted.length = 0;
    workspaceRows = [{ projectId: 'proj-1', userId: 'user-1' }];
    latestVersionRows = [{ version: 4 }];
    agentDeployEnvironmentId = 'env-1';
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'workspace' };
  });

  it('records a compose-publish release with the next version and source discriminator', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ releaseId: 'release-ulid-1', version: 5, status: 'created' });

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.environmentId).toBe('env-1');
    expect(row.version).toBe(5);
    expect(row.status).toBe('created');
    expect(row.source).toBe('compose-publish');
    expect(row.createdBy).toBe('user-1');
    // The full captured submission is stored verbatim in the manifest column.
    expect(JSON.parse(row.manifest as string)).toMatchObject({
      reference: validSubmission.reference,
      services: validSubmission.services,
    });
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

  it('rejects when agent deployment is disabled for the project', async () => {
    agentDeployEnvironmentId = null;
    const app = await buildApp();
    const res = await request(app, 'proj-1', validSubmission);

    expect(res.status).toBe(403);
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
