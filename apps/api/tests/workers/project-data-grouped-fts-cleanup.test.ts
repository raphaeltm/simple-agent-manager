/**
 * Worker-runtime coverage for the storage alarm's grouped/FTS cleanup on the shared page engine:
 * near-wall mode behind its flag, atomic pages with no stale-FTS fallback, the growth guard, the
 * archive exclusion, and per-session exclusions. Real SQLite-backed Durable Objects and real FTS5
 * (rule 28). "Near the wall" is simulated by sizing `limitBytes` around the object's real size;
 * the Workers pool does not enforce the 10 GiB cap itself.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runProjectDataGroupedFtsCleanup } from '../../src/durable-objects/project-data/grouped-fts-cleanup';
import {
  resolveStorageSafetyConfig,
  runProjectDataStorageSafetyAlarm,
  type StorageSafetyConfig,
} from '../../src/durable-objects/project-data/storage-safety';
import type { Env as WorkerEnv } from '../../src/env';
import { runScopedProjectDataArchiveCanary } from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import { readLocation, withArchiveEnv } from './helpers/archive-fixtures';
import {
  assertFtsIntegrity,
  createProject,
  type SeededSession,
  seedSessions,
  snapshotSession,
  STORAGE_FULL,
  type Stub,
} from './helpers/grouped-fts-fixtures';

const testEnv = env as unknown as WorkerEnv;

type Mode = { nearWall: boolean; nearWallEnabled?: boolean };

interface RunOptions {
  mode: Mode;
  config?: Partial<StorageSafetyConfig>;
  /** Extra Worker vars, e.g. the exclusion settings. */
  env?: Record<string, string>;
  /** The run's clock (defaults to the real one). */
  now?: number;
  /** Wraps `sql` for this run, e.g. to inject failures. */
  wrapSql?: (sql: SqlStorage, inTransaction: () => boolean) => SqlStorage;
}

/**
 * One alarm cleanup run in the object, with `limitBytes` set so the object sits either above
 * the wall-unsafe ratio (0.98) or between the trigger (0.9) and it.
 */
function runCleanup(stub: Stub, projectId: string, options: RunOptions) {
  return runInDurableObject(stub, async (_instance, state) => {
    let inTransaction = false;
    const real = state.storage.sql;
    const sql = options.wrapSql ? options.wrapSql(real, () => inTransaction) : real;
    const ratio = options.mode.nearWall ? 0.99 : 0.93;
    const config: StorageSafetyConfig = {
      ...resolveStorageSafetyConfig(testEnv),
      limitBytes: Math.ceil(real.databaseSize / ratio),
      groupedFtsCleanupEnabled: true,
      groupedFtsCleanupTriggerRatio: 0.9,
      groupedFtsCleanupTargetRatio: 0.2,
      groupedFtsCleanupWallUnsafeRatio: 0.98,
      groupedFtsCleanupBatchSessions: 5,
      groupedFtsCleanupBatchRows: 10_000,
      groupedFtsCleanupBatchBytes: 32 * 1024 * 1024,
      groupedFtsCleanupMinSessionAgeMs: 7 * 24 * 60 * 60 * 1000,
      groupedFtsCleanupWeakReclaimBytes: 0,
      ...options.config,
    };
    const runEnv = {
      ...testEnv,
      PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED: String(
        options.mode.nearWallEnabled ?? true
      ),
      ...options.env,
    } as unknown as WorkerEnv;
    return runProjectDataGroupedFtsCleanup(sql, runEnv, projectId, config, {
      allowStart: true,
      ...(options.now === undefined ? {} : { now: options.now }),
      transactionSync: (callback) => {
        inTransaction = true;
        try {
          return state.storage.transactionSync(callback);
        } finally {
          inTransaction = false;
        }
      },
      classifyStatus: () => 'critical',
    });
  });
}

/** `sql` whose `exec` runs `onExec` first (which may throw), and whose getters see the real object. */
function intercept(
  sql: SqlStorage,
  hooks: { onExec?: (query: string, bindings: unknown[]) => void; databaseSize?: () => number }
): SqlStorage {
  return new Proxy(sql, {
    get(target, prop) {
      if (prop === 'exec') {
        return (query: string, ...bindings: unknown[]) => {
          hooks.onExec?.(query, bindings);
          return target.exec(query, ...bindings);
        };
      }
      if (prop === 'databaseSize' && hooks.databaseSize) return hooks.databaseSize();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function seedTwoOldSessions(stub: Stub): Promise<[SeededSession, SeededSession]> {
  const [large, small] = await seedSessions(stub, [
    { label: 'large', turns: 8 },
    { label: 'small', turns: 2 },
  ]);
  return [large!, small!];
}

describe('ProjectData grouped FTS alarm cleanup', () => {
  it('stays out near the wall unless near-wall mode is on', async () => {
    const { projectId, stub } = await createProject('flag-off', 'grouped-cleanup');
    const [large] = await seedTwoOldSessions(stub);

    const result = await runCleanup(stub, projectId, {
      mode: { nearWall: true, nearWallEnabled: false },
    });

    expect(result).toMatchObject({ terminationReason: 'wall_unsafe', groupedRowsDeleted: 0 });
    expect((await snapshotSession(stub, large)).groupedRows).toBe(large.before.groupedRows);
  });

  it('near the wall, prunes the largest session in atomic pages and keeps the index exact', async () => {
    const { projectId, stub } = await createProject('near-wall', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);

    const result = await runCleanup(stub, projectId, { mode: { nearWall: true } });

    expect(result).toMatchObject({ nearWall: true, sessionsCleaned: 2, sessionsExcluded: 0 });
    expect(result?.groupedRowsDeleted).toBe(large.before.groupedRows + small.before.groupedRows);
    const after = await snapshotSession(stub, large);
    expect(after).toMatchObject({
      groupedRows: 0,
      ftsMatches: 0,
      searchIndexState: 'grouped_fts_pruned',
    });
    // Message text is untouched, and the external-content index matches its table.
    expect(after.messageDigest).toBe(large.before.messageDigest);
    await assertFtsIntegrity(stub);
  });

  it('never prunes a session an archive is copying', async () => {
    const { projectId, stub } = await createProject('archive-intent', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_data_archive_source_intents (
           session_id, project_id, migration_id, source_owner_name, target_owner_name,
           target_generation, source_intent_token, state, terminal_version_sha256,
           last_message_at, message_count, prepared_at, created_at, updated_at
         ) VALUES (?, ?, 'migration-copying', ?, ?, 1, 'token', 'intent_prepared', 'sha', NULL, 0, 1, 1, 1)`,
        large.sessionId,
        projectId,
        projectId,
        `${projectId}:archive:g1:s0`
      );
    });

    for (const nearWall of [false, true]) {
      await runCleanup(stub, projectId, { mode: { nearWall } });
    }

    expect((await snapshotSession(stub, large)).groupedRows).toBe(large.before.groupedRows);
    expect((await snapshotSession(stub, small)).groupedRows).toBe(0);
  });

  it('rolls back a page the cap refuses and leaves no stale index entry', async () => {
    const { projectId, stub } = await createProject('storage-full', 'grouped-cleanup');
    const [large] = await seedTwoOldSessions(stub);

    const result = await runCleanup(stub, projectId, {
      mode: { nearWall: true },
      wrapSql: (sql) =>
        intercept(sql, {
          onExec: (query) => {
            if (query.includes(`VALUES('delete'`)) throw new Error(STORAGE_FULL);
          },
        }),
    });

    // Both sessions' pages were refused and rolled back; the run tried each once and moved on.
    expect(result).toMatchObject({
      terminationReason: 'storage_full',
      groupedRowsDeleted: 0,
      pagesRefusedAtCap: 2,
      sessionsExcludedForFailure: 2,
    });
    const after = await snapshotSession(stub, large);
    // Rows, index entries and the session mark are all exactly as before.
    expect(after).toEqual(large.before);
    await assertFtsIntegrity(stub);
  });

  it('moves past a session the cap refuses, even when nothing can be recorded', async () => {
    const { projectId, stub } = await createProject('cap-refusal-next', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);
    let pruning: unknown = null;

    const run = () =>
      runCleanup(stub, projectId, {
        mode: { nearWall: true },
        config: { groupedFtsCleanupBatchSessions: 2 },
        wrapSql: (sql) =>
          intercept(sql, {
            onExec: (query, bindings) => {
              if (query.startsWith('DELETE FROM chat_messages_grouped')) pruning = bindings[1];
              // Only the large session's index deletes do not fit at the cap...
              if (query.includes(`VALUES('delete'`) && pruning === large.sessionId) {
                throw new Error(STORAGE_FULL);
              }
              // ...and no bookkeeping fits either: no exclusion, traversal or recheck is saved.
              if (/^\s*(INSERT INTO|DELETE FROM) do_meta/.test(query)) {
                throw new Error(STORAGE_FULL);
              }
            },
          }),
      });

    const first = await run();

    // The refused page rolled back and the run went on to the next session in the same run.
    expect(first).toMatchObject({
      pagesRefusedAtCap: 1,
      sessionsExcludedForFailure: 1,
      groupedRowsDeleted: small.before.groupedRows,
    });
    expect(await snapshotSession(stub, large)).toEqual(large.before);
    expect((await snapshotSession(stub, small)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);

    // With nothing recorded, the next run tries the large session again and changes nothing.
    const second = await run();
    expect(second).toMatchObject({ terminationReason: 'storage_full', groupedRowsDeleted: 0 });
    expect(await snapshotSession(stub, large)).toEqual(large.before);
  });

  it('rolls back a page that would grow the database and leaves that session for later', async () => {
    const { projectId, stub } = await createProject('page-grew', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);
    let deletes = 0;

    const first = await runCleanup(stub, projectId, {
      mode: { nearWall: true },
      // The large session's page reports growth inside its transaction; the small one does not.
      wrapSql: (sql, inTransaction) =>
        intercept(sql, {
          onExec: (query, bindings) => {
            if (query.includes(`VALUES('delete'`)) deletes++;
            void bindings;
          },
          databaseSize: () =>
            sql.databaseSize +
            (inTransaction() && deletes > 0 && deletes <= large.before.groupedRows
              ? 64 * 1024 * 1024
              : 0),
        }),
    });

    expect(first).toMatchObject({ pagesRolledBackForGrowth: 1, sessionsExcluded: 1 });
    expect(await snapshotSession(stub, large)).toEqual(large.before);
    expect((await snapshotSession(stub, small)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);

    // The next run, with no growth at all and past its recheck time, still leaves it alone: the
    // run happens (liveness), finds nothing else eligible, and prunes nothing.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `DELETE FROM do_meta WHERE key = 'storageSafetyGroupedFtsCleanupRecheckAt'`
      );
    });
    const second = await runCleanup(stub, projectId, { mode: { nearWall: true } });
    expect(second).toMatchObject({
      terminationReason: 'candidates_exhausted',
      groupedRowsDeleted: 0,
    });
    expect((await snapshotSession(stub, large)).groupedRows).toBe(large.before.groupedRows);
  });

  it('with unique-token content, never leaves the database larger than it found it', async () => {
    const { projectId, stub } = await createProject('high-entropy', 'grouped-cleanup');
    // Long runs of unique tokens are the content whose FTS deletes can outgrow the rows they free.
    const sessions = await runInDurableObject(stub, async (instance, state) => {
      const ids: string[] = [];
      for (let s = 0; s < 3; s++) {
        const sessionId = await instance.createSession(null, `entropy ${s}`);
        for (let i = 0; i < 6; i++) {
          const tokens = Array.from({ length: 400 }, () => crypto.randomUUID().replace(/-/g, ''));
          await instance.persistMessage(sessionId, 'user', `q ${i}`, null, null);
          await instance.persistMessage(sessionId, 'assistant', tokens.join(' '), null, null);
        }
        await instance.stopSession(sessionId);
        state.storage.sql.exec(
          'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
          Date.now() - 30 * 24 * 60 * 60 * 1000,
          sessionId
        );
        ids.push(sessionId);
      }
      return ids;
    });
    expect(sessions).toHaveLength(3);

    const result = await runCleanup(stub, projectId, { mode: { nearWall: true } });

    expect(result).not.toBeNull();
    // Liveness: the run reached every session, so the size check below covers real pages.
    expect(result!.sessionsExamined).toBe(3);
    expect(result!.afterBytes).toBeLessThanOrEqual(result!.beforeBytes);
    // Every page either committed or rolled back whole, so the index matches its table. The
    // growth guard's own discriminating test is the injected-growth case above.
    await assertFtsIntegrity(stub);
  });

  it('leaves a session whose page fails alone for a while and cleans the rest', async () => {
    const { projectId, stub } = await createProject('page-failed', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);

    const result = await runCleanup(stub, projectId, {
      mode: { nearWall: false },
      wrapSql: (sql) =>
        intercept(sql, {
          onExec: (query, bindings) => {
            if (
              query.startsWith('DELETE FROM chat_messages_grouped') &&
              bindings[1] === large.sessionId
            ) {
              throw new Error('disk I/O error');
            }
          },
        }),
    });

    expect(result).toMatchObject({ sessionsExcluded: 1, sessionsCleaned: 1 });
    expect(await snapshotSession(stub, large)).toEqual(large.before);
    expect((await snapshotSession(stub, small)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);
  });

  /** Fails every page of the given sessions, as a disk I/O error would. */
  function failingPages(sessionIds: ReadonlySet<string>) {
    return (sql: SqlStorage) =>
      intercept(sql, {
        onExec: (query, bindings) => {
          if (
            query.startsWith('DELETE FROM chat_messages_grouped') &&
            sessionIds.has(bindings[1] as string)
          ) {
            throw new Error('disk I/O error');
          }
        },
      });
  }

  for (const nearWall of [false, true]) {
    it(`reaches a healthy session behind more failing sessions than it can exclude (near the wall: ${nearWall})`, async () => {
      const { projectId, stub } = await createProject(`saturation-${nearWall}`, 'grouped-cleanup');
      const seeded = await seedSessions(stub, [
        { label: 'faila', turns: 8 },
        { label: 'failb', turns: 7 },
        { label: 'failc', turns: 6 },
        { label: 'healthy', turns: 2 },
      ]);
      const failing = seeded.slice(0, 3).map((session) => session!);
      const healthy = seeded[3]!;
      const start = Date.now();

      // One session per run and room to remember one exclusion: the evicted failures used to
      // come straight back, largest first, ahead of the healthy session on every run.
      let cleanedOnRun: number | null = null;
      for (let run = 0; run < 5 && cleanedOnRun === null; run++) {
        await runCleanup(stub, projectId, {
          mode: { nearWall },
          now: start + run * 60_000,
          env: { PROJECT_DATA_GROUPED_FTS_CLEANUP_MAX_EXCLUSIONS: '1' },
          config: { groupedFtsCleanupBatchSessions: 1, groupedFtsCleanupRecheckMs: 1_000 },
          wrapSql: failingPages(new Set(failing.map((session) => session.sessionId))),
        });
        if ((await snapshotSession(stub, healthy)).groupedRows === 0) cleanedOnRun = run;
      }

      // Each run moves past the session it finished, failed or not: the fourth reaches it.
      expect(cleanedOnRun).toBe(3);
      for (const session of failing) {
        expect(await snapshotSession(stub, session)).toEqual(session.before);
      }
      await assertFtsIntegrity(stub);
    });

    it(`retries a failed session once its exclusion expires (near the wall: ${nearWall})`, async () => {
      const { projectId, stub } = await createProject(`expiry-${nearWall}`, 'grouped-cleanup');
      const [large, small] = await seedTwoOldSessions(stub);
      const start = Date.now();
      const run = (offsetMs: number, wrapSql?: (sql: SqlStorage) => SqlStorage) =>
        runCleanup(stub, projectId, {
          mode: { nearWall },
          now: start + offsetMs,
          env: { PROJECT_DATA_GROUPED_FTS_CLEANUP_EXCLUSION_MS: '60000' },
          config: { groupedFtsCleanupBatchSessions: 1, groupedFtsCleanupRecheckMs: 1_000 },
          ...(wrapSql ? { wrapSql } : {}),
        });

      const failed = await run(0, failingPages(new Set([large.sessionId])));
      expect(failed).toMatchObject({ sessionsExcludedForFailure: 1, groupedRowsDeleted: 0 });

      // Still excluded: the run cleans the other session and leaves the failed one alone.
      await run(30_000);
      expect(await snapshotSession(stub, large)).toEqual(large.before);
      expect((await snapshotSession(stub, small)).groupedRows).toBe(0);

      // Once the exclusion has expired, it is tried again and, healthy now, cleaned.
      const retried = await run(120_000);
      expect(retried?.groupedRowsDeleted).toBe(large.before.groupedRows);
      expect((await snapshotSession(stub, large)).groupedRows).toBe(0);
      await assertFtsIntegrity(stub);
    });
  }

  it('wraps around to a session it passed while that session was not excluded', async () => {
    const { projectId, stub } = await createProject('wraparound', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);
    const start = Date.now();
    const exclusionsUnwritable = (sql: SqlStorage) =>
      intercept(sql, {
        onExec: (query, bindings) => {
          if (
            query.startsWith('INSERT INTO do_meta') &&
            bindings[0] === 'storageSafetyGroupedFtsCleanupExclusions'
          ) {
            throw new Error(STORAGE_FULL);
          }
        },
      });
    const run = (offsetMs: number, wrapSql?: (sql: SqlStorage) => SqlStorage) =>
      runCleanup(stub, projectId, {
        mode: { nearWall: false },
        now: start + offsetMs,
        config: { groupedFtsCleanupBatchSessions: 1, groupedFtsCleanupRecheckMs: 1_000 },
        ...(wrapSql ? { wrapSql } : {}),
      });

    // The large session's page fails and, this once, its exclusion cannot be recorded.
    await run(0, (sql) => failingPages(new Set([large.sessionId]))(exclusionsUnwritable(sql)));

    // Past the end of the order after the small session, the run counts the large one still
    // ahead of it instead of reporting nothing left to clean...
    const second = await run(60_000);
    expect((await snapshotSession(stub, small)).groupedRows).toBe(0);
    expect(second?.terminationReason).not.toBe('candidates_exhausted');
    expect(second?.recheckAt).not.toBeNull();

    // ...and the next run comes back round to it.
    await run(120_000);
    expect((await snapshotSession(stub, large)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);
  });

  it('through the real alarm, a row too large for any run is not counted as a failure', async () => {
    const { projectId, stub } = await createProject('benign-exclusion', 'grouped-cleanup');
    await seedTwoOldSessions(stub);

    const lastError = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO do_meta (key, value) VALUES ('storageSafetyLastError', 'previous failure')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      const real = state.storage.sql;
      const alarmEnv = {
        ...testEnv,
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(Math.ceil(real.databaseSize / 0.93)),
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO: '0.9',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO: '0.2',
        // Every grouped row is larger than a whole run may delete.
        PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_BYTES: '1',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
      } as unknown as WorkerEnv;
      const result = await runProjectDataStorageSafetyAlarm(real, alarmEnv, projectId, {
        transactionSync: (callback) => state.storage.transactionSync(callback),
      });
      // Liveness: the run did exclude the sessions it could not afford.
      expect(result.groupedFtsCleanup).toMatchObject({
        sessionsExcluded: 2,
        sessionsExcludedForFailure: 0,
      });
      return state.storage.sql
        .exec(`SELECT value FROM do_meta WHERE key = 'storageSafetyLastError'`)
        .toArray()[0]?.value;
    });

    // A by-design skip is not a failure, so the stale error is cleared as on any clean tick.
    expect(lastError).toBeUndefined();
  });

  it('runs the grouped cleanup through the alarm even when an earlier stage throws', async () => {
    const { projectId, stub } = await createProject('stage-isolation', 'grouped-cleanup');
    const [large] = await seedTwoOldSessions(stub);
    let thrown = 0;

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const real = state.storage.sql;
      const alarmEnv = {
        ...testEnv,
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(Math.ceil(real.databaseSize / 0.93)),
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO: '0.9',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO: '0.2',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
      } as unknown as WorkerEnv;
      // The tool-payload stage fails on its own bookkeeping, as every write does at the cap.
      const failing = intercept(real, {
        onExec: (_query, bindings) => {
          const key = bindings.find((value) => typeof value === 'string');
          if (
            thrown === 0 &&
            typeof key === 'string' &&
            key.startsWith('storageSafetyToolPayload')
          ) {
            thrown++;
            throw new Error('tool payload stage exploded');
          }
        },
      });
      return runProjectDataStorageSafetyAlarm(failing, alarmEnv, projectId, {
        transactionSync: (callback) => state.storage.transactionSync(callback),
      });
    });

    expect(thrown).toBe(1);
    expect(result.cleanup).toBeNull();
    expect(result.groupedFtsCleanup?.groupedRowsDeleted).toBeGreaterThan(0);
    expect((await snapshotSession(stub, large)).groupedRows).toBe(0);
    // The stage that threw is reported as a failure under its own name, not mistaken for a
    // cleanup with nothing left to clean (which would raise a "target unreachable" alert).
    expect(result.cleanupHealth).toBe('failed');
    const meta = await runInDurableObject(stub, async (_instance, state) =>
      Object.fromEntries(
        state.storage.sql
          .exec(
            `SELECT key, value FROM do_meta
             WHERE key IN ('storageSafetyLastError', 'storageSafetyLastAlertReason')`
          )
          .toArray()
          .map((row) => [row.key, row.value])
      )
    );
    expect(meta.storageSafetyLastError).toContain(
      'tool_payload_cleanup: tool payload stage exploded'
    );
    expect(meta.storageSafetyLastAlertReason).not.toBe('cleanup_target_unreachable');
  });

  /** One real storage alarm, with the object sized just above the wall-unsafe ratio. */
  function runNearWallAlarm(
    stub: Stub,
    projectId: string,
    nearWallFlag: string | undefined,
    wrapSql?: (sql: SqlStorage) => SqlStorage
  ) {
    return runInDurableObject(stub, async (_instance, state) => {
      const real = state.storage.sql;
      const alarmEnv: Record<string, unknown> = {
        ...testEnv,
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(Math.ceil(real.databaseSize / 0.99)),
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO: '0.9',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO: '0.2',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO: '0.98',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS: '2',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
      };
      // Unset, the code default decides, as it does in production until the flag is set.
      delete alarmEnv.PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED;
      if (nearWallFlag !== undefined) {
        alarmEnv.PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED = nearWallFlag;
      }
      return runProjectDataStorageSafetyAlarm(
        wrapSql ? wrapSql(real) : real,
        alarmEnv as unknown as WorkerEnv,
        projectId,
        { transactionSync: (callback) => state.storage.transactionSync(callback) }
      );
    });
  }

  it('through the real alarm, stays out near the wall while near-wall mode is unset', async () => {
    const { projectId, stub } = await createProject('alarm-flag-unset', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);

    const result = await runNearWallAlarm(stub, projectId, undefined);

    // Liveness: the grouped stage ran and saw the object near the wall.
    expect(result.groupedFtsCleanup).toMatchObject({
      nearWall: true,
      terminationReason: 'wall_unsafe',
    });
    expect(await snapshotSession(stub, large)).toEqual(large.before);
    expect(await snapshotSession(stub, small)).toEqual(small.before);
  });

  it('through the real alarm with near-wall mode on, rolls a failing page back whole', async () => {
    const { projectId, stub } = await createProject('alarm-flag-on', 'grouped-cleanup');
    const [large, small] = await seedTwoOldSessions(stub);
    let pruning: unknown = null;

    const result = await runNearWallAlarm(stub, projectId, 'true', (sql) =>
      intercept(sql, {
        onExec: (query, bindings) => {
          if (query.startsWith('DELETE FROM chat_messages_grouped')) pruning = bindings[1];
          // Fails after the large session's rows and mark were already deleted in its page.
          if (query.includes(`VALUES('delete'`) && pruning === large.sessionId) {
            throw new Error('disk I/O error');
          }
        },
      })
    );

    expect(result.groupedFtsCleanup).toMatchObject({
      nearWall: true,
      sessionsExcludedForFailure: 1,
      groupedRowsDeleted: small.before.groupedRows,
    });
    // Only the alarm's real transaction undoes the rows and mark deleted before the failure.
    expect(await snapshotSession(stub, large)).toEqual(large.before);
    expect((await snapshotSession(stub, small)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);
  });

  it('archives a pruned session with a full search index on its shard', async () => {
    const { projectId, stub } = await createProject('prune-archive', 'grouped-cleanup');
    const [session] = await seedSessions(stub, [{ label: 'prunearchive', turns: 4 }]);
    const seeded = session!;

    // The alarm prunes the root's search index for the old session...
    const pruned = await runCleanup(stub, projectId, { mode: { nearWall: false } });
    expect(pruned?.groupedRowsDeleted).toBe(seeded.before.groupedRows);
    expect((await snapshotSession(stub, seeded)).ftsMatches).toBe(0);
    await stub.runSummarySyncForTest();

    // ...the archive then moves it to a shard...
    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
      },
      async () => {
        const canary = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          sessionId: seeded.sessionId,
          dryRun: false,
          reason: 'prune then archive',
          limit: 1,
          nowDate: new Date(Date.now() + 60_000),
        });
        expect(canary.stats).toMatchObject({ migrated: 1, failed: 0 });
        expect((await readLocation(projectId, seeded.sessionId))?.location_state).toBe(
          'archive_shard'
        );

        // ...where search finds it again: the shard indexes the full raw transcript.
        const search = await projectDataService.searchMessagesWithArchiveMetadata(
          testEnv,
          projectId,
          seeded.token,
          seeded.sessionId
        );
        expect(search.results.some((r) => r.sessionId === seeded.sessionId)).toBe(true);
      }
    );
  });
});
