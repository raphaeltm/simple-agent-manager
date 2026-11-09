import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError, errors } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
const lifecycle = vi.hoisted(() => vi.fn(async () => undefined));
const signed = vi.hoisted(() => vi.fn(async () => 'https://signed.invalid/object'));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: signed }));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: async (token: string) => {
    if (token !== 'callback') throw errors.unauthorized('Invalid token');
    return { scope: 'workspace', workspace: 'workspace', type: 'callback' };
  },
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: async (_env: unknown, key: string) =>
    key.endsWith('MaxBytes') ? 2048 : 300,
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: lifecycle,
}));
vi.mock('../../../src/services/workspace-deletion-callback-signal', () => ({
  signalWorkspaceDeletionUnconfirmedCallback: async () => undefined,
}));
const { buildContextCallbackRoute } =
  await import('../../../src/routes/projects/build-context-callback');
let sqlite: Database.Database;
let env: Env;
const sha256 = 'a'.repeat(64);
const head = vi.fn();
const app = new Hono<{ Bindings: Env }>();
app.onError((err, c) =>
  err instanceof AppError
    ? c.json(err.toJSON(), err.statusCode)
    : c.json({ error: err.message }, 500)
);
app.route('/api/projects', buildContextCallbackRoute);
// A leaking session-auth mount would reject the live callback control.
app.use('/api/projects/*', async () => {
  throw errors.unauthorized('Session required');
});
function request(operation: string, body: unknown = {}, project = 'project', token = 'callback') {
  return app.request(
    `/api/projects/${project}/deployment-publish-jobs/job/context/${operation}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempt: 1, sizeBytes: 100, sha256, ...(body as object) }),
    },
    env,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.deploymentPublishJobs,
    schema.deploymentPublishJobEvents,
    schema.workspaces,
    schema.nodes,
    schema.deploymentEnvironments,
  ]);
  sqlite.exec(
    "INSERT INTO nodes(id,status) VALUES('node','running'); INSERT INTO workspaces(id,project_id,user_id,status,node_id) VALUES('workspace','project','user','running','node'); INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,agent_profile_id,status,executor,attempt) VALUES('job','project','env','workspace','node','user','staging','profile','queued','cloudflare',1)"
  );
  sqlite.exec(
    "INSERT INTO deployment_environments(id,project_id,name,status,agent_deploy_enabled) VALUES('env','project','staging','active',1)"
  );
  head.mockResolvedValue({ size: 100, customMetadata: { sha256 } });
  env = {
    DATABASE: createSqliteD1(sqlite),
    R2: { head },
    CF_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'fake-access',
    R2_SECRET_ACCESS_KEY: 'fake-secret',
    R2_BUCKET_NAME: 'bucket',
  } as unknown as Env;
});
afterEach(() => sqlite.close());
describe('context callback vertical slice with real SQLite and callback middleware', () => {
  it('lets unrestricted policy admit a profile-less callback and rechecks policy on completion', async () => {
    sqlite.exec('UPDATE deployment_publish_jobs SET agent_profile_id=NULL');
    expect((await request('init')).status).toBe(200);
    sqlite.exec(
      'UPDATE deployment_environments SET allowed_deploy_profile_ids_json=\'["profile"]\''
    );
    expect((await request('complete')).status).toBe(403);
    expect(head).not.toHaveBeenCalled();
    sqlite.exec('UPDATE deployment_environments SET allowed_deploy_profile_ids_json=NULL');
    expect((await request('complete')).status).toBe(200);
  });
  it('rejects a profile-less callback when deployment is disabled or profile-restricted', async () => {
    sqlite.exec(
      'UPDATE deployment_publish_jobs SET agent_profile_id=NULL; UPDATE deployment_environments SET agent_deploy_enabled=0'
    );
    expect((await request('init')).status).toBe(403);
    sqlite.exec(
      'UPDATE deployment_environments SET agent_deploy_enabled=1,allowed_deploy_profile_ids_json=\'["profile"]\''
    );
    expect((await request('init')).status).toBe(403);
    expect(signed).not.toHaveBeenCalled();
  });
  it('live owner completes and signs only server-derived key', async () => {
    expect((await request('init')).status).toBe(200);
    const [, command] = signed.mock.calls[0] as unknown as [
      unknown,
      { input: Record<string, unknown> },
    ];
    expect(command.input).toMatchObject({
      Key: 'compose-build-contexts/project/env/job/1.tar.zst',
      ContentLength: 100,
      Metadata: { sha256 },
    });
    expect((await request('complete')).status).toBe(200);
    expect(head).toHaveBeenCalledWith('compose-build-contexts/project/env/job/1.tar.zst');
    expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
      status: 'context_ready',
    });
    expect((await request('complete')).status).toBe(409);
  });
  it.each([
    null,
    { size: 99, customMetadata: { sha256 } },
    { size: 100, customMetadata: { sha256: 'b'.repeat(64) } },
    { size: 100 },
  ])('rejects missing/wrong size/hash R2 object %s', async (value) => {
    expect((await request('init')).status).toBe(200);
    head.mockResolvedValue(value);
    expect((await request('complete')).status).toBe(400);
    expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
      status: 'collecting',
    });
    head.mockResolvedValue({ size: 100, customMetadata: { sha256 } });
    expect((await request('complete')).status).toBe(200);
  });
  it('rejects cross-project identity and invalid credential with live owner control', async () => {
    expect((await request('init', {}, 'other')).status).toBe(403);
    expect((await request('init', {}, 'project', 'bad')).status).toBe(401);
    expect(signed).not.toHaveBeenCalled();
    expect((await request('init')).status).toBe(200);
  });
  it.each(['stopped', 'sleeping', 'deleted'])('rejects inactive workspace %s', async (status) => {
    sqlite.prepare('UPDATE workspaces SET status=?').run(status);
    expect((await request('init')).status).toBe(410);
    expect(signed).not.toHaveBeenCalled();
    sqlite.prepare("UPDATE workspaces SET status='running'").run();
    expect((await request('init')).status).toBe(200);
  });
  it('fences stale attempts and cancellation without reviving job', async () => {
    expect((await request('init', { attempt: 2 })).status).toBe(409);
    expect((await request('init')).status).toBe(200);
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='canceled'").run();
    expect((await request('complete')).status).toBe(409);
  });
  it('rejects malformed and over-limit descriptors before signing', async () => {
    expect((await request('init', { sha256: 'not-a-digest' })).status).toBe(400);
    expect((await request('init', { sizeBytes: 3000 })).status).toBe(400);
    expect(signed).not.toHaveBeenCalled();
    expect((await request('init')).status).toBe(200);
  });
  it('shadow init/complete records internal timing without project publish events', async () => {
    sqlite.exec('UPDATE deployment_publish_jobs SET context_shadow=1');
    expect((await request('init', { durationMs: 123 })).status).toBe(200);
    expect((await request('complete', { durationMs: 123 })).status).toBe(200);
    expect(lifecycle).not.toHaveBeenCalled();
    const event = sqlite
      .prepare(
        "SELECT detail_json FROM deployment_publish_job_events WHERE event_type='publish.context.context_ready'"
      )
      .get() as { detail_json: string };
    expect(JSON.parse(event.detail_json)).toMatchObject({ collectionDurationMs: 123 });
  });
});
