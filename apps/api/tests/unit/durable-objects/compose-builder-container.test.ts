import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
const calls = vi.hoisted(() => ({
  schedule: vi.fn(),
  lifecycle: vi.fn(async () => {}),
  destroy: vi.fn(),
  start: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: calls.lifecycle,
}));
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars = {};
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    schedule(...args: unknown[]) {
      return calls.schedule(...args);
    }
    destroy() {
      return calls.destroy();
    }
    startAndWaitForPorts(...args: unknown[]) {
      return calls.start(...args);
    }
    containerFetch(...args: unknown[]) {
      return calls.fetch(...args);
    }
    async getState() {
      return { status: 'healthy' };
    }
  },
}));
vi.mock('../../../src/services/admin-settings', () => ({ resolveAdminSetting: async () => 30000 }));
vi.mock('../../../src/services/publish-job-token', () => ({
  signPublishJobToken: vi.fn(async () => 'single-job-token'),
}));
const { ComposeBuilderContainer } =
  await import('../../../src/durable-objects/compose-builder-container');
let sqlite: Database.Database;
let env: Env;
let stored: Map<string, unknown>;
let builder: InstanceType<typeof ComposeBuilderContainer>;
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs, schema.deploymentPublishJobEvents]);
  const deadline = new Date(Date.now() + 60_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO deployment_publish_jobs(id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,status,executor,context_shadow,attempt,agent_profile_id,executor_instance_id,executor_deadline_at) VALUES('job','project','env','ws','node','user','staging','starting','cloudflare',0,1,'profile','job',?)`
    )
    .run(deadline);
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    CF_ACCOUNT_ID: 'account',
    VM_AGENT_REQUIRED_VERSION: 'version',
  } as Env;
  stored = new Map();
  const ctx = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
    },
  };
  builder = new ComposeBuilderContainer(ctx as unknown as DurableObjectState, env);
  calls.schedule.mockResolvedValue({});
  calls.destroy.mockResolvedValue(undefined);
  calls.start.mockResolvedValue(undefined);
  calls.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/health')
      ? Response.json({ version: 'version' })
      : new Response(null, { status: 202 })
  );
});
afterEach(() => sqlite.close());
async function launch() {
  await builder.startJob('job', 1);
  await builder.launchBuilder({ jobId: 'job', attempt: 1 });
}
describe('per-job builder lifecycle adapter', () => {
  it('arms the persisted deadline before startup and sends no credentials through env', async () => {
    await launch();
    expect(calls.schedule.mock.invocationCallOrder[0]).toBeLessThan(
      calls.start.mock.invocationCallOrder[0]!
    );
    const envelope = JSON.parse(calls.fetch.mock.calls[1]?.[1].body);
    expect(envelope).toMatchObject({ jobId: 'job', attempt: 1, token: 'single-job-token' });
    expect((builder as unknown as { envVars: unknown }).envVars).toEqual({
      SAM_BUILDER_BOOTSTRAP_TIMEOUT_MS: '30000',
      SAM_BUILDER_CONTROL_TIMEOUT_MS: '30000',
    });
    await launch();
    expect(calls.start).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale attempt or version before sending the token', async () => {
    await expect(builder.startJob('job', 2)).rejects.toThrow();
    expect(calls.start).not.toHaveBeenCalled();
    calls.fetch.mockResolvedValueOnce(Response.json({ version: 'stale' }));
    await launch();
    expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
      status: 'failed',
    });
    expect(calls.fetch).toHaveBeenCalledTimes(1);
  });
  it('rechecks durable cancellation after startup awaits', async () => {
    calls.start.mockImplementationOnce(async () => {
      sqlite.exec("UPDATE deployment_publish_jobs SET status='canceled'");
    });
    await launch();
    expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
      status: 'canceled',
    });
    expect(calls.fetch).toHaveBeenCalledTimes(1);
  });
  it('hard deadline stops before publishing its verdict and frees capacity', async () => {
    await launch();
    await builder.enforceDeadline();
    expect(calls.destroy).toHaveBeenCalled();
    expect(calls.lifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        terminal: true,
        source: 'cloudflare_builder.deadline',
      })
    );
    expect(
      sqlite
        .prepare('SELECT status,error_code,executor_instance_id FROM deployment_publish_jobs')
        .get()
    ).toEqual({ status: 'failed', error_code: 'deadline_exceeded', executor_instance_id: null });
  });
  it('stops orphan containers when source-node deletion cascades away their job', async () => {
    await launch();
    sqlite.exec("DELETE FROM deployment_publish_jobs WHERE id='job'");
    await builder.enforceDeadline();
    expect(calls.destroy).toHaveBeenCalledTimes(1);
  });
  it('unexpected process exit produces a durable failure; terminal success survives cleanup', async () => {
    await launch();
    await builder.onStop();
    expect(sqlite.prepare('SELECT status FROM deployment_publish_jobs').get()).toEqual({
      status: 'failed',
    });
    sqlite.exec(
      "UPDATE deployment_publish_jobs SET status='succeeded', executor_instance_id='job'"
    );
    await builder.onStop();
    expect(
      sqlite.prepare('SELECT status,executor_instance_id FROM deployment_publish_jobs').get()
    ).toEqual({ status: 'succeeded', executor_instance_id: null });
  });
});

it('persists kickoff before returning without starting a container in the HTTP waiter', async () => {
  await builder.startJob('job', 1);
  expect(calls.start).not.toHaveBeenCalled();
  expect(calls.schedule).toHaveBeenCalledWith(expect.any(Date), 'launchBuilder', {
    jobId: 'job',
    attempt: 1,
  });
  expect(stored.get('buildJob')).toMatchObject({ jobId: 'job', attempt: 1 });
  await builder.launchBuilder({ jobId: 'job', attempt: 1 });
  expect(calls.start).toHaveBeenCalledTimes(1);
});

it('ignores duplicate and stale capacity alarms without defeating backoff', async () => {
  await builder.startJob('job', 1);
  calls.start.mockRejectedValueOnce(new Error('Maximum number of running containers'));
  await Promise.all([
    builder.launchBuilder({ jobId: 'job', attempt: 1 }),
    builder.launchBuilder({ jobId: 'job', attempt: 1 }),
  ]);
  await builder.launchBuilder({ jobId: 'job', attempt: 1 });
  expect(calls.start).toHaveBeenCalledTimes(1);
  expect(
    sqlite
      .prepare(
        'SELECT status,executor_instance_id,executor_not_before FROM deployment_publish_jobs'
      )
      .get()
  ).toEqual({
    status: 'context_ready',
    executor_instance_id: null,
    executor_not_before: expect.any(String),
  });
});
it('destroys on deadline even when D1 is unavailable', async () => {
  await launch();
  env.DATABASE = {
    prepare: () => {
      throw new Error('D1 unavailable');
    },
  } as unknown as D1Database;
  await expect(builder.enforceDeadline()).rejects.toThrow();
  expect(calls.destroy).toHaveBeenCalledTimes(1);
});

it('re-arms deadline destruction after a transient container failure', async () => {
  await launch();
  calls.destroy.mockRejectedValueOnce(new Error('temporary stop unavailable'));
  const before = calls.schedule.mock.calls.length;
  await expect(builder.enforceDeadline()).rejects.toThrow('temporary stop unavailable');
  expect(calls.schedule.mock.calls.slice(before)).toEqual([[expect.any(Date), 'enforceDeadline']]);
  await builder.enforceDeadline();
  expect(calls.destroy).toHaveBeenCalledTimes(2);
  expect(
    sqlite.prepare('SELECT status,executor_instance_id FROM deployment_publish_jobs').get()
  ).toEqual({ status: 'failed', executor_instance_id: null });
});

it('never contacts the bootstrap port after acceptance, even if RUN binds it', async () => {
  await launch();
  expect(calls.fetch).toHaveBeenCalledTimes(2); // version probe, then the single launch
  calls.fetch.mockImplementation(() => {
    throw new Error('untrusted RUN now owns the former bootstrap port');
  });
  await builder.startJob('job', 1);
  await builder.launchBuilder({ jobId: 'job', attempt: 1 });
  await builder.enforceDeadline();
  await builder.onStop();
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  expect(calls.destroy).toHaveBeenCalled();
});
