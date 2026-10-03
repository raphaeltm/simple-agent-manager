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
    } as unknown as WorkerEnv;
    return runProjectDataGroupedFtsCleanup(sql, runEnv, projectId, config, {
      allowStart: true,
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

    expect(result).toMatchObject({ terminationReason: 'storage_full', groupedRowsDeleted: 0 });
    const after = await snapshotSession(stub, large);
    // Rows, index entries and the session mark are all exactly as before.
    expect(after).toEqual(large.before);
    await assertFtsIntegrity(stub);
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
    expect(result!.afterBytes).toBeLessThanOrEqual(result!.beforeBytes);
    // Either a page committed (and so did not grow) or it was rolled back; never a stale entry.
    expect(result!.groupedRowsDeleted + result!.pagesRolledBackForGrowth).toBeGreaterThan(0);
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
