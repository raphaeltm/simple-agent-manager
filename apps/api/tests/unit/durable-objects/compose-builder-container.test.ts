import {
  appendDeploymentPublishJobEvent,
  failExpiredDeploymentPublishJobs,
} from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
const calls = vi.hoisted(() => ({
  schedule: vi.fn(),
  deleteSchedules: vi.fn(),
  waitUntil: vi.fn(),
  running: false,
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
    async destroy() {
      await calls.destroy();
      calls.running = false;
    }
    deleteSchedules(name: string) {
      calls.deleteSchedules(name);
    }
    async startAndWaitForPorts(...args: unknown[]) {
      await calls.start(...args);
      calls.running = true;
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
  calls.running = false;
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
    container: {
      getTcpPort: () => ({ fetch: calls.fetch }),
      get running() {
        return calls.running;
      },
    },
    waitUntil: calls.waitUntil,
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
  await builder.runBuilder({ jobId: 'job', attempt: 1 });
}
describe('per-job builder lifecycle adapter', () => {
  it('launches after a controlled late collector callback without undoing admission', async () => {
    // The row is already atomically admitted by the fixture. Deliver the old
    // source event before the durable kickoff runs, matching the staging race.
    expect(
      await appendDeploymentPublishJobEvent(drizzle(env.DATABASE, { schema }), {
        publishJobId: 'job',
        projectId: 'project',
        environmentId: 'env',
        workspaceId: 'ws',
        nodeId: 'node',
        eventType: 'publish.context.collected',
        message: 'context collected',
        status: 'context_ready',
        currentStep: 'context_ready',
      })
    ).toBe(false);
    expect(
      sqlite.prepare('SELECT status,current_step FROM deployment_publish_jobs').get()
    ).toMatchObject({ status: 'starting' });
    await launch();
    expect(calls.start).toHaveBeenCalledTimes(1);
    expect(calls.fetch).toHaveBeenCalledTimes(2);
  });
  it('recovers a reserved context_ready row once without repeating an accepted launch', async () => {
    sqlite.exec(
      "UPDATE deployment_publish_jobs SET status='context_ready',current_step='context_ready'"
    );
    await launch();
    await launch();
    expect(calls.start).toHaveBeenCalledTimes(1);
    expect(
      sqlite.prepare('SELECT status,executor_instance_id FROM deployment_publish_jobs').get()
    ).toEqual({ status: 'starting', executor_instance_id: 'job' });
  });

  it('repairs a regression after acceptance without touching or relaunching the guest', async () => {
    await launch();
    const deadline = sqlite
      .prepare('SELECT executor_deadline_at FROM deployment_publish_jobs')
      .get();
    sqlite.exec(
      "UPDATE deployment_publish_jobs SET status='context_ready',current_step='context_ready'"
    );
    sqlite.exec("UPDATE deployment_publish_jobs SET last_heartbeat_at='2000-01-01T00:00:00.000Z'");
    await builder.startJob('job', 1); // cron recovery enters through this method
    expect(
      await failExpiredDeploymentPublishJobs(drizzle(env.DATABASE, { schema }), {
        stallMs: 60000,
        deadlineMs: 1800000,
        sweepLimit: 6,
      })
    ).toEqual([]);
    expect(
      sqlite.prepare('SELECT status,executor_instance_id FROM deployment_publish_jobs').get()
    ).toEqual({ status: 'starting', executor_instance_id: 'job' });
    expect(
      sqlite.prepare('SELECT executor_deadline_at FROM deployment_publish_jobs').get()
    ).toEqual(deadline);
    expect(calls.start).toHaveBeenCalledTimes(1);
    expect(calls.fetch).toHaveBeenCalledTimes(2);
  });
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
    calls.running = false;
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
    notBefore: null,
  });
  expect(stored.get('buildJob')).toMatchObject({ jobId: 'job', attempt: 1 });
  await builder.runBuilder({ jobId: 'job', attempt: 1 });
  expect(calls.start).toHaveBeenCalledTimes(1);
});

it('ignores duplicate and stale capacity alarms without defeating backoff', async () => {
  await builder.startJob('job', 1);
  calls.start.mockRejectedValueOnce(new Error('Maximum number of running containers'));
  await Promise.all([
    builder.runBuilder({ jobId: 'job', attempt: 1 }),
    builder.runBuilder({ jobId: 'job', attempt: 1 }),
  ]);
  await builder.runBuilder({ jobId: 'job', attempt: 1 });
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
  await builder.runBuilder({ jobId: 'job', attempt: 1 });
  await builder.enforceDeadline();
  await builder.onStop();
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  expect(calls.destroy).toHaveBeenCalled();
});

it.each(['succeeded', 'missing'])(
  'old deadline never touches an inactive %s guest',
  async (status) => {
    await launch();
    calls.running = false;
    if (status === 'missing') sqlite.exec('DELETE FROM deployment_publish_jobs');
    else
      sqlite.exec(
        "UPDATE deployment_publish_jobs SET status='succeeded',executor_instance_id=NULL"
      );
    calls.destroy.mockClear();
    calls.start.mockClear();
    calls.fetch.mockClear();
    await builder.enforceDeadline();
    expect(calls.destroy).not.toHaveBeenCalled();
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(calls.deleteSchedules).toHaveBeenCalledWith('enforceDeadline');
    expect(calls.deleteSchedules).toHaveBeenCalledWith('launchBuilder');
  }
);
it('a never-settling acceptance diagnostic cannot block kickoff or deadline destruction', async () => {
  const actual = env.DATABASE.batch.bind(env.DATABASE);
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  env.DATABASE.batch = (async (statements) => {
    if (first) {
      first = false;
      entered();
      return new Promise(() => {});
    }
    return actual(statements);
  }) as D1Database['batch'];
  const launched = launch();
  await pending;
  expect(
    await Promise.race([
      launched.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ])
  ).toBe(true);
  await builder.enforceDeadline();
  expect(calls.destroy).toHaveBeenCalledTimes(1);
});

it('legacy persisted kickoff callback releases the sequential SDK alarm immediately', async () => {
  const prepare = env.DATABASE.prepare.bind(env.DATABASE);
  env.DATABASE.prepare = ((sql) => {
    const statement = prepare(sql);
    return {
      ...statement,
      bind: (...args: unknown[]) => ({
        ...statement.bind(...args),
        raw: () => new Promise(() => {}),
      }),
    };
  }) as D1Database['prepare'];
  expect(builder.launchBuilder({ jobId: 'job', attempt: 1 })).toBeUndefined();
  expect(calls.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  expect(calls.start).not.toHaveBeenCalled();
});
it('a previous SDK stop notification during retry startup cannot revoke its new deadline or job', async () => {
  calls.start.mockImplementationOnce(async () => {
    await builder.onStop();
  });
  await launch();
  expect(
    sqlite.prepare('SELECT status,executor_instance_id FROM deployment_publish_jobs').get()
  ).toEqual({ status: 'starting', executor_instance_id: 'job' });
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  expect(calls.deleteSchedules).not.toHaveBeenCalled();
  expect(calls.schedule).toHaveBeenCalledWith(expect.any(Date), 'enforceDeadline');
});

it('destroys SDK startup that resumes after deadline abort without depending on D1', async () => {
  let resume!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  calls.start.mockImplementationOnce(async () => {
    entered();
    await blocked;
  });
  const launched = launch();
  await starting;
  env.DATABASE = {
    prepare: () => {
      throw new Error('D1 unavailable');
    },
  } as unknown as D1Database;
  await expect(builder.enforceDeadline()).resolves.toBeUndefined();
  expect(calls.schedule).toHaveBeenCalledWith(expect.any(Date), 'enforceDeadline');
  resume();
  await launched.catch(() => undefined);
  expect(calls.destroy).toHaveBeenCalledTimes(1);
  expect(calls.running).toBe(false);
  expect(calls.fetch).not.toHaveBeenCalled();
});

it('inactive terminal cleanup releases its reservation without waking compute', async () => {
  await launch();
  calls.running = false;
  sqlite.exec("UPDATE deployment_publish_jobs SET status='succeeded'");
  calls.destroy.mockClear();
  await builder.enforceDeadline();
  expect(calls.destroy).not.toHaveBeenCalled();
  expect(sqlite.prepare('SELECT executor_instance_id FROM deployment_publish_jobs').get()).toEqual({
    executor_instance_id: null,
  });
});

it('stale capacity stop neither aborts nor destroys a readmitted reservation', async () => {
  await launch();
  const signal = calls.start.mock.calls[0]![0].cancellationOptions.abort as AbortSignal;
  sqlite.exec("UPDATE deployment_publish_jobs SET executor_not_before='2099-01-01T00:00:00.000Z'");
  await builder.stopJob({ jobId: 'job', attempt: 1, notBefore: null, retryAt: Date.now() + 30000 });
  expect(signal.aborted).toBe(false);
  expect(calls.destroy).not.toHaveBeenCalled();
  expect(
    sqlite
      .prepare(
        'SELECT status,executor_instance_id,executor_not_before FROM deployment_publish_jobs'
      )
      .get()
  ).toEqual({
    status: 'starting',
    executor_instance_id: 'job',
    executor_not_before: '2099-01-01T00:00:00.000Z',
  });
});

it('capacity cleanup and readmission rotate the epoch without reusing acceptance state', async () => {
  calls.start.mockImplementationOnce(async () => {
    calls.running = true;
    throw new Error('Maximum number of running containers');
  });
  await launch();
  expect(calls.destroy).toHaveBeenCalledTimes(1);
  const queued = sqlite
    .prepare('SELECT executor_not_before,executor_deadline_at FROM deployment_publish_jobs')
    .get() as { executor_not_before: string; executor_deadline_at: string };
  expect(queued.executor_not_before).toEqual(expect.any(String));
  sqlite.exec("UPDATE deployment_publish_jobs SET status='starting',executor_instance_id='job'");
  await expect(builder.startJob('job', 1, null)).rejects.toThrow('reservation changed');
  await builder.startJob('job', 1, queued.executor_not_before);
  await builder.runBuilder({ jobId: 'job', attempt: 1, notBefore: queued.executor_not_before });
  const signal = calls.start.mock.calls[1]![0].cancellationOptions.abort as AbortSignal;
  await builder.stopJob({ jobId: 'job', attempt: 1, notBefore: null, retryAt: Date.now() + 60000 });
  await builder.runBuilder({ jobId: 'job', attempt: 1 });
  expect(signal.aborted).toBe(false);
  expect(calls.destroy).toHaveBeenCalledTimes(1);
  expect(calls.start).toHaveBeenCalledTimes(2);
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  expect(sqlite.prepare('SELECT executor_deadline_at FROM deployment_publish_jobs').get()).toEqual({
    executor_deadline_at: queued.executor_deadline_at,
  });
});
