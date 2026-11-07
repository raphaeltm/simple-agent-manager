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
function seed(id = 'job', status = 'building', createdAt = recent, lastEventAt = recent) {
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs
    (id, project_id, workspace_id, environment_id, node_id, requested_by, status, attempt, created_at, updated_at, last_event_at)
    VALUES (?, 'project', 'workspace', 'environment', 'node', 'user', ?, 1, ?, ?, ?)`
    )
    .run(id, status, createdAt, createdAt, lastEventAt);
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
  it('allows owner cancellation and fences late events and releases', async () => {
    seed();
    expect(await cancelDeploymentPublishJob(db(), 'project', 'workspace', 'job')).toMatchObject({
      status: 'canceled',
    });
    expect(await appendDeploymentPublishJobEvent(db(), event)).toBe(false);
    expect(await release('late')).toBe(false);
    expect(row().status).toBe('canceled');
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
            sqlite.prepare('UPDATE deployment_publish_jobs SET last_event_at = ?').run(recent);
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
});
