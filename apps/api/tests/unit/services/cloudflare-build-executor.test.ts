import {
  type CloudflareBuildPorts,
  dispatchCloudflareBuild,
  drainCloudflareBuilds,
  releaseCloudflareBuildReservation,
} from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
let sqlite: Database.Database;
let database: D1Database;
let ports: CloudflareBuildPorts;
function seed(id = 'job', project = 'project') {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,status,executor,context_shadow,attempt,context_r2_key,context_sha256,created_at,updated_at) VALUES(?,?,'env','ws','node','user','staging','context_ready','cloudflare',0,1,'key','sha',?,?)`
    )
    .run(id, project, now, now);
}
function row() {
  return sqlite
    .prepare(
      "SELECT status,executor_instance_id,executor_not_before FROM deployment_publish_jobs WHERE id='job'"
    )
    .get();
}
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs, schema.deploymentPublishJobEvents]);
  database = createSqliteD1(sqlite);
  ports = {
    classMax: 6,
    settings: {
      resolveSetting: async (name) =>
        ({
          'deployments.builderMaxConcurrent': 6,
          'deployments.builderProjectMaxConcurrent': 2,
          'deployments.publishJobDeadlineMs': 1800000,
          'deployments.builderDeadlineMs': 1200000,
          'deployments.builderCapacityBackoffMs': 30000,
          'deployments.builderDrainLimit': 6,
          'deployments.builderReservationGraceMs': 300000,
        })[name as string],
    },
    builder: {
      start: vi.fn(async () => 'started' as const),
      stop: vi.fn(async (job, capacity) => {
        if (capacity)
          await releaseCloudflareBuildReservation(
            drizzle(database, { schema }),
            job.id,
            capacity.attempt,
            capacity.retryAt,
            capacity.notBefore
          );
      }),
    },
    lifecycle: { recordPublishJobLifecycleEventBestEffort: vi.fn(async () => {}) },
  };
});
afterEach(() => sqlite.close());
describe('Cloudflare queue orchestration on actual D1 SQL', () => {
  it('starts admitted jobs once and respects final capacity', async () => {
    seed();
    expect(await dispatchCloudflareBuild(database, ports, 'job')).toBe(true);
    expect(await dispatchCloudflareBuild(database, ports, 'job')).toBe(false);
    expect(ports.builder.start).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: 'starting', executor_instance_id: 'job' });
  });
  it('confirms stop then backs off platform capacity without source fallback', async () => {
    seed();
    ports.builder.start = vi.fn(async () => 'capacity');
    expect(await dispatchCloudflareBuild(database, ports, 'job')).toBe(false);
    expect(ports.builder.stop).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({
      status: 'context_ready',
      executor_instance_id: null,
      executor_not_before: expect.any(String),
    });
    await drainCloudflareBuilds(database, ports);
    expect(ports.builder.start).toHaveBeenCalledTimes(1);
  });
  it('preserves cancellation that races admission/startup', async () => {
    seed();
    ports.builder.start = vi.fn(async () => {
      sqlite.exec("UPDATE deployment_publish_jobs SET status='canceled'");
      return 'capacity';
    });
    await dispatchCloudflareBuild(database, ports, 'job');
    expect(row()).toMatchObject({ status: 'canceled', executor_instance_id: null });
  });
  it('fails noncapacity errors and retains reservations until stop succeeds', async () => {
    seed();
    ports.builder.start = vi.fn(async () => {
      throw new Error('image unavailable');
    });
    ports.builder.stop = vi.fn(async () => {
      throw new Error('stop unavailable');
    });
    await dispatchCloudflareBuild(database, ports, 'job');
    expect(row()).toMatchObject({ status: 'failed', executor_instance_id: 'job' });
    ports.builder.stop = vi.fn(async () => {});
    await drainCloudflareBuilds(database, ports);
    expect(row()).toMatchObject({ status: 'failed', executor_instance_id: null });
  });
});

it('cron recovers a reservation whose HTTP caller disappeared before DO kickoff', async () => {
  seed();
  sqlite.exec("UPDATE deployment_publish_jobs SET status='starting',executor_instance_id='job'");
  await drainCloudflareBuilds(database, ports);
  expect(ports.builder.start).toHaveBeenCalledTimes(1);
  expect(row()).toMatchObject({ status: 'starting', executor_instance_id: 'job' });
});

it.each([
  "status='building'",
  "status='context_ready',executor_instance_id=NULL",
  "status='starting',executor_not_before='2099-01-01T00:00:00.000Z'",
])('stale startup failure cannot fail or stop changed reservation: %s', async (change) => {
  seed();
  ports.builder.start = vi.fn(async () => {
    sqlite.exec('UPDATE deployment_publish_jobs SET ' + change);
    throw new Error('delayed startup failure');
  });
  await dispatchCloudflareBuild(database, ports, 'job');
  expect(ports.builder.stop).not.toHaveBeenCalled();
  expect((row() as { status: string }).status).not.toBe('failed');
  expect(ports.lifecycle.recordPublishJobLifecycleEventBestEffort).not.toHaveBeenCalled();
});
it('project-capped backlog cannot hide eligible work behind the drain limit', async () => {
  for (const id of ['a-active', 'b-active']) {
    seed(id);
    sqlite
      .prepare(
        "UPDATE deployment_publish_jobs SET status='building',executor_instance_id=id WHERE id=?"
      )
      .run(id);
  }
  for (let i = 0; i < 8; i++) seed('c-queued-' + i);
  seed('z-other', 'another-project');
  await drainCloudflareBuilds(database, ports);
  expect(ports.builder.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'z-other' }));
});

it('late capacity result cannot release a same-attempt replacement reservation', async () => {
  seed();
  ports.builder.start = vi.fn(async () => {
    sqlite.exec(
      "UPDATE deployment_publish_jobs SET executor_not_before='2099-01-01T00:00:00.000Z'"
    );
    return 'capacity';
  });
  await dispatchCloudflareBuild(database, ports, 'job');
  expect(row()).toEqual({
    status: 'starting',
    executor_instance_id: 'job',
    executor_not_before: '2099-01-01T00:00:00.000Z',
  });
});
it('expired or incomplete queue entries cannot consume the eligible drain batch', async () => {
  for (let i = 0; i < 8; i++) {
    seed('a-bad-' + i, 'bad-' + i);
    sqlite
      .prepare('UPDATE deployment_publish_jobs SET context_r2_key=NULL WHERE id=?')
      .run('a-bad-' + i);
  }
  for (let i = 0; i < 8; i++) {
    seed('b-old-' + i, 'old-' + i);
    sqlite
      .prepare(
        "UPDATE deployment_publish_jobs SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?"
      )
      .run('b-old-' + i);
  }
  seed('z-good', 'good');
  await drainCloudflareBuilds(database, ports);
  expect(ports.builder.start).toHaveBeenCalledTimes(1);
  expect(ports.builder.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'z-good' }));
});
