import { admitCloudflareBuild } from '@simple-agent-manager/app-deployment';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

// Exercise the installed constructor, SQL scheduler and alarm implementation.
// Only the native workerd container/storage boundaries are simulated.
vi.mock(
  '@cloudflare/containers',
  async () => import('../../../node_modules/@cloudflare/containers/dist/lib/container.js')
);
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: async () => 30000,
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: async () => undefined,
}));
const { Container } = await import('@cloudflare/containers');
const { ComposeBuilderContainer } =
  await import('../../../src/durable-objects/compose-builder-container');

let sql: Database.Database;
let database: D1Database;
let env: Env;
let values: Map<string, unknown>;
let nativeAlarm: number | null;
let running: boolean;
let boot: Promise<unknown>[];
let builder: InstanceType<typeof ComposeBuilderContainer>;
let ctx: DurableObjectState;
const native = {
  start: vi.fn(),
  destroy: vi.fn(),
  monitor: vi.fn(),
  fetch: vi.fn(),
  setAlarm: vi.fn(),
  deleteAlarm: vi.fn(),
};

async function settleConstructor() {
  while (boot.length) await Promise.all(boot.splice(0));
}
function schedules() {
  return sql.prepare('SELECT callback FROM container_schedules ORDER BY callback').all();
}
async function armOriginalDeadline() {
  await builder.schedule(new Date(Date.now() + 60000), 'enforceDeadline');
  expect(nativeAlarm).not.toBeNull();
  expect(schedules()).toEqual([{ callback: 'enforceDeadline' }]);
}
function assertNoGuestOperations() {
  expect(native.start).not.toHaveBeenCalled();
  expect(native.destroy).not.toHaveBeenCalled();
  expect(native.monitor).not.toHaveBeenCalled();
  expect(native.fetch).not.toHaveBeenCalled();
}
beforeEach(async () => {
  vi.clearAllMocks();
  sql = new Database(':memory:');
  createSchemaTables(sql, [schema.deploymentPublishJobs, schema.deploymentPublishJobEvents]);
  const now = new Date().toISOString();
  sql
    .prepare(
      `INSERT INTO deployment_publish_jobs
    (id,project_id,environment_id,workspace_id,node_id,requested_by,environment_name,
     executor,context_shadow,status,current_step,attempt,agent_profile_id,
     executor_instance_id,executor_deadline_at,context_r2_key,context_sha256,created_at,updated_at)
    VALUES ('job','project','env','ws','node','user','staging','cloudflare',0,
      'succeeded','complete',1,'profile',NULL,?,'context','digest',?,?)`
    )
    .run(new Date(Date.now() + 60000).toISOString(), now, now);
  database = createSqliteD1(sql);
  env = { DATABASE: database, BASE_DOMAIN: 'example.test' } as Env;
  values = new Map([
    [
      'buildJob',
      {
        jobId: 'job',
        attempt: 1,
        deadline: Date.now() + 60000,
        stopRetryMs: 30000,
        accepted: true,
        reservationEpoch: null,
      },
    ],
    ['__CF_CONTAINER_STATE', { status: 'stopped', lastChange: Date.now() }],
  ]);
  nativeAlarm = null;
  running = false;
  boot = [];
  native.setAlarm.mockImplementation(async (at: number | Date) => {
    nativeAlarm = Number(at);
  });
  native.deleteAlarm.mockImplementation(async () => {
    nativeAlarm = null;
  });
  native.destroy.mockImplementation(async () => {
    running = false;
  });
  native.monitor.mockImplementation(() => new Promise(() => {}));
  ctx = {
    id: { toString: () => 'builder-job' },
    exports: { ContainerProxy: () => ({ fetch: vi.fn() }) },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      const promise = fn();
      boot.push(promise);
      return promise;
    },
    waitUntil: () => undefined,
    container: {
      get running() {
        return running;
      },
      start: native.start,
      destroy: native.destroy,
      monitor: native.monitor,
      getTcpPort: () => ({ fetch: native.fetch }),
    },
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      kv: {
        get: (key: string) => values.get(key),
        put: (key: string, value: unknown) => {
          values.set(key, value);
        },
      },
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          const statement = sql.prepare(query);
          return statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
        },
      },
      setAlarm: native.setAlarm,
      getAlarm: async () => nativeAlarm,
      deleteAlarm: native.deleteAlarm,
      sync: async () => undefined,
    },
  } as unknown as DurableObjectState;
  builder = new ComposeBuilderContainer(ctx, env);
  await settleConstructor();
  await armOriginalDeadline();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  sql.close();
});

describe('installed SDK terminal builder alarm lifecycle', () => {
  it('natural terminal stop removes the deadline and native alarm before a D1 outage', async () => {
    env.DATABASE = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    await expect(builder.onStop()).rejects.toThrow('D1 unavailable');
    expect(schedules()).toEqual([]);
    expect(nativeAlarm).toBeNull();
    assertNoGuestOperations();
  });

  it('explicit terminal stop clears the native alarm as well as SDK schedules', async () => {
    await builder.stopJob();
    expect(schedules()).toEqual([]);
    expect(nativeAlarm).toBeNull();
    assertNoGuestOperations();
  });

  it('reconstruction of a stopped terminal builder neither rearms nor renews activity', async () => {
    await builder.onStop();
    vi.clearAllMocks();
    const renew = vi.spyOn(Container.prototype, 'renewActivityTimeout');
    builder = new ComposeBuilderContainer(ctx, env);
    await settleConstructor();
    expect(native.setAlarm).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(nativeAlarm).toBeNull();
    assertNoGuestOperations();
  });

  it('a delivered terminal alarm returns before entering the installed SDK alarm', async () => {
    await builder.onStop();
    vi.clearAllMocks();
    const baseAlarm = vi.spyOn(Container.prototype, 'alarm');
    await builder.alarm();
    expect(baseAlarm).not.toHaveBeenCalled();
    expect(native.setAlarm).not.toHaveBeenCalled();
    expect(nativeAlarm).toBeNull();
    assertNoGuestOperations();
  });

  it('natural stop inside the SDK alarm cannot rearm its stale pre-stop schedule snapshot', async () => {
    // The SDK snapshots future schedules before synchronizing the previous
    // process exit. onStop then removes them, but the SDK still holds that
    // snapshot and would otherwise rearm the original native deadline.
    values.set('__CF_CONTAINER_STATE', { status: 'healthy', lastChange: Date.now() });
    builder = new ComposeBuilderContainer(ctx, env);
    await settleConstructor();
    vi.clearAllMocks();
    const baseAlarm = vi.spyOn(Container.prototype, 'alarm');
    await builder.alarm();
    expect(baseAlarm).toHaveBeenCalledTimes(1);
    expect(schedules()).toEqual([]);
    expect(nativeAlarm).toBeNull();
    assertNoGuestOperations();
  });

  it('SDK scheduling that finishes storage.sync after quiescence cannot restore a native alarm', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const syncing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(ctx.storage, 'sync').mockImplementationOnce(async () => {
      entered();
      await blocked;
    });
    const scheduling = builder.scheduleNextAlarm();
    await syncing;
    await builder.onStop();
    expect(await ctx.storage.getAlarm()).toBeNull();
    resume();
    await scheduling;
    expect(await ctx.storage.getAlarm()).toBeNull();
    expect(schedules()).toEqual([]);
    assertNoGuestOperations();
  });

  it('a previous stop notification cannot erase or fail a newly admitted reservation epoch', async () => {
    sql.exec("UPDATE deployment_publish_jobs SET status='starting',executor_instance_id='job'");
    values.set('buildJob', {
      jobId: 'job',
      attempt: 1,
      deadline: Date.now() + 60000,
      stopRetryMs: 30000,
      accepted: false,
      reservationEpoch: null,
    });
    let resume!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementationOnce((query) => {
      const statement = prepare(query);
      return {
        ...statement,
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return {
            ...bound,
            raw: async () => {
              const captured = await bound.raw();
              entered();
              await blocked;
              return captured;
            },
          };
        },
      } as D1PreparedStatement;
    });
    const oldStop = builder.onStop();
    await reading;
    await builder.stopJob({
      jobId: 'job',
      attempt: 1,
      notBefore: null,
      retryAt: Date.now() - 1000,
    });
    const admitted = await admitCloudflareBuild(drizzle(database, { schema }), 'job', {
      platform: 6,
      project: 2,
      classMax: 6,
      deadlineMs: 1800000,
    });
    expect(admitted).toBeTruthy();
    await builder.startJob('job', 1, admitted!.executorNotBefore);
    resume();
    await oldStop;
    expect(values.get('buildJob')).toMatchObject({
      reservationEpoch: admitted!.executorNotBefore,
      quiescent: false,
    });
    expect(
      sql.prepare('SELECT status,executor_instance_id FROM deployment_publish_jobs').get()
    ).toEqual({ status: 'starting', executor_instance_id: 'job' });
    expect(schedules()).toEqual([{ callback: 'enforceDeadline' }, { callback: 'launchBuilder' }]);
    expect(await ctx.storage.getAlarm()).not.toBeNull();
    assertNoGuestOperations();
  });

  it('an active deadline still destroys before an unavailable D1 verdict', async () => {
    running = true;
    sql.exec("UPDATE deployment_publish_jobs SET status='building',executor_instance_id='job'");
    env.DATABASE = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    await expect(builder.enforceDeadline()).rejects.toThrow('D1 unavailable');
    expect(native.destroy).toHaveBeenCalledTimes(1);
    expect(running).toBe(false);
    expect(nativeAlarm).toBeNull();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('capacity cleanup can be followed by a fresh admitted epoch and real SDK schedules', async () => {
    sql.exec("UPDATE deployment_publish_jobs SET status='starting',executor_instance_id='job'");
    values.set('buildJob', {
      jobId: 'job',
      attempt: 1,
      deadline: Date.now() + 60000,
      stopRetryMs: 30000,
      accepted: false,
      reservationEpoch: null,
    });
    await builder.stopJob({
      jobId: 'job',
      attempt: 1,
      notBefore: null,
      retryAt: Date.now() - 1000,
    });
    const admitted = await admitCloudflareBuild(drizzle(database, { schema }), 'job', {
      platform: 6,
      project: 2,
      classMax: 6,
      deadlineMs: 1800000,
    });
    expect(admitted).toBeTruthy();
    vi.clearAllMocks();
    await builder.startJob('job', 1, admitted!.executorNotBefore);
    expect(schedules()).toEqual([{ callback: 'enforceDeadline' }, { callback: 'launchBuilder' }]);
    expect(native.setAlarm).toHaveBeenCalled();
    expect(nativeAlarm).not.toBeNull();
    assertNoGuestOperations();
  });
});
