import { admitCloudflareBuild } from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const auth = vi.hoisted(() => ({ verify: vi.fn(), lifecycle: vi.fn(async () => undefined) }));
vi.mock('../../../src/routes/projects/_publish-callback-auth', () => ({
  verifyPublishCallback: auth.verify,
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: auth.lifecycle,
}));
vi.mock('../../../src/routes/projects/publish-job-spec', async () => {
  const { Hono } = await import('hono');
  return { publishJobSpecRoute: new Hono() };
});
import { deploymentPublishJobCallbackRoute } from '../../../src/routes/projects/deployment-publish-job-callback';

let sqlite: Database.Database;
let database: D1Database;
let admitAtCallbackFence: boolean;
const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) =>
  c.json({ error: error.message }, error instanceof AppError ? error.statusCode : 500)
);
app.route('/api/projects', deploymentPublishJobCallbackRoute);
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs, schema.deploymentPublishJobEvents]);
  database = createSqliteD1(sqlite);
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs
    (id,project_id,environment_id,workspace_id,node_id,requested_by,executor,context_shadow,status,current_step,attempt,context_r2_key,context_sha256,created_at,updated_at)
    VALUES ('job','project','env','workspace','node','user','cloudflare',0,'context_ready','context_ready',1,'context','digest',?,?)`
    )
    .run(new Date().toISOString(), new Date().toISOString());
  admitAtCallbackFence = false;
  auth.verify.mockImplementation(async () => ({
    projectId: 'project',
    workspaceId: 'workspace',
    userId: 'user',
    db: drizzle(database, { schema }),
    assertCurrent: async () => {
      if (admitAtCallbackFence) {
        admitAtCallbackFence = false;
        await admit();
      }
    },
  }));
});
afterEach(() => sqlite.close());
async function admit() {
  expect(
    await admitCloudflareBuild(drizzle(database, { schema }), 'job', {
      platform: 6,
      project: 2,
      classMax: 6,
      deadlineMs: 1800000,
    })
  ).toBeTruthy();
}
function row() {
  return sqlite
    .prepare(
      "SELECT status,current_step,executor_instance_id FROM deployment_publish_jobs WHERE id='job'"
    )
    .get();
}
function collected(extra = {}) {
  return app.request(
    '/api/projects/project/deployment-publish-jobs/job/events',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'publish.context.collected',
        message: 'build context collection complete',
        status: 'context_ready',
        currentStep: 'context_ready',
        ...extra,
      }),
    },
    { DATABASE: database } as Env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  );
}
describe('source collector completion after verified-context handoff', () => {
  it.each([false, true])(
    'does not undo atomic admission (admission races callback read: %s)',
    async (race) => {
      if (race) admitAtCallbackFence = true;
      else await admit();
      const response = await collected();
      expect(response.status).toBe(200);
      expect(row()).toEqual({
        status: 'starting',
        current_step: 'builder_start',
        executor_instance_id: 'job',
      });
      expect(sqlite.prepare('SELECT event_type FROM deployment_publish_job_events').all()).toEqual([
        { event_type: 'publish.context.collected' },
      ]);
      expect(auth.lifecycle).not.toHaveBeenCalled();
    }
  );
  it('keeps recording source receipt without replacing builder progress', async () => {
    await admit();
    sqlite
      .prepare("UPDATE deployment_publish_jobs SET status='building', current_step='build'")
      .run();
    expect((await collected()).status).toBe(200);
    expect(row()).toEqual({
      status: 'building',
      current_step: 'build',
      executor_instance_id: 'job',
    });
  });
  it('does not let the generic collector receipt replace context verification', async () => {
    sqlite
      .prepare("UPDATE deployment_publish_jobs SET status='collecting', current_step='collecting'")
      .run();
    expect((await collected()).status).toBe(200);
    expect(row()).toMatchObject({ status: 'collecting', current_step: 'collecting' });
  });
  it('preserves terminal completion for phase-2 shadow collection', async () => {
    sqlite.prepare('UPDATE deployment_publish_jobs SET context_shadow=1').run();
    expect((await collected({ status: 'succeeded', terminal: true })).status).toBe(200);
    expect(row()).toMatchObject({ status: 'succeeded' });
  });
  it('rejects a delayed collector receipt after terminal completion without writes', async () => {
    sqlite
      .prepare("UPDATE deployment_publish_jobs SET status='failed', current_step='deadline'")
      .run();
    const before = row();
    expect((await collected()).status).toBe(409);
    expect(row()).toEqual(before);
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM deployment_publish_job_events').get()
    ).toEqual({ count: 0 });
    expect(auth.lifecycle).not.toHaveBeenCalled();
  });
  it('accepts a real builder heartbeat with no status or step after admission', async () => {
    await admit();
    sqlite.prepare("UPDATE deployment_publish_jobs SET last_heartbeat_at='2000-01-01T00:00:00.000Z'").run();
    auth.verify.mockResolvedValue({ projectId: 'project', workspaceId: 'workspace', userId: 'user', db: drizzle(database, { schema }), assertCurrent: async () => {}, job: { attempt: 1 } });
    expect((await collected({eventType:'publish.job.heartbeat',status:undefined,currentStep:undefined})).status).toBe(200);
    expect(row()).toMatchObject({status:'starting',current_step:'builder_start'});
    expect(sqlite.prepare('SELECT last_heartbeat_at FROM deployment_publish_jobs').get()).not.toEqual({last_heartbeat_at:'2000-01-01T00:00:00.000Z'});
  });

});
