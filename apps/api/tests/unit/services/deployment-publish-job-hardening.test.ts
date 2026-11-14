import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { insertDeploymentReleaseWhilePlacementUnlocked } from '../../../src/routes/deployment-release-submission';
import {
  appendDeploymentPublishJobEvent,
  cancelDeploymentPublishJob,
  failExpiredDeploymentPublishJobs,
} from '../../../src/services/deployment-publish-jobs';
import { createDeclaredIndexes, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let database: D1Database;
const now = Date.parse('2026-11-06T12:00:00.000Z');
const recent = new Date(now - 1_000).toISOString();
const old = new Date(now - 600_000).toISOString();
const settings = { stallMs: 60_000, deadlineMs: 1_200_000, sweepLimit: 2 };
function db() {
  return drizzle(database, { schema });
}
function seed(
  id = 'job',
  status = 'building',
  createdAt = recent,
  lastEventAt = recent,
  lastHeartbeatAt: string | null = lastEventAt
) {
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs
    (id, project_id, workspace_id, environment_id, node_id, requested_by, status, attempt, created_at, updated_at, last_event_at, last_heartbeat_at)
    VALUES (?, 'project', 'workspace', 'environment', 'node', 'user', ?, 1, ?, ?, ?, ?)`
    )
    .run(id, status, createdAt, createdAt, lastEventAt, lastHeartbeatAt);
}
function row(id = 'job') {
  return sqlite.prepare('SELECT * FROM deployment_publish_jobs WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}
const event = {
  publishJobId: 'job',
  projectId: 'project',
  workspaceId: 'workspace',
  nodeId: 'node',
  environmentId: 'environment',
  eventType: 'build.progress',
  message: 'progress',
  status: 'building',
};
async function release(id: string, overrides = {}) {
  return insertDeploymentReleaseWhilePlacementUnlocked({
    db: db(),
    env: { DATABASE: database } as Env,
    publishJob: {
      id: 'job',
      attempt: 1,
      projectId: 'project',
      workspaceId: 'workspace',
      requestedBy: 'user',
      ...overrides,
    },
    values: {
      id,
      environmentId: 'environment',
      manifest: '{}',
      version: 1,
      status: 'created',
      statusUpdatedAt: recent,
      createdAt: recent,
      createdBy: 'user',
    },
  });
}
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.deploymentPublishJobs,
    schema.deploymentPublishJobEvents,
    schema.deploymentReleases,
    schema.deploymentEnvironments,
  ]);
  database = createSqliteD1(sqlite);
  sqlite
    .prepare("INSERT INTO deployment_environments(id, project_id) VALUES('environment', 'project')")
    .run();
});
afterEach(() => sqlite.close());

describe('publish job atomic guards on SQLite', () => {
  it.each([undefined, 'building'])(
    'rejects terminal flag with non-terminal status %s without writes',
    async (status) => {
      seed();
      const before = row();
      expect(
        await appendDeploymentPublishJobEvent(db(), { ...event, status, terminal: true })
      ).toBe(false);
      expect(row()).toEqual(before);
      expect(
        sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()
      ).toEqual({ n: 0 });
      expect(
        await appendDeploymentPublishJobEvent(db(), {
          ...event,
          status: 'succeeded',
          terminal: true,
        })
      ).toBe(true);
      expect(row().completed_at).toBeTruthy();
    }
  );
  it('rejects conflicting release metadata and accepts metadata for the linked release', async () => {
    seed();
    sqlite
      .prepare(
        "UPDATE deployment_publish_jobs SET release_id = 'owner', release_version = 1, release_status = 'created'"
      )
      .run();
    const before = row();
    expect(await appendDeploymentPublishJobEvent(db(), { ...event, releaseVersion: 99 })).toBe(
      false
    );
    expect(
      await appendDeploymentPublishJobEvent(db(), {
        ...event,
        releaseId: 'other',
        releaseVersion: 99,
        releaseStatus: 'failed',
      })
    ).toBe(false);
    expect(row()).toEqual(before);
    expect(sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()).toEqual(
      { n: 0 }
    );
    expect(
      await appendDeploymentPublishJobEvent(db(), {
        ...event,
        releaseId: 'owner',
        releaseVersion: 2,
        releaseStatus: 'ready',
      })
    ).toBe(true);
    expect(row()).toMatchObject({
      release_id: 'owner',
      release_version: 2,
      release_status: 'ready',
    });
  });
  it('accepted progress refreshes capable executor liveness while preserving legacy NULL', async () => {
    seed('job', 'building', old, old, old);
    seed('legacy', 'building', old, old, null);
    expect(await appendDeploymentPublishJobEvent(db(), event)).toBe(true);
    expect(await appendDeploymentPublishJobEvent(db(), { ...event, publishJobId: 'legacy' })).toBe(
      true
    );
    expect(row().last_heartbeat_at).not.toBe(old);
    expect(row('legacy').last_heartbeat_at).toBeNull();
    expect(
      await failExpiredDeploymentPublishJobs(
        db(),
        { ...settings, deadlineMs: 86_400_000_000 },
        Date.now()
      )
    ).toEqual([]);
  });

  it('preserves silent healthy builds and legacy jobs while expiring dead heartbeat-capable jobs', async () => {
    seed('alive', 'building', old, old, recent);
    seed('legacy', 'uploading', old, old, null);
    seed('dead', 'building', old, recent, old);
    const failed = await failExpiredDeploymentPublishJobs(db(), settings, now);
    expect(failed.map((job) => job.id)).toEqual(['dead']);
    expect(row('alive').status).toBe('building');
    expect(row('legacy').status).toBe('uploading');
    expect(row('dead')).toMatchObject({ status: 'failed', error_code: 'stalled', retryable: 1 });
  });
  it('records heartbeat capability without changing progress or allowing terminal resurrection', async () => {
    seed('job', 'building', old, old, null);
    expect(
      await appendDeploymentPublishJobEvent(db(), {
        ...event,
        eventType: 'publish.job.heartbeat',
        status: undefined,
      })
    ).toBe(true);
    expect(row()).toMatchObject({ status: 'building', last_event_at: old });
    expect(row().last_heartbeat_at).toBeTruthy();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM deployment_publish_job_events').get()).toEqual(
      { n: 0 }
    );
    await cancelDeploymentPublishJob(db(), 'project', 'workspace', 'job');
    const heartbeat = row().last_heartbeat_at;
    expect(
      await appendDeploymentPublishJobEvent(db(), {
        ...event,
        eventType: 'publish.job.heartbeat',
        status: undefined,
      })
    ).toBe(false);
    expect(row()).toMatchObject({ status: 'canceled', last_heartbeat_at: heartbeat });
  });
  it('still expires a heartbeat-free legacy job at the overall deadline', async () => {
    seed('legacy', 'building', new Date(now - settings.deadlineMs - 1).toISOString(), recent, null);
    expect(await failExpiredDeploymentPublishJobs(db(), settings, now)).toMatchObject([
      { id: 'legacy', status: 'failed', errorCode: 'deadline_exceeded', retryable: true },
    ]);
  });
  it('allows owner cancellation and fences late events and releases', async () => {
    seed();
    expect(await cancelDeploymentPublishJob(db(), 'project', 'workspace', 'job')).toMatchObject({
      status: 'canceled',
    });
    expect(await appendDeploymentPublishJobEvent(db(), event)).toBe(false);
    expect(await release('late')).toBe(false);
    expect(row().status).toBe('canceled');
    expect(sqlite.prepare('SELECT count(*) AS n FROM deployment_publish_job_events').get()).toEqual(
      { n: 0 }
    );
    expect(sqlite.prepare('SELECT count(*) AS n FROM deployment_releases').get()).toEqual({ n: 0 });
  });
  it.each(['succeeded', 'failed', 'canceled', 'unknown'])(
    'preserves terminal %s against cancel and events',
    async (status) => {
      seed('job', status);
      expect(await cancelDeploymentPublishJob(db(), 'project', 'workspace', 'job')).toBeNull();
      expect(await appendDeploymentPublishJobEvent(db(), event)).toBe(false);
      expect(row().status).toBe(status);
    }
  );
  it('enforces project and requesting workspace while retaining the owner path', async () => {
    seed();
    expect(await cancelDeploymentPublishJob(db(), 'foreign', 'workspace', 'job')).toBeNull();
    expect(await cancelDeploymentPublishJob(db(), 'project', 'foreign', 'job')).toBeNull();
    expect(row().status).toBe('building');
    expect(await appendDeploymentPublishJobEvent(db(), event)).toBe(true);
    expect(await cancelDeploymentPublishJob(db(), 'project', 'workspace', 'job')).not.toBeNull();
  });
  it('fails silent and deadline-exceeded jobs, bounds pages and preserves live/terminal jobs', async () => {
    seed('stalled', 'building', old, old);
    seed('deadline', 'building', new Date(now - settings.deadlineMs - 1).toISOString(), recent);
    seed('healthy');
    seed('terminal', 'succeeded', old, old);
    seed('overflow', 'queued', old, old);
    const failed = await failExpiredDeploymentPublishJobs(db(), settings, now);
    expect(failed).toHaveLength(2);
    expect(row('deadline')).toMatchObject({
      status: 'failed',
      error_code: 'deadline_exceeded',
      retryable: 1,
    });
    const rest = await failExpiredDeploymentPublishJobs(db(), settings, now);
    expect(rest).toHaveLength(1);
    expect(row('stalled')).toMatchObject({ status: 'failed', error_code: 'stalled', retryable: 1 });
    expect(row('healthy').status).toBe('building');
    expect(row('terminal').status).toBe('succeeded');
  });
  it.each(['heartbeat', 'cancel'])(
    'rechecks %s between sweep selection and update',
    async (race) => {
      seed('job', 'building', old, old);
      const originalPrepare = database.prepare.bind(database);
      let injected = false;
      database.prepare = (query: string) => {
        if (!injected && query.toLowerCase().startsWith('update "deployment_publish_jobs"')) {
          injected = true;
          if (race === 'heartbeat')
            sqlite.prepare('UPDATE deployment_publish_jobs SET last_heartbeat_at = ?').run(recent);
          else sqlite.exec("UPDATE deployment_publish_jobs SET status = 'canceled'");
        }
        return originalPrepare(query);
      };
      expect(await failExpiredDeploymentPublishJobs(db(), settings, now)).toEqual([]);
      expect(injected).toBe(true);
      expect(row().status).toBe(race === 'heartbeat' ? 'building' : 'canceled');
    }
  );
  it('does not regress an already building job to API acceptance', async () => {
    seed();
    expect(
      await appendDeploymentPublishJobEvent(db(), {
        ...event,
        status: 'starting',
        expectedStatus: 'queued',
      })
    ).toBe(false);
    expect(row().status).toBe('building');
  });

  it('uses status index ranges instead of scanning terminal history', async () => {
    createDeclaredIndexes(sqlite, [schema.deploymentPublishJobs]);
    seed('future', 'collecting', old, old);
    const plans: string[] = [];
    const prepare = database.prepare.bind(database);
    database.prepare = (query: string) => {
      const statement = prepare(query);
      if (query.startsWith('select "id" from "deployment_publish_jobs"')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          plans.push(
            ...(
              sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values) as { detail: string }[]
            ).map((row) => row.detail)
          );
          return bind(...values);
        };
      }
      return statement;
    };
    expect(await failExpiredDeploymentPublishJobs(db(), settings, now)).toHaveLength(1);
    expect(plans.join(' ')).toContain('idx_deployment_publish_jobs_status_updated_at');
    expect(plans.join(' ')).not.toContain('SCAN deployment_publish_jobs');
  });

  it('returns an empty sweep when all jobs are healthy or terminal', async () => {
    seed('healthy');
    seed('terminal', 'succeeded', old, old);
    expect(await failExpiredDeploymentPublishJobs(db(), settings, now)).toEqual([]);
    expect(row('healthy').status).toBe('building');
    expect(row('terminal').status).toBe('succeeded');
  });

  it('links exactly one owner release and rejects a duplicate without creating it', async () => {
    seed();
    expect(await release('first')).toBe(true);
    expect(row().release_id).toBe('first');
    expect(await release('duplicate')).toBe(false);
    expect(sqlite.prepare('SELECT id FROM deployment_releases').all()).toEqual([{ id: 'first' }]);
  });
  it.each([
    { attempt: 2 },
    { projectId: 'foreign' },
    { workspaceId: 'foreign' },
    { requestedBy: 'foreign' },
  ])('rejects stale/foreign release %j with owner control', async (override) => {
    seed();
    expect(await release('attack', override)).toBe(false);
    expect(row().release_id).toBeNull();
    expect(await release('owner')).toBe(true);
    expect(sqlite.prepare('SELECT id FROM deployment_releases').all()).toEqual([{ id: 'owner' }]);
  });
  it('swept jobs reject late release submissions', async () => {
    seed('job', 'building', old, old);
    await failExpiredDeploymentPublishJobs(db(), settings, now);
    expect(await release('late')).toBe(false);
    expect(await appendDeploymentPublishJobEvent(db(), { ...event, status: 'succeeded' })).toBe(
      false
    );
    expect(row().status).toBe('failed');
  });
  it('shadow marker blocks the final atomic release fence and event release linking', async () => {
    seed();
    sqlite.exec('UPDATE deployment_publish_jobs SET context_shadow=1');
    expect(await release('shadow-release')).toBe(false);
    expect(sqlite.prepare('SELECT count(*) n FROM deployment_releases').get()).toEqual({ n: 0 });
    expect(
      await appendDeploymentPublishJobEvent(db(), { ...event, releaseId: 'shadow-release' })
    ).toBe(false);
    sqlite.exec('UPDATE deployment_publish_jobs SET context_shadow=0');
    expect(await release('owner-release')).toBe(true);
  });
});
