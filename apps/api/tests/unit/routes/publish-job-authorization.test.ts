import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { verifyPublishCallback } from '../../../src/routes/projects/_publish-callback-auth';
import { signPublishJobToken } from '../../../src/services/publish-job-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
let sqlite: Database.Database;
let env: Env;
let keys: { JWT_PRIVATE_KEY: string; JWT_PUBLIC_KEY: string };
let token: string;
const claims = {
  jobId: 'job',
  projectId: 'project',
  environmentId: 'env',
  agentProfileId: 'profile',
  attempt: 1,
};
const release = {
  environment: 'staging',
  environmentId: 'env',
  publishJobId: 'job',
  attempt: 1,
  submittedBy: { agentProfileId: 'profile', taskId: 'task' },
  services: [{ r2Key: 'compose-image-artifacts/project/env/ws/job-1/web.docker-save.tar' }],
};
beforeAll(async () => {
  const p = await generateKeyPair('RS256', { extractable: true });
  keys = {
    JWT_PRIVATE_KEY: await exportPKCS8(p.privateKey),
    JWT_PUBLIC_KEY: await exportSPKI(p.publicKey),
  };
});
beforeEach(async () => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs]);
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,status,executor,context_shadow,agent_profile_id,attempt,task_id) VALUES('job','project','env','ws','node','user','staging','building','cloudflare',0,'profile',1,'task')`
    )
    .run();
  env = { ...keys, BASE_DOMAIN: 'example.test', DATABASE: createSqliteD1(sqlite) } as Env;
  token = await signPublishJobToken(env, claims, Date.now() + 60_000);
});
afterEach(() => sqlite.close());
function request(body: unknown, project = 'project') {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((e, c) => c.json({ error: e.message }, e instanceof AppError ? e.statusCode : 500));
  app.post('/:id/compose-publish-release', async (c) => {
    const v = await verifyPublishCallback(c, 'compose_publish_release', 'scope');
    await v.assertCurrent();
    await c.req.raw.json();
    return c.json({ jobId: v.job?.id });
  });
  return app.request(
    `/${project}/compose-publish-release`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}
describe('publish-job release authorization uses real signatures and SQLite ownership', () => {
  it('accepts owner without a source workspace or node', async () => {
    expect((await request(release)).status).toBe(200);
  });
  for (const mutation of [
    { publishJobId: undefined },
    { attempt: undefined },
    { publishJobId: 'foreign' },
    { attempt: 2 },
    { environment: 'other' },
    { environmentId: 'other' },
    { submittedBy: { agentProfileId: 'foreign', taskId: 'task' } },
    { submittedBy: { agentProfileId: 'profile', taskId: 'other' } },
    { services: [{ r2Key: 'compose-image-artifacts/project/env/ws/job-2/web.docker-save.tar' }] },
    {
      services: [{ r2Key: 'compose-image-artifacts/project/env/ws/foreign-1/web.docker-save.tar' }],
    },
  ])
    it(`rejects scope smuggling ${JSON.stringify(mutation)} with owner control`, async () => {
      expect((await request({ ...release, ...mutation })).status).toBe(403);
      expect((await request(release)).status).toBe(200);
    });
  it('rejects another project route and a canceled job', async () => {
    expect((await request(release, 'foreign')).status).toBe(403);
    sqlite.prepare("UPDATE deployment_publish_jobs SET status='canceled'").run();
    expect((await request(release)).status).toBe(410);
  });
});
