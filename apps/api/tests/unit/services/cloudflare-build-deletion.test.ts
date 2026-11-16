import {
  admitCloudflareBuild,
  appendDeploymentPublishJobEvent,
  assertNoReservedCloudflareBuilds,
  type CloudflareBuildPorts,
  drainCloudflareBuilds,
  forceReleaseExpiredCloudflareBuild,
  isCloudflareBuildDeletionConflict,
  releaseCloudflareBuildReservation,
} from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { applySqliteMigration, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const limits = { platform: 6, project: 2, classMax: 6, deadlineMs: 1_200_000 };
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const table of [
    'projects',
    'deployment_environments',
    'nodes',
    'users',
    'deployment_releases',
    'workspaces',
  ]) {
    sqlite.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY); INSERT INTO ${table} VALUES ('owner')`
    );
  }
  // Real job FKs and shipped trigger, not the constraint-free schema test helper.
  for (const file of [
    '0077_deployment_publish_jobs.sql',
    '0227_publish_job_heartbeat.sql',
    '0230_publish_job_build_context.sql',
    '0231_publish_job_context_shadow.sql',
    '0242_cloudflare_build_executor.sql',
    '0244_cloudflare_build_reservation_deletion_guard.sql',
  ]) {
    applySqliteMigration(sqlite, new URL(`../../../src/db/migrations/${file}`, import.meta.url));
  }
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs
    (id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,executor,status,context_r2_key,context_sha256,created_at)
    VALUES ('job','owner','owner','owner','owner','owner','production','cloudflare','context_ready','key','sha',?)`
    )
    .run(new Date().toISOString());
  db = drizzle(createSqliteD1(sqlite), { schema });
});
afterEach(() => sqlite.close());

describe('Cloudflare reservation deletion fence', () => {
  it.each(['deployment_publish_jobs', 'nodes', 'projects', 'deployment_environments', 'users'])(
    'blocks %s deletion, even for terminal reservations, then allows it after confirmed release',
    async (table) => {
      expect(await admitCloudflareBuild(db, 'job', limits)).toBeTruthy();
      const id = table === 'deployment_publish_jobs' ? 'job' : 'owner';
      for (const status of ['starting', 'building', 'canceled', 'succeeded']) {
        sqlite.prepare('UPDATE deployment_publish_jobs SET status=?').run(status);
        expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(id)).toThrow(
          'cloudflare_build_reservation_held'
        );
        expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toEqual({
          id: 'job',
        });
        if (table !== 'deployment_publish_jobs')
          expect(sqlite.prepare(`SELECT id FROM ${table}`).get()).toBeTruthy();
      }
      await releaseCloudflareBuildReservation(db, 'job', 1);
      sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toBeUndefined();
    }
  );
  it.each(["executor='node'", 'context_shadow=1', 'executor_instance_id=NULL'])(
    'preserves legacy, shadow and unreserved deletion behavior: %s',
    (mutation) => {
      sqlite.prepare("UPDATE deployment_publish_jobs SET executor_instance_id='job'").run();
      sqlite.exec(`UPDATE deployment_publish_jobs SET ${mutation}`);
      sqlite.exec("DELETE FROM nodes WHERE id='owner'");
      expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toBeUndefined();
    }
  );
  it('delete-before-admission cannot acquire a missing job', async () => {
    sqlite.exec("DELETE FROM projects WHERE id='owner'");
    expect(await admitCloudflareBuild(db, 'job', limits)).toBeNull();
  });
  it('workspace deletion does not erase the job: workspace_id has deliberately never been an FK', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    sqlite.exec("DELETE FROM workspaces WHERE id='owner'");
    expect(
      sqlite.prepare('SELECT executor_instance_id FROM deployment_publish_jobs').get()
    ).toEqual({ executor_instance_id: 'job' });
  });
  it('preflights all supported scopes, including terminal-but-stop-pending, and permits after release', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    sqlite.exec("UPDATE deployment_publish_jobs SET status='succeeded'");
    for (const scope of [{ nodeId: 'owner' }, { projectId: 'owner' }, { environmentId: 'owner' }]) {
      await expect(assertNoReservedCloudflareBuilds(db, scope)).rejects.toMatchObject({
        statusCode: 409,
      });
    }
    await expect(
      assertNoReservedCloudflareBuilds(db, { nodeId: 'other' })
    ).resolves.toBeUndefined();
    await releaseCloudflareBuildReservation(db, 'job', 1);
    await expect(
      assertNoReservedCloudflareBuilds(db, { nodeId: 'owner' })
    ).resolves.toBeUndefined();
  });
  it('maps a wrapped final-mutation conflict to a safe 409 response', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.delete('/resource', () => {
      throw new Error('Failed query with private params', {
        cause: new Error('D1_ERROR: cloudflare_build_reservation_held: SQLITE_CONSTRAINT'),
      });
    });
    const response = await app.request('/resource', { method: 'DELETE' }, {} as Env);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('private params');
  });
  it('recognizes only the fixed trigger marker through nested D1 causes, with cycle protection', () => {
    const cause = new Error('D1_ERROR: cloudflare_build_reservation_held: SQLITE_CONSTRAINT');
    expect(
      isCloudflareBuildDeletionConflict(new Error('Failed query: private params', { cause }))
    ).toBe(true);
    expect(isCloudflareBuildDeletionConflict(new Error('another constraint'))).toBe(false);
    const cycle = new Error('cycle');
    cycle.cause = cycle;
    expect(isCloudflareBuildDeletionConflict(cycle)).toBe(false);
  });
});

describe('bounded reservation escape with real deletion FKs', () => {
  const graceMs = 300000;
  function ports(): CloudflareBuildPorts {
    return {
      classMax: 6,
      settings: {
        resolveSetting: async (name) =>
          ({
            'deployments.builderReservationGraceMs': graceMs,
            'deployments.builderDrainLimit': 6,
            'deployments.builderProjectMaxConcurrent': 2,
            'deployments.publishJobDeadlineMs': 1800000,
          })[name as string],
      },
      builder: {
        start: vi.fn(async () => 'started' as const),
        stop: vi.fn(async () => {
          throw new Error('unreachable DO');
        }),
      },
      lifecycle: { recordPublishJobLifecycleEventBestEffort: vi.fn(async () => {}) },
    };
  }
  it.each(['building', 'succeeded', 'canceled'])(
    'force releases an unreachable %s reservation after deadline + grace, then parent deletion succeeds',
    async (status) => {
      await admitCloudflareBuild(db, 'job', limits);
      sqlite
        .prepare('UPDATE deployment_publish_jobs SET status=?, executor_deadline_at=?')
        .run(status, new Date(Date.now() - graceMs - 1000).toISOString());
      const p = ports();
      await drainCloudflareBuilds(createSqliteD1(sqlite), p);
      expect(p.builder.stop).not.toHaveBeenCalled();
      expect(
        sqlite.prepare('SELECT status, executor_instance_id FROM deployment_publish_jobs').get()
      ).toEqual({
        status: status === 'building' ? 'unknown' : status,
        executor_instance_id: null,
      });
      expect(
        sqlite
          .prepare('SELECT level,event_type,detail_json FROM deployment_publish_job_events')
          .get()
      ).toMatchObject({
        level: 'alert',
        event_type: 'publish.builder.reservation_force_released',
        detail_json: expect.stringContaining('"physicalStopConfirmed":false'),
      });
      // A late scoped callback cannot revive or mutate the forced-terminal job.
      expect(
        await appendDeploymentPublishJobEvent(db, {
          publishJobId: 'job',
          projectId: 'owner',
          environmentId: 'owner',
          workspaceId: 'owner',
          nodeId: 'owner',
          expectedAttempt: 1,
          expectedExecutor: 'cloudflare',
          expectedExecutorInstanceId: 'job',
          eventType: 'publish.job.heartbeat',
          message: 'late heartbeat',
          status: 'building',
        })
      ).toBe(false);
      // A second tick cannot produce duplicate alerts or restart the job.
      await drainCloudflareBuilds(createSqliteD1(sqlite), p);
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()
      ).toEqual({ n: 1 });
      sqlite.exec("DELETE FROM nodes WHERE id='owner'");
      expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toBeUndefined();
    }
  );
  it('retains the reservation and blocks cascading account deletion inside grace despite a failed stop', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    sqlite
      .prepare("UPDATE deployment_publish_jobs SET status='canceled',executor_deadline_at=?")
      .run(new Date(Date.now() - graceMs + 60000).toISOString());
    const p = ports();
    await drainCloudflareBuilds(createSqliteD1(sqlite), p);
    expect(p.builder.stop).toHaveBeenCalledTimes(1);
    expect(() => sqlite.exec("DELETE FROM users WHERE id='owner'")).toThrow(
      'cloudflare_build_reservation_held'
    );
    expect(sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()).toEqual(
      { n: 0 }
    );
  });
  it.each([
    'attempt=2',
    "executor_not_before='replacement'",
    "executor_deadline_at='2999-01-01T00:00:00.000Z'",
    "executor_instance_id='other'",
  ])('a stale expiry candidate cannot release a replacement: %s', async (mutation) => {
    await admitCloudflareBuild(db, 'job', limits);
    sqlite
      .prepare('UPDATE deployment_publish_jobs SET executor_deadline_at=?')
      .run(new Date(Date.now() - graceMs - 1000).toISOString());
    const job = await db.query.deploymentPublishJobs.findFirst();
    sqlite.exec(`UPDATE deployment_publish_jobs SET ${mutation}`);
    expect(await forceReleaseExpiredCloudflareBuild(db, job!, graceMs)).toBe(false);
    expect(() => sqlite.exec("DELETE FROM projects WHERE id='owner'")).toThrow(
      'cloudflare_build_reservation_held'
    );
  });
  it('one expiry mutation failure does not suppress the next reserved job', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    const deadline = new Date(Date.now() - graceMs - 1000).toISOString();
    sqlite
      .prepare("UPDATE deployment_publish_jobs SET status='building',executor_deadline_at=?")
      .run(deadline);
    sqlite
      .prepare(
        `INSERT INTO deployment_publish_jobs
      (id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,executor,status,executor_instance_id,executor_deadline_at)
      VALUES ('job2','owner','owner','owner','owner','owner','production','cloudflare','building','job2',?)`
      )
      .run(deadline);
    sqlite.exec(`CREATE TRIGGER reject_first_release BEFORE UPDATE ON deployment_publish_jobs
      WHEN OLD.id='job' AND NEW.executor_instance_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'first mutation unavailable'); END`);
    await drainCloudflareBuilds(createSqliteD1(sqlite), ports());
    expect(
      sqlite
        .prepare('SELECT id FROM deployment_publish_jobs WHERE executor_instance_id IS NOT NULL')
        .all()
    ).toEqual([{ id: 'job' }]);
    expect(
      sqlite.prepare("SELECT status FROM deployment_publish_jobs WHERE id='job2'").get()
    ).toEqual({ status: 'unknown' });
  });
  it('an alert persistence failure cannot wedge release or prevent later expired candidates', async () => {
    await admitCloudflareBuild(db, 'job', limits);
    const deadline = new Date(Date.now() - graceMs - 1000).toISOString();
    sqlite.prepare('UPDATE deployment_publish_jobs SET executor_deadline_at=?').run(deadline);
    sqlite
      .prepare(
        `INSERT INTO deployment_publish_jobs
      (id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,executor,status,executor_instance_id,executor_deadline_at)
      VALUES ('job2','owner','owner','owner','owner','owner','production','cloudflare','canceled','job2',?)`
      )
      .run(deadline);
    sqlite.exec(`CREATE TRIGGER reject_alert BEFORE INSERT ON deployment_publish_job_events
      BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END`);
    await drainCloudflareBuilds(createSqliteD1(sqlite), ports());
    expect(
      sqlite
        .prepare(
          'SELECT count(*) AS n FROM deployment_publish_jobs WHERE executor_instance_id IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });
    sqlite.exec("DELETE FROM users WHERE id='owner'");
    expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toBeUndefined();
  });
});
