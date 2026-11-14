import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import {
  instrumentRowUsage,
  ROW_USAGE_LABEL_LIMIT,
  RowUsage,
} from '@simple-agent-manager/project-data/internal/do/row-usage';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Usage = {
  windowStart: number;
  windowEnd: number;
  droppedLabelCount: number;
  labels: Array<{
    label: string;
    calls: number;
    rowsRead: number;
    rowsWritten: number;
    alarmWrites: number;
  }>;
};
function logs(spy: ReturnType<typeof vi.spyOn>): Usage[] {
  return spy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .filter((line) => line?.event === 'project_data.row_usage')
    .map((line) => ({ ...line, labels: Object.values(line.labels) }));
}
function stubFor(): DurableObjectStub<ProjectData> {
  return env.PROJECT_DATA.get(env.PROJECT_DATA.newUniqueId()) as DurableObjectStub<ProjectData>;
}
function meter(instance: ProjectData): RowUsage {
  return (instance as unknown as { rowUsage: RowUsage }).rowUsage;
}
import type { Env } from '../../src/env';
import { invalidateAdminSettings } from '../../src/services/admin-settings';
afterEach(() => vi.restoreAllMocks());

describe('ProjectData operation row usage in workerd', () => {
  it('attributes a real message batch RPC and adds no SQL writes', async () => {
    const spy = vi.spyOn(console, 'log');
    const stub = stubFor();
    const session = await stub.createSession('row-workspace', 'Existing topic');
    await stub.ensureProjectId('row-usage-messages');
    const cursors: Array<{ rowsWritten: number }> = [];
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO acp_sessions (id,chat_session_id,node_id,status,created_at,updated_at)
        VALUES ('message-acp',?,'node','running',1000,1000)`,
        session
      );
      state.storage.sql.exec(`INSERT INTO session_state (session_id,activity,activity_at,work_at)
        VALUES ('message-acp','prompting',1000,1000)`);
      meter(instance).flush(Date.now() + 15 * 60_000);
      // Observe the storage's own counters underneath the production meter.
      const holder = instance as unknown as { sql: SqlStorage };
      const original = holder.sql;
      holder.sql = new Proxy(original, {
        get(target, key) {
          if (key === 'exec')
            return (query: string, ...bindings: unknown[]) => {
              const cursor = target.exec(query, ...bindings);
              cursors.push(cursor);
              return cursor;
            };
          return Reflect.get(target, key, target);
        },
      });
      state.waitUntil(Promise.resolve());
    });
    spy.mockClear();
    await stub.persistMessageBatch(
      session,
      Array.from({ length: 4 }, (_, n) => ({
        messageId: `m-${n}`,
        role: 'assistant',
        content: `message ${n}`,
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      }))
    );
    expect(logs(spy)).toHaveLength(0);
    await runInDurableObject(stub, (instance, state) => {
      meter(instance).flush(Date.now() + 30 * 60_000);
      void state.storage.deleteAlarm();
    });
    const batch = logs(spy)[0]?.labels.find((entry) => entry.label === 'persistMessageBatch');
    expect(batch).toMatchObject({ calls: 1, rowsWritten: 19, alarmWrites: 0 });
    expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(batch!.rowsWritten);
    expect(batch!.rowsRead).toBeGreaterThan(0);
  });

  it('attributes event admission, heartbeats and actual alarm sections through stubs', async () => {
    const spy = vi.spyOn(console, 'log');
    const stub = stubFor();
    const projectId = 'row-usage-events';
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql
        .exec(`INSERT INTO chat_sessions (id,status,message_count,started_at,created_at,updated_at)
        VALUES ('chat','active',0,1000,1000,1000)`);
      state.storage.sql
        .exec(`INSERT INTO acp_sessions (id,chat_session_id,node_id,status,created_at,updated_at)
        VALUES ('acp','chat','node','running',1000,1000)`);
      meter(instance).flush(Date.now() + 15 * 60_000);
    });
    spy.mockClear();
    await stub.admitProjectEvent({
      projectId,
      source: 'github',
      eventType: 'push',
      subject: { type: 'repository', id: 'repo' },
      deliveryKey: crypto.randomUUID(),
      payloadFingerprint: 'sha256:test',
      severity: 'info',
      metadata: {},
      display: { title: 'test event' },
      occurredAt: Date.now(),
      receivedAt: Date.now(),
    });
    await stub.updateNodeHeartbeats('node');
    await runInDurableObject(stub, async (instance, state) => {
      meter(instance).flush(Date.now() + 30 * 60_000);
      await state.storage.deleteAlarm();
    });
    const labels = logs(spy)[0]!.labels;
    // Cold scheduler state: 9 event rows + 4 scheduler rows + 2 alarm-schedule rows + setAlarm.
    expect(labels.find((entry) => entry.label === 'admitProjectEvent')).toMatchObject({
      calls: 1,
      rowsWritten: 16,
      alarmWrites: 1,
    });
    // One heartbeat row + one existing alarm-schedule update + setAlarm.
    expect(labels.find((entry) => entry.label === 'updateNodeHeartbeats')).toMatchObject({
      calls: 1,
      rowsWritten: 3,
      alarmWrites: 1,
    });
    spy.mockClear();
    const alarmStub = stubFor();
    await alarmStub.ensureProjectId('row-usage-alarm');
    await runInDurableObject(alarmStub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000)
    );
    expect(await runDurableObjectAlarm(alarmStub)).toBe(true);
    await runInDurableObject(alarmStub, async (instance, state) => {
      meter(instance).flush(Date.now() + 45 * 60_000);
      await state.storage.deleteAlarm();
    });
    expect(
      logs(spy)[0]!.labels.some(
        (entry) => entry.label === 'alarm:storage_safety' && entry.rowsRead > 0
      )
    ).toBe(true);
    expect(
      spy.mock.calls.some(([line]) => String(line).includes('project_data.alarm.completed'))
    ).toBe(true);
  });

  it('flushes only once at the interval and resets counters', async () => {
    const spy = vi.spyOn(console, 'log');
    const stub = stubFor();
    await stub.ensureProjectId('cadence');
    await runInDurableObject(stub, (instance) => {
      const usage = meter(instance);
      const start = (usage as unknown as { windowStart: number }).windowStart;
      usage.flush(start + usage.intervalMs - 1);
      expect(logs(spy)).toHaveLength(0);
      usage.flush(start + usage.intervalMs);
      expect(logs(spy)).toHaveLength(1);
      usage.flush(start + usage.intervalMs);
      expect(logs(spy)).toHaveLength(1);
      instance.getSummary();
      usage.flush(start + 2 * usage.intervalMs);
      expect(logs(spy)).toHaveLength(2);
      expect(
        logs(spy)[1]!.labels.find((entry) => entry.label === 'ensureProjectId')
      ).toBeUndefined();
      expect(logs(spy)[1]!.labels.find((entry) => entry.label === 'getSummary')).toMatchObject({
        calls: 1,
      });
    });
  });

  it('automatically flushes expired windows through real RPCs, then resets the cadence', async () => {
    const spy = vi.spyOn(console, 'log');
    const stub = stubFor();
    await stub.ensureProjectId('automatic-cadence');
    let start = 0;
    let interval = 0;
    await runInDurableObject(stub, (instance) => {
      start = (meter(instance) as unknown as { windowStart: number }).windowStart;
      interval = meter(instance).intervalMs;
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start + interval - 1);
    expect((await stub.getSummary()).activeSessionCount).toBe(0);
    expect(logs(spy)).toHaveLength(0);
    clock.mockReturnValue(start + interval);
    expect((await stub.getSummary()).activeSessionCount).toBe(0);
    expect(logs(spy)).toHaveLength(1);
    expect(logs(spy)[0]!.labels.find((entry) => entry.label === 'getSummary')).toMatchObject({
      calls: 1,
    });
    await stub.getSummary();
    expect(logs(spy)).toHaveLength(1);
    clock.mockReturnValue(start + 2 * interval);
    await stub.getSummary();
    expect(logs(spy)).toHaveLength(2);
    expect(logs(spy)[1]!.labels.find((entry) => entry.label === 'getSummary')).toMatchObject({
      calls: 2,
    });
    expect(logs(spy)[1]!.labels.find((entry) => entry.label === 'ensureProjectId')).toBeUndefined();
    clock.mockRestore();
  });

  it('ranks capped labels by writes, merges the rest into other, and discloses the drop', () => {
    const spy = vi.spyOn(console, 'log');
    const usage = new RowUsage(() => 'cap');
    const sql = usage.sql({
      exec: () => ({ rowsRead: 0, rowsWritten: 1 }),
    } as unknown as SqlStorage);
    for (let n = 0; n <= ROW_USAGE_LABEL_LIMIT; n++) usage.run(`a${n}`, () => sql.exec('write'));
    usage.run('z-heavy', () => {
      for (let n = 0; n < 50; n++) sql.exec('write');
    });
    usage.flush(Date.now() + usage.intervalMs);
    const report = logs(spy)[0]!;
    expect(report.labels[0]).toMatchObject({ label: 'z-heavy', rowsWritten: 50 });
    expect(report.labels).toHaveLength(ROW_USAGE_LABEL_LIMIT + 1);
    expect(report.droppedLabelCount).toBe(2);
    expect(report.labels.find((entry) => entry.label === 'other')).toMatchObject({
      rowsWritten: 2,
      calls: 2,
    });
    expect(report.labels.reduce((sum, entry) => sum + entry.rowsWritten, 0)).toBe(
      ROW_USAGE_LABEL_LIMIT + 51
    );
  });

  it('preserves nested and concurrent async attribution and folds cursors only once', async () => {
    const spy = vi.spyOn(console, 'log');
    const usage = new RowUsage(() => 'async');
    const sql = usage.sql({
      exec: () => ({ rowsRead: 3, rowsWritten: 2 }),
    } as unknown as SqlStorage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = usage.run('first', async () => {
      sql.exec('one');
      await gate;
      usage.run('helper', () => sql.exec('two'));
    });
    await usage.run('second', async () => {
      sql.exec('other');
    });
    release();
    await first;
    usage.fold();
    usage.fold();
    usage.flush(Date.now() + usage.intervalMs);
    expect(logs(spy)[0]!.labels).toEqual([
      { label: 'first', calls: 1, rowsRead: 6, rowsWritten: 4, alarmWrites: 0 },
      { label: 'second', calls: 1, rowsRead: 3, rowsWritten: 2, alarmWrites: 0 },
    ]);
  });

  it('attributes real KV and alarm writes including transaction callbacks without extra persistence', async () => {
    const spy = vi.spyOn(console, 'log');
    const stub = stubFor();
    await stub.ensureProjectId('storage');
    await runInDurableObject(stub, async (instance, state) => {
      const usage = meter(instance);
      usage.flush(Date.now() + usage.intervalMs);
      spy.mockClear();
      const storage = usage.storage(state.storage);
      await usage.run('kv', async () => {
        await storage.put({ a: 'one', b: 'two' });
        expect(await storage.delete(['a', 'absent'])).toBe(1);
        await storage.transaction(async (txn) => {
          await txn.put('c', 'three');
        });
        await storage.setAlarm(Date.now() + 60_000);
        await storage.deleteAlarm();
      });
      expect([...(await state.storage.list())].map(([key]) => key)).toEqual(['b', 'c']);
      usage.flush(Date.now() + 2 * usage.intervalMs);
      expect(logs(spy)[0]!.labels).toEqual([
        { label: 'kv', calls: 1, rowsRead: 0, rowsWritten: 6, alarmWrites: 2 },
      ]);
    });
  });

  it('loads the admin interval for a new object and uses it for cadence', async () => {
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
      .bind('operations.projectDataRowUsageIntervalMs', '60000')
      .run();
    invalidateAdminSettings(env as unknown as Env);
    const spy = vi.spyOn(console, 'log');
    const stub = stubFor();
    await stub.ensureProjectId('configured-cadence');
    await runInDurableObject(stub, (instance) => {
      const usage = meter(instance);
      expect(usage.intervalMs).toBe(60_000);
      const start = (usage as unknown as { windowStart: number }).windowStart;
      usage.flush(start + 59_999);
      expect(logs(spy)).toHaveLength(0);
      usage.flush(start + 60_000);
      expect(logs(spy)).toHaveLength(1);
    });
    await env.DATABASE.prepare('DELETE FROM platform_settings WHERE key=?')
      .bind('operations.projectDataRowUsageIntervalMs')
      .run();
    invalidateAdminSettings(env as unknown as Env);
  });

  it('keeps this, accessors, synchronous results, and thrown error identity', async () => {
    const usage = new RowUsage(() => 'semantics');
    const error = new Error('same error');
    class Example {
      value = 42;
      get accessor() {
        return this.value;
      }
      sync() {
        return this.value;
      }
      throwing() {
        throw error;
      }
      async asynchronous() {
        return this.value;
      }
      async rejecting() {
        throw error;
      }
    }
    instrumentRowUsage(Example.prototype, () => usage);
    const instance = new Example();
    expect(instance.sync()).toBe(42);
    expect(instance.accessor).toBe(42);
    expect(instance.constructor).toBe(Example);
    try {
      instance.throwing();
      expect.unreachable();
    } catch (caught) {
      expect(caught).toBe(error);
    }
    expect(instance.asynchronous()).toBeInstanceOf(Promise);
    expect(await instance.asynchronous()).toBe(42);
    await expect(instance.rejecting()).rejects.toBe(error);
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('logger down');
    });
    usage.intervalMs = 0;
    expect(instance.sync()).toBe(42);
    try {
      instance.throwing();
      expect.unreachable();
    } catch (caught) {
      expect(caught).toBe(error);
    }
  });
});
