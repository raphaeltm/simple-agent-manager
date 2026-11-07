import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let database: D1Database;
const cancelVm = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('VM returned 404');
  })
);
vi.mock('../../../src/services/deployment-publish-job-settings', () => ({
  getDeploymentPublishJobSettings: async () => ({ cancelTimeoutMs: 10 }),
}));
vi.mock('../../../src/routes/mcp/workspace-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/routes/mcp/workspace-tools')>()),
  cancelBuildPublishJobOnVm: cancelVm,
}));
const lifecycle = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/routes/projects/_callback-auth', () => ({
  verifyWorkspacePublishCallback: async () => ({
    projectId: 'project',
    workspaceId: 'workspace',
    userId: 'user',
    db: drizzle(database, { schema }),
    assertCurrent: async () => undefined,
  }),
}));
vi.mock('../../../src/services/deployment-control', () => ({
  assertAgentDeploymentAllowedForProfile: async () => ({ environmentId: 'environment' }),
}));
vi.mock('../../../src/services/deployment-provisioning', () => ({
  resolveDeploymentPlacement: async () => ({ provider: 'hetzner', location: 'fsn1' }),
}));
vi.mock('../../../src/routes/deployment-release-placement', () => ({
  DeploymentPlacementCancelledError: class extends Error {},
  placeReleaseOnDeploymentNode: async () => 'node',
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentReleaseLifecycleEventBestEffort: lifecycle,
  recordDeploymentPublishJobLifecycleEventBestEffort: lifecycle,
}));

const { handleCancelPublish } = await import('../../../src/routes/mcp/compose-publish-tools');
const { composePublishReleaseCallbackRoute } =
  await import('../../../src/routes/projects/compose-publish-release-callback');
const { deploymentPublishJobCallbackRoute } =
  await import('../../../src/routes/projects/deployment-publish-job-callback');
const app = new Hono<{ Bindings: Env }>();
app.onError((err, c) =>
  err instanceof AppError
    ? c.json(err.toJSON(), err.statusCode)
    : c.json({ error: err.message }, 500)
);
app.route('/projects', composePublishReleaseCallbackRoute);
app.route('/projects', deploymentPublishJobCallbackRoute);
function request(path: string, body: unknown) {
  return app.request(
    `/projects/project/${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { DATABASE: database } as Env,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext
  );
}
function submit(overrides = {}) {
  return request('compose-publish-release', {
    publishJobId: 'job',
    attempt: 1,
    environment: 'staging',
    environmentId: 'environment',
    composeYaml: 'services:\n  web:\n    image: nginx:latest\n',
    services: [{ serviceName: 'web', pushedRef: 'nginx:latest' }],
    submittedBy: { agentProfileId: 'profile' },
    ...overrides,
  });
}
function releases() {
  return sqlite.prepare('SELECT id FROM deployment_releases').all();
}
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.deploymentEnvironments,
    schema.deploymentPublishJobs,
    schema.deploymentPublishJobEvents,
    schema.deploymentReleases,
  ]);
  database = createSqliteD1(sqlite);
  sqlite.exec(
    "INSERT INTO deployment_environments(id,project_id,node_id,status) VALUES('environment','project','node','running')"
  );
  sqlite.exec(
    "INSERT INTO deployment_publish_jobs(id,project_id,workspace_id,environment_id,node_id,requested_by,status,attempt) VALUES('job','project','workspace','environment','node','user','building',1)"
  );
  lifecycle.mockClear();
  cancelVm.mockClear();
});
afterEach(() => sqlite.close());
describe('publish callback routes with real SQL', () => {
  it('MCP cancel commits despite an old-agent 404 and fences the real release callback', async () => {
    const result = await handleCancelPublish(
      'cancel',
      { publishJobId: 'job' },
      {
        projectId: 'project',
        workspaceId: 'workspace',
        userId: 'user',
        taskId: 'task',
        createdAt: '',
      },
      { DATABASE: database } as Env
    );
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.result!.content[0]!.text as string).status).toBe('canceled');
    expect(cancelVm).toHaveBeenCalledOnce();
    expect(lifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'canceled' })
    );
    expect((await submit()).status).toBe(409);
    expect(releases()).toHaveLength(0);
  });

  it('records and links an owner release, then rejects duplicate callback with 409', async () => {
    const owner = await submit();
    expect(owner.status, await owner.clone().text()).toBe(200);
    const body = (await owner.json()) as { releaseId: string };
    expect(releases()).toEqual([{ id: body.releaseId }]);
    expect(sqlite.prepare('SELECT release_id FROM deployment_publish_jobs').get()).toEqual({
      release_id: body.releaseId,
    });
    const duplicate = await submit();
    expect(duplicate.status).toBe(409);
    expect(releases()).toHaveLength(1);
  });
  it.each(['canceled', 'failed', 'succeeded', 'unknown'])(
    'rejects %s late release, with independent live owner control',
    async (status) => {
      sqlite.prepare('UPDATE deployment_publish_jobs SET status = ?').run(status);
      expect((await submit()).status).toBe(409);
      expect(releases()).toHaveLength(0);
      sqlite.exec("UPDATE deployment_publish_jobs SET status = 'building'");
      expect((await submit()).status).toBe(200);
    }
  );
  it('rejects wrong attempt and foreign workspace, while owner succeeds', async () => {
    expect((await submit({ attempt: 2 })).status).toBe(409);
    sqlite.exec("UPDATE deployment_publish_jobs SET workspace_id = 'foreign'");
    expect((await submit()).status).toBe(409);
    expect(releases()).toHaveLength(0);
    sqlite.exec("UPDATE deployment_publish_jobs SET workspace_id = 'workspace'");
    expect((await submit()).status).toBe(200);
  });
  it('keeps old-agent release submissions working without publishJobId', async () => {
    expect((await submit({ publishJobId: undefined, attempt: undefined })).status).toBe(200);
    expect(releases()).toHaveLength(1);
  });
  it('requires attempt when the job id is supplied', async () => {
    expect((await submit({ attempt: undefined })).status).toBe(400);
    expect(releases()).toHaveLength(0);
  });
  it('terminal event route returns 409 without emitting a false lifecycle transition', async () => {
    sqlite.exec("UPDATE deployment_publish_jobs SET status = 'canceled'");
    const event = {
      status: 'building',
      currentStep: 'build',
      eventType: 'publish.build.started',
      message: 'build started',
    };
    expect((await request('deployment-publish-jobs/job/events', event)).status).toBe(409);
    expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
      status: 'canceled',
    });
    expect(lifecycle).not.toHaveBeenCalled();
    sqlite.exec("UPDATE deployment_publish_jobs SET status = 'starting'");
    expect((await request('deployment-publish-jobs/job/events', event)).status).toBe(200);
    expect(lifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'building' })
    );
  });
});
