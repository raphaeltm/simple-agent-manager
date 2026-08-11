import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const WORKSPACES = { __table: 'workspaces', id: 'workspaces.id' };
const DEPLOYMENT_PUBLISH_JOBS = { __table: 'deployment_publish_jobs' };

let workspaceRows: Array<{ projectId: string | null; userId: string }> = [];
let jobRows: Array<{ environmentId: string; nodeId: string }> = [];
let verifiedPayload: { workspace: string; type: string; scope?: string } = {
  workspace: 'ws-1',
  type: 'callback',
  scope: 'workspace',
};

const appendMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('../../../src/db/schema', () => ({
  workspaces: WORKSPACES,
  deploymentPublishJobs: DEPLOYMENT_PUBLISH_JOBS,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === WORKSPACES) {
          return {
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(workspaceRows),
            }),
          };
        }
        return {
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(jobRows),
          }),
        };
      }),
    })),
  }),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => verifiedPayload),
}));

vi.mock('../../../src/services/deployment-publish-jobs', () => ({
  appendDeploymentPublishJobEvent: (...args: unknown[]) => appendMock(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function buildApp() {
  const { deploymentPublishJobCallbackRoute } =
    await import('../../../src/routes/projects/deployment-publish-job-callback');
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
  });
  app.route('/api/projects', deploymentPublishJobCallbackRoute);
  return app;
}

function request(app: Hono, projectId: string, jobId: string, body: unknown) {
  return app.request(
    `/api/projects/${projectId}/deployment-publish-jobs/${jobId}/events`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DATABASE: {} }
  );
}

const validEvent = {
  eventType: 'publish.step',
  message: 'Pushing image',
  status: 'running',
  currentStep: 'push',
  level: 'info',
  terminal: false,
  releaseVersion: 3,
  detail: { note: 'ok' },
};

describe('deployment-publish-job-callback (vertical slice)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRows = [{ projectId: 'proj-1', userId: 'user-1' }];
    jobRows = [{ environmentId: 'env-1', nodeId: 'node-1' }];
    verifiedPayload = { workspace: 'ws-1', type: 'callback', scope: 'workspace' };
  });

  it('records a valid publish job event, including the free-form detail payload', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', 'job-1', validEvent);

    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(appendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publishJobId: 'job-1',
        projectId: 'proj-1',
        environmentId: 'env-1',
        nodeId: 'node-1',
        workspaceId: 'ws-1',
        eventType: 'publish.step',
        message: 'Pushing image',
        status: 'running',
        currentStep: 'push',
        level: 'info',
        terminal: false,
        releaseVersion: 3,
        detail: { note: 'ok' },
      })
    );
  });

  it('rejects when the publish job is not found', async () => {
    jobRows = [];
    const app = await buildApp();
    const res = await request(app, 'proj-1', 'job-missing', validEvent);

    expect(res.status).toBe(404);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('rejects an event missing eventType and message', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', 'job-1', { status: 'running' });

    expect(res.status).toBe(400);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-JSON) request body', async () => {
    const app = await buildApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-publish-jobs/job-1/events',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer cb-token', 'Content-Type': 'application/json' },
        body: '{not valid json',
      },
      { DATABASE: {} }
    );

    expect(res.status).toBe(400);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('fails closed (400, not a crash) when a known field has the wrong JSON type', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', 'job-1', {
      ...validEvent,
      terminal: 'yes', // must be a JSON boolean, matching internal/publish/events.go
    });

    expect(res.status).toBe(400);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('ignores unknown top-level fields instead of rejecting or forwarding them verbatim', async () => {
    const app = await buildApp();
    const res = await request(app, 'proj-1', 'job-1', {
      ...validEvent,
      unexpectedField: 'must not break the request',
    });

    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ unexpectedField: expect.anything() })
    );
  });
});
