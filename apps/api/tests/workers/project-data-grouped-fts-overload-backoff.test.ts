/**
 * Grouped FTS cleanup backs off for one recheck interval after an overload/reset error, and that
 * interval is measured from when the error was recorded.
 *
 * It used to read the storage measurement clock as the error's age. Cleanup passes stamped that
 * clock too, so the back-off fired or lapsed for reasons unrelated to the error; and once cleanup
 * stopped stamping it (the 2026-10-08 measurement-starvation fix), the hourly measurement alone
 * would have decided it. Each test below pairs the error's age with a measurement clock that
 * points the other way, so reading the wrong clock fails it.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runProjectDataGroupedFtsCleanup } from '../../src/durable-objects/project-data/grouped-fts-cleanup';
import {
  classifyStorageUsage,
  resolveStorageSafetyConfig,
} from '../../src/durable-objects/project-data/storage-safety';
import { recordStorageSafetyError } from '../../src/durable-objects/project-data/storage-safety-meta';
import type { Env as WorkerEnv } from '../../src/env';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';
import {
  runAlarmAt,
  storageAlarmCompletions,
  withProjectDataStorageEnv,
} from './support/project-data-storage';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'grouped-overload-owner';
const INSTALLATION = 'grouped-overload-installation';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RECHECK_MS = 5 * MINUTE;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const OVERLOAD_ERROR =
  'grouped_fts_cleanup: Error: Durable Object storage operation exceeded timeout which caused object to be reset.';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(projectId)
  ) as unknown as DurableObjectStub<ProjectDataTestDouble>;
}

/** A project whose only terminal session has grouped rows cleanup can delete. */
async function seedCleanableProject(prefix: string) {
  const projectId = `${prefix}-${crypto.randomUUID()}`;
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, { name: `Grouped overload ${projectId}` });
  const stub = getStub(projectId);
  await stub.ensureProjectId(projectId);
  const limitBytes = await runInDurableObject(stub, async (instance, state) => {
    const sessionId = await instance.createSession(null, 'Grouped overload candidate');
    await instance.persistMessage(
      sessionId,
      'assistant',
      `overload ${'o'.repeat(64 * 1024)}`,
      null
    );
    await instance.stopSession(sessionId);
    state.storage.sql.exec(
      'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
      T0 - 8 * DAY,
      sessionId
    );
    await state.storage.deleteAlarm();
    return Math.ceil(state.storage.sql.databaseSize / 0.92);
  });
  return { projectId, stub, limitBytes };
}

function cleanupConfig(limitBytes: number) {
  return {
    ...resolveStorageSafetyConfig(testEnv),
    limitBytes,
    groupedFtsCleanupEnabled: true,
    groupedFtsCleanupBatchSessions: 1,
    groupedFtsCleanupBatchRows: 50,
    groupedFtsCleanupBatchBytes: 1_000_000,
    groupedFtsCleanupRecheckMs: RECHECK_MS,
    groupedFtsCleanupWeakReclaimBytes: 1,
  };
}

/** One direct grouped cleanup pass at `now`, after arranging do_meta with `arrange`. */
async function runGroupedCleanupAt(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  projectId: string,
  limitBytes: number,
  now: number,
  arrange: (sql: SqlStorage) => void = () => undefined
) {
  return runInDurableObject(stub, async (_instance, state) => {
    arrange(state.storage.sql);
    const config = cleanupConfig(limitBytes);
    const result = await runProjectDataGroupedFtsCleanup(
      state.storage.sql,
      testEnv,
      projectId,
      config,
      {
        allowStart: true,
        now,
        classifyStatus: (databaseSizeBytes) => classifyStorageUsage(databaseSizeBytes, config),
      }
    );
    const errorAt = state.storage.sql
      .exec("SELECT value FROM do_meta WHERE key = 'storageSafetyLastErrorAt'")
      .toArray()[0] as { value?: string } | undefined;
    return {
      terminationReason: result?.terminationReason ?? null,
      groupedRowsDeleted: result?.groupedRowsDeleted ?? 0,
      errorAt: errorAt?.value === undefined ? null : Number(errorAt.value),
    };
  });
}

function setMeasurementClock(sql: SqlStorage, at: number): void {
  sql.exec(
    `INSERT INTO do_meta (key, value) VALUES ('storageSafetyLastMeasuredAt', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(at)
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('grouped FTS overload back-off', () => {
  it('backs off after a recent overload error even when the measurement clock is old', async () => {
    const { projectId, stub, limitBytes } = await seedCleanableProject('overload-fresh');

    const result = await runGroupedCleanupAt(stub, projectId, limitBytes, T0, (sql) => {
      recordStorageSafetyError(sql, OVERLOAD_ERROR, T0 - MINUTE);
      setMeasurementClock(sql, T0 - 2 * HOUR);
    });

    expect(result.terminationReason).toBe('circuit_breaker');
    expect(result.groupedRowsDeleted).toBe(0);
  });

  it('resumes once the overload error is older than the recheck, even right after a measurement', async () => {
    const { projectId, stub, limitBytes } = await seedCleanableProject('overload-stale');

    const result = await runGroupedCleanupAt(stub, projectId, limitBytes, T0, (sql) => {
      recordStorageSafetyError(sql, OVERLOAD_ERROR, T0 - RECHECK_MS - MINUTE);
      setMeasurementClock(sql, T0 - 30_000);
    });

    expect(result.terminationReason).not.toBe('circuit_breaker');
    expect(result.groupedRowsDeleted).toBeGreaterThan(0);
  });

  it('backs off exactly once for an overload error recorded before errors carried a timestamp', async () => {
    const { projectId, stub, limitBytes } = await seedCleanableProject('overload-legacy');

    const first = await runGroupedCleanupAt(stub, projectId, limitBytes, T0, (sql) => {
      sql.exec(
        `INSERT INTO do_meta (key, value) VALUES ('storageSafetyLastError', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        OVERLOAD_ERROR
      );
      setMeasurementClock(sql, T0 - 30_000);
    });
    expect(first.terminationReason).toBe('circuit_breaker');
    expect(first.groupedRowsDeleted).toBe(0);
    // The unknown age is adopted as "now", which bounds the back-off to one interval.
    expect(first.errorAt).toBe(T0);

    const second = await runGroupedCleanupAt(stub, projectId, limitBytes, T0 + RECHECK_MS);
    expect(second.terminationReason).not.toBe('circuit_breaker');
    expect(second.groupedRowsDeleted).toBeGreaterThan(0);
  });

  it('ages an overload error recorded by a failed alarm step from that failure', async () => {
    const { projectId, stub, limitBytes } = await seedCleanableProject('overload-alarm');
    vi.useFakeTimers({ toFake: ['Date'] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await withProjectDataStorageEnv(
      testEnv,
      {
        // A failed step leaves storage safety scheduled at the next measurement or full run, so a
        // gated tick two minutes later would skip it. This test steps the back-off itself, so
        // every tick runs every section (as the stepping tests in the main suite do).
        PROJECT_DATA_ALARM_SECTION_GATING_ENABLED: 'false',
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(limitBytes),
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS: '1',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS: String(RECHECK_MS),
      },
      async () => {
        // Tick 1: the grouped step fails with an overload/reset error, which the alarm records.
        vi.setSystemTime(T0);
        await runInDurableObject(stub, async (instance, state) => {
          await state.storage.deleteAlarm();
          const sql = state.storage.sql;
          const exec = sql.exec.bind(sql);
          let injected = false;
          const execSpy = vi.spyOn(sql, 'exec').mockImplementation(((
            query: string,
            ...bindings: SqlStorageValue[]
          ) => {
            if (!injected && /SELECT id FROM chat_sessions/.test(query)) {
              injected = true;
              throw new Error(
                'Durable Object storage operation exceeded timeout which caused object to be reset.'
              );
            }
            return exec(query, ...bindings);
          }) as typeof sql.exec);
          const setAlarm = vi.spyOn(state.storage, 'setAlarm').mockResolvedValue(undefined);
          try {
            await instance.alarm();
          } finally {
            execSpy.mockRestore();
            setAlarm.mockRestore();
            await state.storage.deleteAlarm();
          }
          expect(injected).toBe(true);
        });
        // Tick 2, inside the interval: back off.
        await runAlarmAt(stub, T0 + 2 * MINUTE);
        // Tick 3, when the back-off's own recheck is due and the error is older than the interval.
        await runAlarmAt(stub, T0 + 2 * MINUTE + RECHECK_MS);
      }
    );

    const completions = storageAlarmCompletions(logSpy, projectId);
    expect(completions.map((entry) => entry.failedSteps)).toEqual([
      ['grouped_fts_cleanup'],
      [],
      [],
    ]);
    expect(completions.slice(1).map((entry) => entry.groupedFtsCleanup?.terminationReason)).toEqual(
      ['circuit_breaker', 'candidates_exhausted']
    );
    const groupedRows = await runInDurableObject(
      stub,
      async (_instance, state) =>
        state.storage.sql.exec('SELECT count(*) AS n FROM chat_messages_grouped').one().n
    );
    expect(groupedRows).toBe(0);
  });
});
