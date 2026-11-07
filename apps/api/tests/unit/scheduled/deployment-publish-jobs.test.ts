import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const record = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: record,
}));
vi.mock('../../../src/services/deployment-publish-job-settings', () => ({
  getDeploymentPublishJobSettings: async () => ({
    stallMs: 60_000,
    deadlineMs: 1_200_000,
    sweepLimit: 2,
  }),
}));
const { runDeploymentPublishJobSweep } =
  await import('../../../src/scheduled/deployment-publish-jobs');
let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs]);
  record.mockClear();
});
afterEach(() => sqlite.close());
it('sweeps real persisted jobs and hands lifecycle delivery to waitUntil', async () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  sqlite
    .prepare(
      "INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,status,created_at,updated_at,last_event_at) VALUES('job','project','environment','workspace','node','building',?,?,?)"
    )
    .run(old, old, old);
  const pending: Promise<unknown>[] = [];
  const result = await runDeploymentPublishJobSweep(
    { DATABASE: createSqliteD1(sqlite) } as Env,
    (promise) => pending.push(promise)
  );
  expect(result.failed).toBe(1);
  expect(pending).toHaveLength(1);
  await Promise.all(pending);
  expect(
    sqlite.prepare('SELECT status,error_code,retryable FROM deployment_publish_jobs').get()
  ).toEqual({ status: 'failed', error_code: 'stalled', retryable: 1 });
  expect(record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ publishJobId: 'job', status: 'failed', terminal: true })
  );
});
