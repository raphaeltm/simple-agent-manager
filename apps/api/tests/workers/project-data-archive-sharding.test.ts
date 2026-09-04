import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { D1_MAX_BOUND_PARAMETERS } from '../../src/lib/d1-limits';
import {
  copyBackProjectDataArchiveMigration,
  runProjectDataArchiveSharding,
  runScopedProjectDataArchiveCanary,
} from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import {
  captureProjectDataExpectedError,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'archive-bridge-owner';
const INSTALLATION = 'archive-bridge-installation';
const TARGET_SHA = 'b'.repeat(64);

function projectDataStub(ownerName: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(ownerName)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, {
    name: `Archive Bridge ${projectId}`,
  });
}

async function withArchiveEnv<T>(
  overrides: Partial<Record<keyof WorkerEnv, string>>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = testEnv as WorkerEnv & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

function largeMessage(index: number): string {
  return `archive bridge payload ${index} ${'x'.repeat(24 * 1024)}`;
}

/**
 * One chunk holding more rows than Cloudflare will bind in a single statement.
 * 201 spans two full sub-batches plus a remainder, so an off-by-one in the
 * batching arithmetic cannot pass by landing on an exact multiple.
 *
 * Production ran at PROJECT_DATA_ARCHIVE_CHUNK_ROWS=500 and every session above
 * 100 messages died on `too many SQL variables at offset 421`.
 */
const OVER_BIND_LIMIT_ROWS = D1_MAX_BOUND_PARAMETERS * 2 + 1;

/** Small bodies: this fixture stresses the bind count, not the byte budget. */
function seedMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `bind-limit-message-${String(index).padStart(4, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `bind limit payload ${index}`,
    toolMetadata: null,
    timestamp: new Date(1_000_000 + index * 1_000).toISOString(),
    sequence: index + 1,
  }));
}

async function seedTerminalSessionWithMessages(
  projectId: string,
  count: number
): Promise<{ source: DurableObjectStub<ProjectDataTestDouble>; sessionId: string }> {
  await seedProjectGraph(projectId);
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  const sessionId = await source.createSession(null, 'Bind limit transcript');
  await source.persistMessageBatch(sessionId, seedMessages(count));
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  return { source, sessionId };
}

async function countTargetMessages(ownerName: string, sessionId: string): Promise<number> {
  const target = projectDataStub(ownerName);
  return runInDurableObject(target, async (_instance, state) => {
    const row = state.storage.sql
      .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
      .toArray()[0] as { count: number };
    return row.count;
  });
}

async function readLocation(projectId: string, sessionId: string) {
  return env.DATABASE.prepare(
    `SELECT location_state, owner_kind, owner_name, generation, migration_id, target_aggregate_sha256
     FROM project_data_session_locations
     WHERE project_id = ? AND session_id = ?`
  )
    .bind(projectId, sessionId)
    .first<{
      location_state: string;
      owner_kind: string;
      owner_name: string;
      generation: number;
      migration_id: string | null;
      target_aggregate_sha256: string | null;
    }>();
}

async function clearArchiveCadence(): Promise<void> {
  await env.DATABASE.prepare(
    `DELETE FROM project_data_archive_global_sweep_cadence
     WHERE sweep_name = 'archive_sharding_global_sweep'`
  ).run();
}

async function readArchiveCadence() {
  return env.DATABASE.prepare(
    `SELECT last_started_at, next_eligible_at, last_status, lease_owner, lease_expires_at, run_count
     FROM project_data_archive_global_sweep_cadence
     WHERE sweep_name = 'archive_sharding_global_sweep'`
  ).first<{
    last_started_at: number;
    next_eligible_at: number;
    last_status: string;
    lease_owner: string | null;
    lease_expires_at: number | null;
    run_count: number;
  }>();
}

async function seedSourceDeletedCrashGap(
  projectId: string,
  sessionId: string,
  migrationId: string
): Promise<void> {
  const sourceOwnerName = projectId;
  const targetOwnerName = `${projectId}:archive:g1:s1`;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_migrations (
         migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
         source_generation, target_generation, source_intent_token, terminal_version_sha256,
         target_aggregate_sha256, r2_manifest_key, lease_epoch, attempt_count,
         candidate_at, created_at, updated_at
       )
       VALUES (?, ?, ?, 'source_deleted', ?, ?, 0, 1, 'source-token', ?, ?, 'manifest-key',
               0, 1, 1000, 1000, 1000)`
    ).bind(
      migrationId,
      projectId,
      sessionId,
      sourceOwnerName,
      targetOwnerName,
      'a'.repeat(64),
      TARGET_SHA
    ),
    env.DATABASE.prepare(
      `INSERT INTO project_data_session_locations (
         project_id, session_id, location_state, owner_kind, owner_name, generation,
         migration_id, source_owner_name, target_owner_name, target_aggregate_sha256,
         routing_schema_version, updated_at
       )
       VALUES (?, ?, 'migrating', 'archive_shard', ?, 1, ?, ?, ?, ?, 1, 1000)`
    ).bind(
      projectId,
      sessionId,
      targetOwnerName,
      migrationId,
      sourceOwnerName,
      targetOwnerName,
      TARGET_SHA
    ),
  ]);
}

describe('ProjectData archive-sharding bridge in the Workers runtime', () => {
  it('migrates a terminal transcript through real DO SQLite, publishes archive routing, and records databaseSize reclaim evidence', async () => {
    await clearArchiveCadence();
    const projectId = `archive-bridge-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = projectDataStub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Workers archive bridge');
    for (let index = 0; index < 12; index++) {
      await source.persistMessage(
        sessionId,
        index % 2 === 0 ? 'user' : 'assistant',
        largeMessage(index),
        null
      );
    }
    await source.stopSession(sessionId);
    await source.runSummarySyncForTest();

    const rootBefore = await runInDurableObject(
      source,
      async (_instance, state) => state.storage.sql.databaseSize
    );

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '4',
        PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '3',
        PROJECT_DATA_ARCHIVE_CHUNK_BYTES: String(128 * 1024),
      },
      async () => {
        const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000));
        expect(stats).toMatchObject({
          enabled: true,
          skipped: false,
          migrated: 1,
          failed: 0,
        });

        const location = await readLocation(projectId, sessionId);
        expect(location).toMatchObject({
          location_state: 'archive_shard',
          owner_kind: 'archive_shard',
          generation: 1,
        });
        expect(location?.owner_name).toContain(':archive:g1:');
        expect(location?.migration_id).toBeTruthy();
        expect(location?.target_aggregate_sha256).toMatch(/^[a-f0-9]{64}$/);

        const routed = await projectDataService.getMessages(
          testEnv,
          projectId,
          sessionId,
          20,
          null,
          null,
          undefined,
          false,
          'asc'
        );
        expect(routed.messages).toHaveLength(12);
        expect(routed.messages[0]?.content).toContain('archive bridge payload 0');
        await expect(
          projectDataService.persistMessage(
            testEnv,
            projectId,
            sessionId,
            'assistant',
            'late write',
            null
          )
        ).rejects.toMatchObject({ code: 'PROJECT_DATA_ARCHIVE_ROUTING_UNSAFE' });

        const sourceProof = await runInDurableObject(source, async (_instance, state) => {
          const sql = state.storage.sql;
          const intent = sql
            .exec(
              `SELECT state, source_database_size_before, source_database_size_after
               FROM project_data_archive_source_intents
               WHERE session_id = ?`,
              sessionId
            )
            .toArray()[0] as {
            state: string;
            source_database_size_before: number;
            source_database_size_after: number;
          };
          const rootMessages = sql
            .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
            .toArray()[0] as { count: number };
          return {
            intent,
            rootMessages: rootMessages.count,
            databaseSize: sql.databaseSize,
          };
        });
        expect(sourceProof.intent.state).toBe('source_deleted');
        expect(sourceProof.intent.source_database_size_before).toBeGreaterThanOrEqual(rootBefore);
        expect(sourceProof.intent.source_database_size_after).toBeLessThan(
          sourceProof.intent.source_database_size_before
        );
        expect(sourceProof.rootMessages).toBe(0);
        // `source_database_size_after` is captured before the final intent-row UPDATE. In the
        // real workerd SQLite runtime that metadata write can allocate pages, so the live
        // `sql.databaseSize` observed here may be larger than the recorded post-delete proof.
        // The invariant is that both measurements remain below the pre-delete size and the
        // recorded proof captured actual reclaim after source transcript rows were deleted.
        expect(sourceProof.databaseSize).toBeLessThan(
          sourceProof.intent.source_database_size_before
        );
        expect(sourceProof.databaseSize).toBeGreaterThanOrEqual(
          sourceProof.intent.source_database_size_after
        );

        const target = projectDataStub(location!.owner_name);
        const targetRows = await runInDurableObject(target, async (_instance, state) => {
          const sql = state.storage.sql;
          const messages = sql
            .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
            .toArray()[0] as { count: number };
          const chunks = sql
            .exec(
              'SELECT COUNT(*) AS count FROM project_data_archive_target_chunks WHERE session_id = ?',
              sessionId
            )
            .toArray()[0] as { count: number };
          return { messages: messages.count, chunks: chunks.count };
        });
        expect(targetRows.messages).toBe(12);
        expect(targetRows.chunks).toBeGreaterThan(0);
      }
    );
  });

  it('daily-gates repeated global scheduled archive-sharding sweeps in the Workers runtime', async () => {
    await clearArchiveCadence();
    const projectId = `archive-cadence-${crypto.randomUUID()}`;
    const sessionId = `session-${crypto.randomUUID()}`;
    const migrationId = `migration-${crypto.randomUUID()}`;
    const firstNow = Date.now() + 60_000;
    await seedProjectGraph(projectId);
    await seedSourceDeletedCrashGap(projectId, sessionId, migrationId);

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '4',
      },
      async () => {
        const first = await runProjectDataArchiveSharding(testEnv, new Date(firstNow));
        expect(first).toMatchObject({
          enabled: true,
          skipped: false,
          recoveredCrashGaps: 1,
          cadence: {
            claimed: true,
            nextEligibleAt: firstNow + 86_400_000,
            lastStatus: 'succeeded',
            runCount: 1,
          },
        });
        expect(await readLocation(projectId, sessionId)).toMatchObject({
          location_state: 'archive_shard',
        });

        const second = await runProjectDataArchiveSharding(testEnv, new Date(firstNow + 300_000));
        expect(second).toMatchObject({
          skipped: true,
          skipReason: 'cadence_not_due',
          selected: 0,
          migrated: 0,
          recoveredCrashGaps: 0,
          cadence: {
            claimed: false,
            nextEligibleAt: firstNow + 86_400_000,
            remainingMs: 86_100_000,
            runCount: 1,
          },
        });
        expect(await readArchiveCadence()).toMatchObject({
          last_started_at: firstNow,
          next_eligible_at: firstNow + 86_400_000,
          last_status: 'succeeded',
          lease_owner: null,
          lease_expires_at: null,
          run_count: 1,
        });
      }
    );
  });

  // Regression: production archive-sharding canary runs failed with
  // `too many SQL variables at offset 421: SQLITE_ERROR` for every session above
  // 100 messages. readCommittedRowsForChunk bound one placeholder per chunk row,
  // and Cloudflare's SQL surfaces reject the 101st bound parameter.
  //
  // These MUST live in the Workers pool. The DO unit suite runs on better-sqlite3,
  // whose bind ceiling is far above 100, so it cannot reproduce this at any fixture
  // size — which is exactly why a 12-row suite stayed green while production failed.
  it(
    'migrates a chunk holding more rows than the Cloudflare SQL bind-parameter ceiling',
    async () => {
      // Guards the fixture itself: if the platform ceiling is ever raised, this
      // assertion fails loudly rather than silently becoming non-discriminating.
      expect(OVER_BIND_LIMIT_ROWS).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);

      await clearArchiveCadence();
      const projectId = `archive-bind-limit-${crypto.randomUUID()}`;
      const { sessionId } = await seedTerminalSessionWithMessages(projectId, OVER_BIND_LIMIT_ROWS);

      await withArchiveEnv(
        {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        },
        async () => {
          // The exact entry point the production canary used, at the production
          // chunk-row setting, so the whole transcript lands in ONE chunk.
          const result = await runScopedProjectDataArchiveCanary(testEnv, {
            projectId,
            sessionId,
            dryRun: false,
            reason: 'bind-variable-limit regression',
            limit: 5,
            chunkRows: 500,
            nowDate: new Date(Date.now() + 60_000),
          });

          expect(result.stats).toMatchObject({ selected: 1, migrated: 1, failed: 0 });

          const location = await readLocation(projectId, sessionId);
          expect(location).toMatchObject({
            location_state: 'archive_shard',
            owner_kind: 'archive_shard',
          });
          expect(await countTargetMessages(location!.owner_name, sessionId)).toBe(
            OVER_BIND_LIMIT_ROWS
          );

          // Order is load-bearing: the committed rows are re-hashed against the
          // source chunk hash, so a batch concatenated out of order would have
          // failed the migration above. Assert the transcript reads back in order.
          const routed = await projectDataService.getMessages(
            testEnv,
            projectId,
            sessionId,
            OVER_BIND_LIMIT_ROWS,
            null,
            null,
            undefined,
            false,
            'asc'
          );
          expect(routed.messages).toHaveLength(OVER_BIND_LIMIT_ROWS);
          expect(routed.messages[0]?.content).toBe('bind limit payload 0');
          expect(routed.messages[OVER_BIND_LIMIT_ROWS - 1]?.content).toBe(
            `bind limit payload ${OVER_BIND_LIMIT_ROWS - 1}`
          );
        }
      );
    },
    120_000
  );

  // The rollback path shares readCommittedRowsForChunk via restoreSourceArchiveChunk
  // and was broken identically. Recovery failing is strictly worse than the forward
  // copy failing, so it gets its own real-trigger test rather than riding on the fix.
  it(
    'copies a chunk back above the bind-parameter ceiling during rollback recovery',
    async () => {
      await clearArchiveCadence();
      const projectId = `archive-bind-limit-copyback-${crypto.randomUUID()}`;
      const { source, sessionId } = await seedTerminalSessionWithMessages(
        projectId,
        OVER_BIND_LIMIT_ROWS
      );

      await withArchiveEnv(
        {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        },
        async () => {
          const migrated = await runScopedProjectDataArchiveCanary(testEnv, {
            projectId,
            sessionId,
            dryRun: false,
            reason: 'bind-variable-limit copy-back regression',
            limit: 5,
            chunkRows: 500,
            nowDate: new Date(Date.now() + 60_000),
          });
          expect(migrated.stats).toMatchObject({ migrated: 1, failed: 0 });

          const location = await readLocation(projectId, sessionId);
          expect(location?.migration_id).toBeTruthy();

          // Source transcript rows were deleted by the forward migration.
          const sourceRowsAfterMigrate = await runInDurableObject(
            source,
            async (_instance, state) => {
              const row = state.storage.sql
                .exec(
                  'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
                  sessionId
                )
                .toArray()[0] as { count: number };
              return row.count;
            }
          );
          expect(sourceRowsAfterMigrate).toBe(0);

          const copyBack = await copyBackProjectDataArchiveMigration(testEnv, {
            migrationId: location!.migration_id!,
            projectId,
            reason: 'bind-variable-limit copy-back regression',
          });
          expect(copyBack.rowsCopied).toBeGreaterThanOrEqual(OVER_BIND_LIMIT_ROWS);

          const restored = await runInDurableObject(source, async (_instance, state) => {
            const row = state.storage.sql
              .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
              .toArray()[0] as { count: number };
            return row.count;
          });
          expect(restored).toBe(OVER_BIND_LIMIT_ROWS);
        }
      );
    },
    120_000
  );

  it('fails closed for DO-local transcript writes after a source archive intent is prepared', async () => {
    const projectId = `archive-local-fence-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = projectDataStub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Local archive write fence');
    await source.persistMessage(sessionId, 'user', 'before archive', null);
    await source.stopSession(sessionId);

    await source.archiveSourcePrepareIntent({
      projectId,
      sessionId,
      migrationId: 'migration-local-fence',
      sourceOwnerName: projectId,
      targetOwnerName: `${projectId}:archive:g1:s1`,
      targetGeneration: 1,
      sourceIntentToken: 'source-intent-local-fence',
      now: Date.now() + 60_000,
      minTerminalAgeMs: 1,
    });

    const captured = await captureProjectDataExpectedError(source, {
      operation: 'persistMessage',
      args: [sessionId, 'assistant', 'late local write', null],
    });
    expect(captured).toMatchObject({
      threw: true,
      code: 'PROJECT_DATA_TRANSCRIPT_WRITE_FENCED',
    });
  });
});
