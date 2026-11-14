import type { DeploymentPublishJobPorts } from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const { runDeploymentPublishJobSweep } =
  await import('../../../src/scheduled/deployment-publish-jobs');
const settings: Record<string, number> = {
  'deployments.publishJobStallMs': 60_000,
  'deployments.publishJobDeadlineMs': 1_200_000,
  'deployments.publishJobSweepLimit': 2,
  'deployments.publishJobCancelTimeoutMs': 1000,
};
const cancel = vi.fn(async () => undefined);
const record = vi.fn(async () => undefined);
const ports: DeploymentPublishJobPorts = {
  settings: { resolveSetting: async (name) => settings[name] },
  vm: { cancelPublishJob: cancel },
  lifecycle: { recordPublishJobLifecycleEventBestEffort: record },
};
let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs]);
  record.mockClear();
  cancel.mockClear();
});
afterEach(() => sqlite.close());
it('sweeps real persisted jobs and hands lifecycle delivery to waitUntil', async () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  sqlite
    .prepare(
      "INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,status,created_at,updated_at,last_event_at,last_heartbeat_at) VALUES('job','project','environment','workspace','node','building',?,?,?,?)"
    )
    .run(old, old, old, old);
  const pending: Promise<unknown>[] = [];
  const result = await runDeploymentPublishJobSweep(
    { DATABASE: createSqliteD1(sqlite) },
    ports,
    (promise) => pending.push(promise)
  );
  expect(result.failed).toBe(1);
  // The real cancel path reaches the VM port with the job and the configured timeout.
  expect(cancel).toHaveBeenCalledWith('workspace', null, 'node', 'job', 1000);
  expect(pending).toHaveLength(1);
  await Promise.all(pending);
  expect(
    sqlite.prepare('SELECT status,error_code,retryable FROM deployment_publish_jobs').get()
  ).toEqual({ status: 'failed', error_code: 'stalled', retryable: 1 });
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ publishJobId: 'job', status: 'failed', terminal: true })
  );
});
it('expires shadow probes without public events or publish failure counts', async () => {
  const old = new Date(Date.now() - 120000).toISOString();
  sqlite
    .prepare(
      "INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,status,created_at,updated_at,last_heartbeat_at,context_shadow) VALUES('shadow','project','environment','workspace','node','collecting',?,?,?,1)"
    )
    .run(old, old, old);
  const pending: Promise<unknown>[] = [];
  expect(
    await runDeploymentPublishJobSweep({ DATABASE: createSqliteD1(sqlite) }, ports, (p) =>
      pending.push(p)
    )
  ).toEqual({ failed: 0 });
  await Promise.all(pending);
  expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
    status: 'failed',
  });
  expect(record).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith('workspace', null, 'node', 'shadow', 1000);
});
