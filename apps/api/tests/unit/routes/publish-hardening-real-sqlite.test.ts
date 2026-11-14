import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { signPublishJobToken } from '../../../src/services/publish-job-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let database: D1Database;
let keyEnv: Partial<Env>;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  keyEnv = {
    JWT_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
    JWT_PUBLIC_KEY: await exportSPKI(keys.publicKey),
    BASE_DOMAIN: 'example.test',
  };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.invalid/artifact'),
}));
const stopBuilder = vi.hoisted(() => vi.fn(async () => {}));
const cancelVm = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('VM returned 404');
  })
);
// The cancel timeout reaches app-deployment through the worker's settings port.
vi.mock('../../../src/services/admin-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/admin-settings')>();
  return {
    ...actual,
    resolveAdminSetting: (async (env, name) =>
      name === 'deployments.publishJobCancelTimeoutMs'
        ? 10
        : ((
            {
              'deployments.buildContextMaxBytes': 536870912,
              'deployments.buildContextUploadTtlSeconds': 900,
              'deployments.builderDaemonReadyTimeoutMs': 60000,
              'deployments.builderHeartbeatIntervalMs': 15000,
            } as Record<string, number>
          )[name] ?? actual.resolveAdminSetting(env, name))) as typeof actual.resolveAdminSetting,
  };
});
vi.mock('../../../src/routes/mcp/workspace-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/routes/mcp/workspace-tools')>()),
  cancelBuildPublishJobOnVm: cancelVm,
}));
const provisionVolumes = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../../src/services/deployment-volumes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/deployment-volumes')>()),
  createMissingDeclaredVolumes: provisionVolumes,
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

const { composeImageArtifactsCallbackRoute } =
  await import('../../../src/routes/projects/compose-image-artifacts-callback');
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
app.route('/projects', composeImageArtifactsCallbackRoute);
app.route('/projects', deploymentPublishJobCallbackRoute);
function request(path: string, body: unknown, bearer?: string, extraEnv: Partial<Env> = {}) {
  return app.request(
    `/projects/project/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    },
    { ...extraEnv, DATABASE: database } as Env,
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
    schema.deploymentEnvironmentConfigVars,
  ]);
  database = createSqliteD1(sqlite);
  sqlite.exec(
    "INSERT INTO deployment_environments(id,project_id,node_id,status) VALUES('environment','project','node','running')"
  );
  sqlite.exec(
    "INSERT INTO deployment_publish_jobs(id,project_id,workspace_id,environment_id,node_id,requested_by,status,attempt) VALUES('job','project','workspace','environment','node','user','building',1)"
  );
  lifecycle.mockClear();
  provisionVolumes.mockClear();
  cancelVm.mockClear();
  stopBuilder.mockClear();
});
afterEach(() => sqlite.close());
describe('publish callback routes with real SQL', () => {
  it('rejects a canceled volume release before provisioning, while the live owner provisions', async () => {
    const volumeSubmission = {
      composeYaml:
        'services:\n  web:\n    image: nginx:latest\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n',
    };
    sqlite.exec("UPDATE deployment_publish_jobs SET status = 'canceled'");
    const late = await submit(volumeSubmission);
    expect(late.status, await late.clone().text()).toBe(409);
    expect(provisionVolumes).not.toHaveBeenCalled();
    expect(releases()).toHaveLength(0);
    sqlite.exec("UPDATE deployment_publish_jobs SET status = 'building'");
    const owner = await submit(volumeSubmission);
    expect(owner.status, await owner.clone().text()).toBe(200);
    expect(provisionVolumes).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'building'])(
    'rejects malformed terminal status %s before writes',
    async (status) => {
      const before = sqlite.prepare('SELECT * FROM deployment_publish_jobs').get();
      expect(
        (
          await request('deployment-publish-jobs/job/events', {
            eventType: 'publish.done',
            message: 'done',
            terminal: true,
            status,
          })
        ).status
      ).toBe(400);
      expect(sqlite.prepare('SELECT * FROM deployment_publish_jobs').get()).toEqual(before);
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()
      ).toEqual({ n: 0 });
      expect(
        (
          await request('deployment-publish-jobs/job/events', {
            eventType: 'publish.done',
            message: 'done',
            terminal: true,
            status: 'succeeded',
          })
        ).status
      ).toBe(200);
    }
  );
  it('returns 409 on conflicting release metadata and accepts the linked release', async () => {
    sqlite.exec("UPDATE deployment_publish_jobs SET release_id = 'owner', release_version = 1");
    const before = sqlite.prepare('SELECT * FROM deployment_publish_jobs').get();
    expect(
      (
        await request('deployment-publish-jobs/job/events', {
          eventType: 'publish.release',
          message: 'release',
          releaseVersion: 9,
        })
      ).status
    ).toBe(400);
    const event = {
      eventType: 'publish.release',
      message: 'release',
      status: 'building',
      releaseVersion: 9,
      releaseStatus: 'ready',
    };
    expect(
      (await request('deployment-publish-jobs/job/events', { ...event, releaseId: 'other' })).status
    ).toBe(409);
    expect(sqlite.prepare('SELECT * FROM deployment_publish_jobs').get()).toEqual(before);
    expect(sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()).toEqual(
      { n: 0 }
    );
    expect(
      (await request('deployment-publish-jobs/job/events', { ...event, releaseId: 'owner' })).status
    ).toBe(200);
  });

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
    // Workspace, requester, node, job, then the configured cancel timeout.
    expect(cancelVm).toHaveBeenCalledWith(
      expect.anything(),
      'workspace',
      expect.any(String),
      expect.any(String),
      'job',
      10
    );
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
  it('shadow rows cannot submit/link releases or emit public publish events', async () => {
    sqlite.exec('UPDATE deployment_publish_jobs SET context_shadow=1');
    expect((await submit()).status).toBe(409);
    expect(releases()).toHaveLength(0);
    const event = {
      status: 'context_ready',
      eventType: 'publish.context.collected',
      message: 'collected',
    };
    expect((await request('deployment-publish-jobs/job/events', event)).status).toBe(200);
    expect(lifecycle).not.toHaveBeenCalled();
    sqlite.exec("UPDATE deployment_publish_jobs SET context_shadow=0, status='building'");
    expect((await submit()).status).toBe(200);
  });
});

describe('real signed job tokens through actual publish callback routes', () => {
  async function identity() {
    sqlite.exec(
      "UPDATE deployment_publish_jobs SET executor='cloudflare',executor_instance_id='job',context_shadow=0,agent_profile_id='profile',environment_name='staging'"
    );
    const env = {
      ...keyEnv,
      DATABASE: database,
      R2: { head: async () => ({ size: 100 }) },
      CF_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'fake-access',
      R2_SECRET_ACCESS_KEY: 'fake-secret',
      R2_BUCKET_NAME: 'bucket',
      COMPOSE_BUILDER: { idFromName: (id: string) => id, get: () => ({ stopJob: stopBuilder }) },
    } as unknown as Env;
    const token = await signPublishJobToken(
      env,
      {
        jobId: 'job',
        projectId: 'project',
        environmentId: 'environment',
        agentProfileId: 'profile',
        attempt: 1,
      },
      Date.now() + 60000
    );
    return { env, token };
  }
  const artifact = {
    serviceName: 'web',
    sourceRef: 'fixture:latest',
    localImageRef: 'fixture:latest',
    r2Key: 'compose-image-artifacts/project/environment/workspace/job-1/web.docker-save.tar',
    sizeBytes: 100,
    archiveSha256: 'sha256:' + 'a'.repeat(64),
    archiveType: 'docker-save',
    mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
    platform: { os: 'linux', architecture: 'amd64' },
  };
  it('parses the original body at events, artifact init/complete and release sinks, then revokes terminal identity', async () => {
    const { env, token } = await identity();
    const policy = {
      environment: 'staging',
      environmentId: 'environment',
      agentProfileId: 'profile',
    };
    const progress = await request(
      'deployment-publish-jobs/job/events',
      { eventType: 'publish.build.started', message: 'building', status: 'building' },
      token,
      env
    );
    expect(progress.status, await progress.clone().text()).toBe(200);
    const init = await request(
      'compose-image-artifacts/init',
      { ...policy, services: [{ serviceName: 'web', sourceRef: 'fixture:latest' }] },
      token,
      env
    );
    expect(init.status, await init.clone().text()).toBe(200);
    expect(await init.json()).toMatchObject({ uploadId: 'job-1' });
    const complete = await request(
      'compose-image-artifacts/complete',
      { ...policy, artifacts: [artifact] },
      token,
      env
    );
    expect(complete.status, await complete.clone().text()).toBe(200);
    const release = await request(
      'compose-publish-release',
      {
        publishJobId: 'job',
        attempt: 1,
        environment: 'staging',
        environmentId: 'environment',
        composeYaml: 'services:\n  web:\n    image: fixture:latest\n',
        services: [artifact],
        submittedBy: { agentProfileId: 'profile' },
      },
      token,
      env
    );
    expect(release.status, await release.clone().text()).toBe(200);
    const recorded = await release.json();
    const terminal = await request(
      'deployment-publish-jobs/job/events',
      {
        eventType: 'publish.job.completed',
        message: 'complete',
        status: 'succeeded',
        releaseId: recorded.releaseId,
      },
      token,
      env
    );
    expect(terminal.status, await terminal.clone().text()).toBe(200);
    expect(stopBuilder).toHaveBeenCalled();
    expect(
      (
        await request(
          'compose-image-artifacts/init',
          { ...policy, services: [{ serviceName: 'web', sourceRef: 'fixture:latest' }] },
          token,
          env
        )
      ).status
    ).toBe(410);
  });
  it('serves only a verified admitted context through the existing job spec route', async () => {
    const { env, token } = await identity();
    const get = (id = 'job') =>
      app.request(
        `/projects/project/deployment-publish-jobs/${id}/spec`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
        env
      );
    expect((await get()).status).toBe(409);
    sqlite
      .prepare(
        'UPDATE deployment_publish_jobs SET context_r2_key=?,context_sha256=?,context_bytes=100,context_project_name=?,executor_deadline_at=?'
      )
      .run(
        'compose-build-contexts/project/environment/job/1.tar.zst',
        'a'.repeat(64),
        'source-project',
        new Date(Date.now() + 60000).toISOString()
      );
    const response = await get();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      jobId: 'job',
      attempt: 1,
      projectName: 'source-project',
      contextBytes: 100,
      buildInterpolationEnv: {},
      secretInterpolationKeys: [],
    });
    expect((await get('foreign')).status).toBe(403);
    sqlite.exec("UPDATE deployment_publish_jobs SET status='canceled'");
    expect((await get()).status).toBe(410);
  });
  it('rejects missing release fence and foreign artifact attempts with live owner controls', async () => {
    const { env, token } = await identity();
    const policy = {
      environment: 'staging',
      environmentId: 'environment',
      agentProfileId: 'profile',
    };
    expect(
      (
        await request(
          'compose-publish-release',
          { ...policy, submittedBy: { agentProfileId: 'profile' } },
          token,
          env
        )
      ).status
    ).toBe(403);
    expect(
      (
        await request(
          'compose-image-artifacts/complete',
          {
            ...policy,
            artifacts: [{ ...artifact, r2Key: artifact.r2Key.replace('job-1', 'job-2') }],
          },
          token,
          env
        )
      ).status
    ).toBe(403);
    expect(
      (
        await request(
          'compose-image-artifacts/complete',
          { ...policy, artifacts: [artifact] },
          token,
          env
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          'deployment-publish-jobs/job/events',
          { eventType: 'publish.release', message: 'fake', releaseId: 'foreign' },
          token,
          env
        )
      ).status
    ).toBe(403);
  });
});
