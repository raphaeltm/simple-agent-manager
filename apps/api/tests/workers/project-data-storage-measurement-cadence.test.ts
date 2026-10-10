/**
 * The hourly ProjectData storage measurement must run no matter how busy cleanup is.
 *
 * Incident (2026-10-08): on the SAM root object, grouped FTS cleanup returns a result every
 * five minutes while it walks its session cursor (`row_budget`, two empty sessions examined).
 * Every such pass ran cleanup-health bookkeeping that re-stamped `storageSafetyLastMeasuredAt`,
 * the clock that schedules the hourly measurement, so the measurement never came due again:
 * no `project_data_storage_telemetry_history` rows, `measured:false` on every storage alarm,
 * and no operator alert for an object at 90% of its hard cap.
 *
 * These tests drive the real `alarm()` on a faked clock with cleanup doing work on every tick,
 * and assert what production observes: `measured` on the storage completion log, history rows
 * in D1, and operator alert rows.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';
import {
  runAlarmAt,
  storageAlarmCompletions,
  tickTimes,
  withProjectDataStorageEnv,
} from './support/project-data-storage';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'storage-cadence-owner';
const INSTALLATION = 'storage-cadence-installation';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A fixed wall-clock origin keeps every timestamp in these tests exact. */
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
/** Above every cleanup trigger and below grouped FTS's wall-unsafe ratio: `critical`. */
const CRITICAL_USAGE_RATIO = 0.92;

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(projectId)
  ) as unknown as DurableObjectStub<ProjectDataTestDouble>;
}

async function createProject(prefix: string) {
  const projectId = `${prefix}-${crypto.randomUUID()}`;
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, { name: `Storage cadence ${projectId}` });
  const stub = getStub(projectId);
  await stub.ensureProjectId(projectId);
  return { projectId, stub };
}

/**
 * Terminal sessions that grouped FTS cleanup selects but has nothing to delete in: materialized,
 * stopped, older than the age floor, and with no grouped rows. Its cursor walks them two at a time
 * and returns `row_budget` on every pass — the production root object's exact signature.
 */
async function seedEmptyMaterializedSessions(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  count: number
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    for (let index = 0; index < count; index++) {
      const sessionId = await instance.createSession(null, `Cursor session ${index}`);
      await instance.stopSession(sessionId);
    }
    const old = T0 - 8 * DAY;
    state.storage.sql.exec(
      'UPDATE chat_sessions SET updated_at = ?, materialized_at = ?',
      old,
      old
    );
    await state.storage.deleteAlarm();
  });
}

/** One stopped session holding `count` activity events the event-log cleanup may delete. */
async function seedTerminalActivityEvents(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  count: number
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const sessionId = await instance.createSession(null, 'Event-log cleanup source');
    await instance.stopSession(sessionId);
    const sql = state.storage.sql;
    sql.exec('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', T0 - DAY, sessionId);
    for (let index = 0; index < count; index++) {
      sql.exec(
        `INSERT INTO activity_events
           (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
         VALUES (?, 'storage.cadence', 'system', NULL, NULL, ?, NULL, ?, ?)`,
        `cadence-event-${index}`,
        sessionId,
        JSON.stringify({ index, payload: 'e'.repeat(1024) }),
        T0 - DAY + index
      );
    }
    await state.storage.deleteAlarm();
  });
}

async function criticalLimitBytes(stub: DurableObjectStub<ProjectDataTestDouble>): Promise<string> {
  const size = await runInDurableObject(
    stub,
    async (_instance, state) => state.storage.sql.databaseSize
  );
  return String(Math.ceil(size / CRITICAL_USAGE_RATIO));
}

async function readHistoryMeasuredAt(projectId: string): Promise<number[]> {
  const result = await testEnv.DATABASE.prepare(
    `SELECT measured_at FROM project_data_storage_telemetry_history
     WHERE project_id = ?
     ORDER BY measured_at ASC, created_at ASC`
  )
    .bind(projectId)
    .all<{ measured_at: number }>();
  return (result.results ?? []).map((row) => row.measured_at);
}

/** Storage alert rows for one project, ordered by time and then reason (ids are random). */
async function readStorageAlerts(projectId: string) {
  const result = await testEnv.OBSERVABILITY_DATABASE.prepare(
    `SELECT message, context, timestamp FROM platform_errors`
  ).all<{ message: string; context: string | null; timestamp: number }>();
  return (result.results ?? [])
    .map((row) => ({
      timestamp: row.timestamp,
      message: row.message,
      context: JSON.parse(row.context ?? '{}') as Record<string, unknown>,
    }))
    .filter(
      (row) => row.context.projectId === projectId && row.message.startsWith('ProjectData storage')
    )
    .sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        String(a.context.alertReason).localeCompare(String(b.context.alertReason))
    );
}

async function readMeasurementClock(stub: DurableObjectStub<ProjectDataTestDouble>) {
  return runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql
      .exec("SELECT value FROM do_meta WHERE key = 'storageSafetyLastMeasuredAt'")
      .toArray()[0] as { value?: string } | undefined;
    return row?.value === undefined ? null : Number(row.value);
  });
}

const GROUPED_CURSOR_ENV = {
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
  PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
  PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'true',
  PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS: '2',
  // Production ships 300000: a recheck far shorter than the one-hour measure interval.
  PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS: String(5 * MINUTE),
} satisfies Partial<Record<keyof WorkerEnv, string>>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProjectData storage measurement cadence', () => {
  it('measures hourly while grouped FTS cleanup advances its cursor on every tick', async () => {
    const { projectId, stub } = await createProject('cadence-grouped');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await seedEmptyMaterializedSessions(stub, 40);
    const limitBytes = await criticalLimitBytes(stub);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ticks = tickTimes(T0, 5 * MINUTE, 65 * MINUTE);

    const clockAfterTick: Array<number | null> = [];
    await withProjectDataStorageEnv(
      testEnv,
      {
        ...GROUPED_CURSOR_ENV,
        PROJECT_DATA_STORAGE_LIMIT_BYTES: limitBytes,
        // Shorter than the measure interval, so every measurement that runs must alert.
        PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS: String(30 * MINUTE),
      },
      async () => {
        for (const at of ticks) {
          await runAlarmAt(stub, at);
          clockAfterTick.push(await readMeasurementClock(stub));
        }
      }
    );

    const completions = storageAlarmCompletions(logSpy, projectId);
    // Liveness: storage safety ran on every tick and cleanup did work on every tick. Without
    // this the cadence assertion below could pass because cleanup never ran at all.
    expect(completions).toHaveLength(ticks.length);
    expect(completions.every((entry) => entry.failedSteps.length === 0)).toBe(true);
    expect(completions.map((entry) => entry.groupedFtsCleanup?.terminationReason ?? null)).toEqual(
      ticks.map(() => 'row_budget')
    );

    // The measurement runs at T0 and again one interval later — never in between.
    expect(completions.map((entry) => entry.measured)).toEqual(
      ticks.map((at) => at === T0 || at === T0 + HOUR)
    );
    // Cleanup passes never move the measurement clock.
    expect(clockAfterTick).toEqual(ticks.map((at) => (at < T0 + HOUR ? T0 : T0 + HOUR)));
    // Each measurement appended one history row; cleanup health appended none.
    expect(await readHistoryMeasuredAt(projectId)).toEqual([T0, T0 + HOUR]);
    // Each measurement evaluated the critical threshold alert.
    const alerts = await readStorageAlerts(projectId);
    expect(
      alerts.map((alert) => [alert.timestamp, alert.context.alertReason, alert.context.status])
    ).toEqual([
      [T0, 'threshold_exceeded', 'critical'],
      [T0 + HOUR, 'threshold_exceeded', 'critical'],
    ]);
  });

  it('measures hourly while event-log cleanup deletes rows on every tick', async () => {
    const { projectId, stub } = await createProject('cadence-event-log');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await seedTerminalActivityEvents(stub, 20);
    const limitBytes = await criticalLimitBytes(stub);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ticks = tickTimes(T0, 5 * MINUTE, 65 * MINUTE);

    await withProjectDataStorageEnv(
      testEnv,
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: limitBytes,
        PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS: String(30 * MINUTE),
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS: '1',
        PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS: String(5 * MINUTE),
      },
      async () => {
        for (const at of ticks) await runAlarmAt(stub, at);
      }
    );

    const completions = storageAlarmCompletions(logSpy, projectId);
    expect(completions).toHaveLength(ticks.length);
    expect(
      completions.map((entry) => entry.eventLogCleanup?.rowsDeleted.activityEvents ?? null)
    ).toEqual(ticks.map(() => 1));
    const remaining = await runInDurableObject(
      stub,
      async (_instance, state) =>
        state.storage.sql
          .exec("SELECT count(*) AS n FROM activity_events WHERE event_type = 'storage.cadence'")
          .one().n
    );
    expect(remaining).toBe(20 - ticks.length);

    expect(completions.map((entry) => entry.measured)).toEqual(
      ticks.map((at) => at === T0 || at === T0 + HOUR)
    );
    expect(await readMeasurementClock(stub)).toBe(T0 + HOUR);
    const alerts = await readStorageAlerts(projectId);
    expect(alerts.map((alert) => [alert.timestamp, alert.context.alertReason])).toEqual([
      [T0, 'threshold_exceeded'],
      [T0 + HOUR, 'threshold_exceeded'],
    ]);
  });

  it('keeps hourly measurements of a critical object to one alert per alert interval', async () => {
    const { projectId, stub } = await createProject('cadence-alert-interval');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await seedEmptyMaterializedSessions(stub, 40);
    const limitBytes = await criticalLimitBytes(stub);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ticks = tickTimes(T0, 30 * MINUTE, 7 * HOUR);

    // The alert interval is deliberately left unset: production relies on the default (6 h).
    await withProjectDataStorageEnv(
      testEnv,
      { ...GROUPED_CURSOR_ENV, PROJECT_DATA_STORAGE_LIMIT_BYTES: limitBytes },
      async () => {
        for (const at of ticks) await runAlarmAt(stub, at);
      }
    );

    const hourly = ticks.filter((at) => (at - T0) % HOUR === 0);
    const completions = storageAlarmCompletions(logSpy, projectId);
    expect(completions).toHaveLength(ticks.length);
    expect(completions.map((entry) => entry.measured)).toEqual(
      ticks.map((at) => hourly.includes(at))
    );
    expect(await readHistoryMeasuredAt(projectId)).toEqual(hourly);
    // Eight critical measurements, two alerts: the first, and the first after six hours.
    const alerts = await readStorageAlerts(projectId);
    expect(alerts.map((alert) => alert.timestamp)).toEqual([T0, T0 + 6 * HOUR]);
  });

  it('throttles threshold and cleanup-target-unreachable alerts independently', async () => {
    const { projectId, stub } = await createProject('cadence-alert-reasons');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    // A session exists but there is nothing for event-log cleanup to delete, so every pass
    // above the cleanup target ends `target_unreachable`.
    await runInDurableObject(stub, async (instance, state) => {
      await instance.createSession(null, 'Nothing to clean');
      await state.storage.deleteAlarm();
    });
    const limitBytes = await criticalLimitBytes(stub);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ticks = tickTimes(T0, HOUR, 3 * HOUR);

    await withProjectDataStorageEnv(
      testEnv,
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: limitBytes,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
      },
      async () => {
        for (const at of ticks) await runAlarmAt(stub, at);
      }
    );

    const completions = storageAlarmCompletions(logSpy, projectId);
    // Liveness: both alert conditions really held on every tick.
    expect(completions.map((entry) => [entry.measured, entry.cleanupHealth])).toEqual(
      ticks.map(() => [true, 'target_unreachable'])
    );
    // One alert per reason inside the six-hour window. With a single shared throttle slot each
    // reason resets the other, and every measurement hour raises both again.
    const alerts = await readStorageAlerts(projectId);
    expect(alerts.map((alert) => [alert.timestamp, alert.context.alertReason])).toEqual([
      [T0, 'cleanup_target_unreachable'],
      [T0, 'threshold_exceeded'],
    ]);
  });
});
