import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { D1_MAX_BOUND_PARAMETERS } from '../../src/lib/d1-limits';
import {
  abandonProjectDataArchiveMigration,
  copyBackProjectDataArchiveMigration,
  runProjectDataArchiveSharding,
  runScopedProjectDataArchiveCanary,
} from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import { countTargetMessages, projectDataStub, readLocation,seedMessages, withArchiveEnv } from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import {
  captureProjectDataExpectedError,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'archive-bridge-owner';
const INSTALLATION = 'archive-bridge-installation';
const TARGET_SHA = 'b'.repeat(64);



async function seedProjectGraph(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, {
    name: `Archive Bridge ${projectId}`,
  });
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
 *
 * Deriving this from the constant is deliberate but is NOT a guard: any
 * `x * 2 + 1 > x` assertion would be a tautology. What actually keeps the
 * fixture discriminating is the real runtime — if workerd's true ceiling ever
 * diverged from D1_MAX_BOUND_PARAMETERS downward, these tests would fail
 * outright rather than quietly stop testing anything.
 */
const OVER_BIND_LIMIT_ROWS = D1_MAX_BOUND_PARAMETERS * 2 + 1;

/** Small bodies: this fixture stresses the bind count, not the byte budget. */


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

async function countTargetGroupedMessages(ownerName: string, sessionId: string): Promise<number> {
  const target = projectDataStub(ownerName);
  return runInDurableObject(target, async (_instance, state) => {
    const row = state.storage.sql
      .exec('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?', sessionId)
      .toArray()[0] as { count: number };
    return row.count;
  });
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

/**
 * Seed a failed pre-copy journal for an existing root session: the exact production shape
 * left behind when the terminal-version hash reset the object mid-prepare (journal `failed`,
 * location `migrating`, no source intent, nothing on the shard).
 */
async function seedFailedPreCopyMigration(
  projectId: string,
  sessionId: string,
  migrationId: string
): Promise<{ targetOwnerName: string }> {
  const sourceOwnerName = projectId;
  const targetOwnerName = `${projectId}:archive:g1:s9`;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_migrations (
         migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
         source_generation, target_generation, lease_epoch, attempt_count, error_code,
         error_message, candidate_at, created_at, updated_at
       )
       VALUES (?, ?, ?, 'failed', ?, ?, 0, 1, 1, 1, 'Error',
               'Durable Object''s isolate exceeded its memory limit and was reset.', 1000, 1000, 1000)`
    ).bind(migrationId, projectId, sessionId, sourceOwnerName, targetOwnerName),
    env.DATABASE.prepare(
      `INSERT INTO project_data_session_locations (
         project_id, session_id, location_state, owner_kind, owner_name, generation,
         migration_id, source_owner_name, target_owner_name, routing_schema_version, updated_at
       )
       VALUES (?, ?, 'migrating', 'archive_shard', ?, 1, ?, ?, ?, 1, 1000)`
    ).bind(projectId, sessionId, targetOwnerName, migrationId, sourceOwnerName, targetOwnerName),
  ]);
  return { targetOwnerName };
}

/** Two full default hash pages plus a remainder, so every archive table streams three pages. */
const MULTI_PAGE_MESSAGES = 1_001;

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
  it('migrates a chunk holding more rows than the Cloudflare SQL bind-parameter ceiling', async () => {
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

        // The fixture alternates roles, so materializeSession groups nothing and
        // chat_messages_grouped also lands above the ceiling. That makes this one run
        // cover TWO of the three archive tables through the same sub-batched read,
        // not just chat_messages.
        const groupedRows = await countTargetGroupedMessages(location!.owner_name, sessionId);
        expect(groupedRows).toBe(OVER_BIND_LIMIT_ROWS);
        expect(groupedRows).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);

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
  }, 120_000);

  // The rollback path shares readCommittedRowsForChunk via restoreSourceArchiveChunk
  // and was broken identically. Recovery failing is strictly worse than the forward
  // copy failing, so it gets its own real-trigger test rather than riding on the fix.
  it('copies a chunk back above the bind-parameter ceiling during rollback recovery', async () => {
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
              .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
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
  }, 120_000);

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
  it('migrates a session larger than one hash page through the real DO, streaming every terminal-version proof', async () => {
    const projectId = `archive-multipage-${crypto.randomUUID()}`;
    const { sessionId } = await seedTerminalSessionWithMessages(projectId, MULTI_PAGE_MESSAGES);

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '500',
        PROJECT_DATA_ARCHIVE_CHUNK_BYTES: String(4 * 1024 * 1024),
        PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS: '500',
      },
      async () => {
        const result = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          sessionId,
          dryRun: false,
          reason: 'multi-page streaming hash canary',
          limit: 1,
          wallTimeMs: 15_000,
          nowDate: new Date(Date.now() + 60_000),
        });
        expect(result.stats).toMatchObject({ selected: 1, migrated: 1, failed: 0, poisoned: 0 });

        const location = await readLocation(projectId, sessionId);
        expect(location).toMatchObject({ location_state: 'archive_shard', generation: 1 });
        expect(await projectDataService.getMessageCount(testEnv, projectId, sessionId)).toBe(
          MULTI_PAGE_MESSAGES
        );
        expect(await countTargetMessages(location!.owner_name, sessionId)).toBe(
          MULTI_PAGE_MESSAGES
        );
        const journal = await env.DATABASE.prepare(
          `SELECT state, error_message FROM project_data_archive_migrations
           WHERE project_id = ? AND session_id = ?`
        )
          .bind(projectId, sessionId)
          .first<{ state: string; error_message: string | null }>();
        expect(journal).toMatchObject({ state: 'published', error_message: null });
      }
    );
  });

  it('leaves a session the root object refuses at prepare readable in root, then migrates it once the refusal clears', async () => {
    const projectId = `archive-refusal-${crypto.randomUUID()}`;
    const { source, sessionId } = await seedTerminalSessionWithMessages(projectId, 5);
    // The refusal condition the D1 candidate query cannot see: a live `session_state` row
    // (production `ea87d375`). Reported through the real RPC, exactly as the vm-agent does.
    await source.reportActivity(sessionId, 'prompting', { promptStartedAt: Date.now() });

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '4',
      },
      async () => {
        // Project-scoped, not session-scoped: the session is discovered by the same D1
        // candidate query the sweep uses (an explicit sessionId would bypass the refusal
        // window below), and the refusal crosses the real Durable Object RPC boundary as a
        // returned value. The shared test D1 carries other files' sessions, which is why the
        // unscoped scheduled entry point is not used here.
        const nowDate = new Date(Date.now() + 60_000);
        const first = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          dryRun: false,
          reason: 'refusal canary',
          limit: 4,
          nowDate,
        });
        expect(first.selected.map((candidate) => candidate.sessionId)).toEqual([sessionId]);
        expect(first.stats).toMatchObject({
          selected: 1,
          refused: 1,
          migrated: 0,
          failed: 0,
          poisoned: 0,
        });

        expect(await readLocation(projectId, sessionId)).toMatchObject({
          location_state: 'root',
          owner_kind: 'root',
          owner_name: projectId,
          generation: 0,
          migration_id: null,
        });
        // Readable through exact routing in the same tick — no abandon needed.
        expect(await projectDataService.getMessageCount(testEnv, projectId, sessionId)).toBe(5);
        const journal = await env.DATABASE.prepare(
          `SELECT state, error_code, error_message, attempt_count
           FROM project_data_archive_migrations
           WHERE project_id = ? AND session_id = ?`
        )
          .bind(projectId, sessionId)
          .first<{
            state: string;
            error_code: string;
            error_message: string;
            attempt_count: number;
          }>();
        expect(journal).toMatchObject({
          state: 'frozen',
          error_code: 'precopy_refused',
          attempt_count: 1,
        });
        expect(journal?.error_message).toContain('active_session_state');
        const breaker = await env.DATABASE.prepare(
          'SELECT state FROM project_data_archive_circuit_breakers WHERE project_id = ?'
        )
          .bind(projectId)
          .first<{ state: string }>();
        expect(breaker).toBeNull();
        const rootIntent = await runInDurableObject(source, async (_instance, state) => {
          const row = state.storage.sql
            .exec(
              'SELECT COUNT(*) AS count FROM project_data_archive_source_intents WHERE session_id = ?',
              sessionId
            )
            .toArray()[0] as { count: number };
          return row.count;
        });
        expect(rootIntent).toBe(0);

        // Inside the retry window the same candidate query does not re-select it, so the next
        // tick cannot spend a slot on it again.
        const later = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          dryRun: true,
          limit: 4,
          nowDate: new Date(nowDate.getTime() + 1_000),
        });
        expect(later.selected).toEqual([]);

        // Owner control: once the refusal condition clears, the operator-scoped canary (which
        // bypasses the window) migrates the very same session.
        await source.reportActivity(sessionId, 'idle', { observedAt: Date.now() });
        const result = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          sessionId,
          dryRun: false,
          reason: 'post-refusal re-migration',
          limit: 1,
          nowDate: new Date(Date.now() + 120_000),
        });
        expect(result.stats).toMatchObject({ migrated: 1, refused: 0, failed: 0 });
        expect(await readLocation(projectId, sessionId)).toMatchObject({
          location_state: 'archive_shard',
        });
        expect(await projectDataService.getMessageCount(testEnv, projectId, sessionId)).toBe(5);
      }
    );
  });

  it('abandon returns a fenced pre-copy migration to root so the session reads again', async () => {
    const projectId = `archive-abandon-${crypto.randomUUID()}`;
    const { sessionId } = await seedTerminalSessionWithMessages(projectId, 5);
    const migrationId = crypto.randomUUID();
    await seedFailedPreCopyMigration(projectId, sessionId, migrationId);

    await withArchiveEnv({ PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true' }, async () => {
      // Fenced: the exact read owner is neither root nor a published shard.
      await expect(
        projectDataService.getMessageCount(testEnv, projectId, sessionId)
      ).rejects.toMatchObject({ code: 'PROJECT_DATA_ARCHIVE_ROUTING_UNSAFE' });

      const abandoned = await abandonProjectDataArchiveMigration(testEnv, {
        projectId,
        migrationId,
        reason: 'memory reset during prepare; hash now streams',
      });
      expect(abandoned).toMatchObject({
        previousState: 'failed',
        journalFrozen: true,
        restoredToRoot: true,
        sourceIntentRemoved: false,
        targetRemoved: false,
        targetRowsDeleted: 0,
      });

      expect(await readLocation(projectId, sessionId)).toMatchObject({
        location_state: 'root',
        owner_kind: 'root',
        owner_name: projectId,
        generation: 0,
        migration_id: null,
      });
      expect(await projectDataService.getMessageCount(testEnv, projectId, sessionId)).toBe(5);
      const journal = await env.DATABASE.prepare(
        `SELECT state, error_code FROM project_data_archive_migrations WHERE migration_id = ?`
      )
        .bind(migrationId)
        .first<{ state: string; error_code: string }>();
      expect(journal).toEqual({ state: 'frozen', error_code: 'operator_abandoned' });

      // Discriminating control: the same session migrates cleanly afterwards.
      await withArchiveEnv(
        { PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1', PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '3' },
        async () => {
          const result = await runScopedProjectDataArchiveCanary(testEnv, {
            projectId,
            sessionId,
            dryRun: false,
            reason: 'post-abandon re-migration',
            limit: 1,
            nowDate: new Date(Date.now() + 60_000),
          });
          expect(result.stats).toMatchObject({ migrated: 1, failed: 0 });
          expect(await readLocation(projectId, sessionId)).toMatchObject({
            location_state: 'archive_shard',
          });
        }
      );
    });
  });
});

/**
 * The 2026-09-08 -> 2026-09-12 production standstill: `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET`
 * was lowered to 100000 through a GitHub `production` Environment override while
 * `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` stayed at the checked-in 5000. The affordability
 * ceiling became 3093 write units while selection still admitted 5000-message candidates, and
 * `ORDER BY message_count DESC LIMIT 1` picked the same 4994-message session every hour,
 * estimated ~160,808 writes, was refused before `reserveArchiveWrites` touched D1, and
 * `continue`d out of a one-element list. No journal row, no location change, no error — and
 * `last_status = 'succeeded'` for 226 runs while the object climbed from 94% to 96.7%.
 *
 * Every test here drives the real `runProjectDataArchiveSharding` against real DO SQLite and
 * real D1 so selection, estimation and reservation all run for themselves (`.claude/rules/62`).
 * None of them tells the sweep which candidate to take. A fixture seeded only with affordable
 * candidates would have passed throughout the outage, so each one seeds a mix and asserts on
 * which session actually moved.
 */describe('archive sweep affordability ceiling and budget fall-through', () => {
  /**
   * Per-session message ids. The shared `seedMessages` helper numbers its ids from zero, so
   * two sessions in the same Durable Object collide on `messageId` and the second one silently
   * persists only its non-overlapping tail — which quietly changes the `message_count` a
   * candidate is ranked and filtered by.
   */
  function messagesFor(prefix: string, count: number, filler = 0) {
    return Array.from({ length: count }, (_, index) => ({
      messageId: `${prefix}-${String(index).padStart(4, '0')}`,
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `${prefix} payload ${index}${filler > 0 ? ` ${'h'.repeat(filler)}` : ''}`,
      toolMetadata: null,
      timestamp: new Date(2_000_000 + index * 1_000).toISOString(),
      sequence: index + 1,
    }));
  }

  type SeededSession = { sessionId: string; messageCount: number; estimate: number };

  /**
   * Seed one terminal session and read back BOTH numbers the sweep reasons about: the
   * `session_summaries.message_count` it selects and ranks by, and the write estimate the
   * real Durable Object computes for it. Every fixture below is sized from these measurements
   * rather than from assumed message sizes, so a change to the grouping rule or to the FTS
   * unit size makes the preconditions fail loudly instead of silently moving the boundary.
   *
   * Measuring the cost model is not the same as telling the sweep what to pick: the sweep
   * still runs its own selection, its own estimate and its own reservation.
   */
  async function seedTerminalSession(
    source: DurableObjectStub<ProjectDataTestDouble>,
    prefix: string,
    count: number,
    filler = 0
  ): Promise<SeededSession> {
    const sessionId = await source.createSession(null, prefix);
    await source.persistMessageBatch(sessionId, messagesFor(prefix, count, filler));
    await source.stopSession(sessionId);
    await source.runSummarySyncForTest();
    const estimate = await source.archiveSourceEstimateWrites(
      sessionId,
      1,
      Number.MAX_SAFE_INTEGER
    );
    const row = await env.DATABASE.prepare(
      'SELECT message_count FROM session_summaries WHERE id = ?'
    )
      .bind(sessionId)
      .first<{ message_count: number }>();
    if (!row) throw new Error(`No session_summaries row for ${prefix}`);
    return { sessionId, messageCount: row.message_count, estimate };
  }

  /**
   * Tests in this file share one D1, and EVERY input `selectMigrationWork` reads is global:
   *
   * - `selectCandidates` ranks across all projects (that global ranking is the behaviour
   *   under test), so an earlier fixture competes for this tick's one session slot.
   * - `selectReclaimableMigrations` is also global and is served FIRST, so one leftover
   *   in-flight journal consumes `sweepSessions` outright and leaves `pending` empty —
   *   the sweep then migrates nothing for a reason that has nothing to do with the budget.
   * - `project_data_archive_write_budget` is a single `'global'` row keyed only by UTC
   *   window, so an earlier test's reservations are still charged against this one.
   *
   * Clearing all three is fixture hygiene, not hand-feeding: within the project the sweep
   * still sees a mix of candidates and chooses for itself, and it still spends the allowance
   * itself. It also makes these tests independent of whether an earlier test PASSED, which
   * the first draft was not — a failure upstream perturbed them into failing for unrelated
   * reasons, which is exactly the sort of coupling that makes a red suite unreadable.
   */
  async function isolateSweepFixture(projectId: string): Promise<void> {
    await env.DATABASE.batch([
      env.DATABASE.prepare('DELETE FROM session_summaries WHERE project_id != ?').bind(projectId),
      env.DATABASE.prepare('DELETE FROM project_data_archive_migrations WHERE project_id != ?').bind(
        projectId
      ),
      env.DATABASE.prepare(
        'DELETE FROM project_data_session_locations WHERE project_id != ?'
      ).bind(projectId),
      env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget'),
    ]);
  }

  async function readCadence() {
    return env.DATABASE.prepare(
      `SELECT last_status, last_error, consecutive_budget_stalls, run_count
       FROM project_data_archive_global_sweep_cadence
       WHERE sweep_name = 'archive_sharding_global_sweep'`
    ).first<{
      last_status: string;
      last_error: string | null;
      consecutive_budget_stalls: number;
      run_count: number;
    }>();
  }

  async function newArchiveProject(prefix: string) {
    const projectId = `${prefix}-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = projectDataStub(projectId);
    await source.ensureProjectId(projectId);
    return { projectId, source };
  }

  it('migrates an affordable session when the largest eligible one exceeds the whole allowance', async () => {
    await clearArchiveCadence();
    const { projectId, source } = await newArchiveProject('archive-ceiling');

    // Production's shape: one candidate far above what the allowance can pay for, sorting
    // first under `ORDER BY message_count DESC`, and several affordable ones behind it.
    const unaffordable = await seedTerminalSession(source, 'unaffordable', 400);
    const largestAffordable = await seedTerminalSession(source, 'affordable-a', 40);
    const midAffordable = await seedTerminalSession(source, 'affordable-b', 30);
    const smallAffordable = await seedTerminalSession(source, 'affordable-c', 20);
    await isolateSweepFixture(projectId);

    // factor 1 keeps write units and estimate arithmetic legible, and 0% assumed overhead
    // makes the derived ceiling exactly the affordable unit count.
    const allowance = largestAffordable.estimate;
    const affordableWriteUnits = allowance - 1000;

    // Fixture preconditions: the mix must actually straddle the boundary. Without these the
    // test could stop testing anything if the grouping rule or FTS unit size changed, and
    // would then pass while proving nothing (`.claude/rules/69`).
    expect(unaffordable.estimate).toBeGreaterThan(allowance);
    expect(unaffordable.messageCount).toBe(400);
    expect(largestAffordable.messageCount).toBe(40);
    expect(affordableWriteUnits).toBeGreaterThanOrEqual(largestAffordable.messageCount);
    expect(affordableWriteUnits).toBeLessThan(unaffordable.messageCount);

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        // The deployed production selection shape: one project, one session slot.
        PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
        // The drifted value, left deliberately high: the derived ceiling must override it.
        PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000',
        PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '0',
        PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '1',
        PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: String(allowance),
      },
      async () => {
        const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000));

        // The whole point: the tick made progress instead of stalling on the big session.
        expect(stats).toMatchObject({ skipped: false, migrated: 1, failed: 0 });
        expect(stats.messageCeiling).toBe(affordableWriteUnits);
        expect(stats.affordableWriteUnits).toBe(affordableWriteUnits);
        // The oversized session never reached `reserve()` at all — the derived ceiling
        // removed it from selection, so no budget refusal was needed to skip it.
        expect(stats.budgetUnaffordable).toBe(0);

        // Largest-first is preserved WITHIN the affordable set: the 40-message session moved,
        // not one of the smaller ones. Ranking still matches the sweep's purpose
        // (`.claude/rules/65`) — the fixed 1000-unit reservation makes bigger sessions the
        // more efficient use of the allowance.
        expect(await readLocation(projectId, largestAffordable.sessionId)).toMatchObject({
          location_state: 'archive_shard',
        });
        // Liveness controls: everything else is still exactly where it was, and in particular
        // the unaffordable session is readable in root rather than fenced `migrating`.
        expect(await readLocation(projectId, unaffordable.sessionId)).toBeNull();
        expect(await readLocation(projectId, midAffordable.sessionId)).toBeNull();
        expect(await readLocation(projectId, smallAffordable.sessionId)).toBeNull();
        expect(await source.getMessageCount(unaffordable.sessionId)).toBe(400);

        // The sweep's own liveness signal advanced, and the cadence row is clean.
        expect(await readCadence()).toMatchObject({
          last_status: 'succeeded',
          last_error: null,
          consecutive_budget_stalls: 0,
        });
      }
    );
  });

  it('falls through to a smaller candidate when the top candidate passes the ceiling but the budget refuses it', async () => {
    await clearArchiveCadence();
    const { projectId, source } = await newArchiveProject('archive-fallthrough');

    // Two sessions with almost identical `message_count`, so NO message-count-derived ceiling
    // can separate them — but wildly different real cost, because the estimate also charges
    // for grouped rows and FTS bytes. This is the residual error the derived ceiling cannot
    // remove, and the case the fall-through exists for.
    const heavy = await seedTerminalSession(source, 'heavy', 21, 48 * 1024);
    const light = await seedTerminalSession(source, 'light', 20);
    await isolateSweepFixture(projectId);

    const allowance = light.estimate;
    const affordableWriteUnits = allowance - 1000;

    // Preconditions: the heavy session must sort FIRST, must PASS the derived ceiling (so the
    // ceiling cannot be what skips it), and must still be unaffordable.
    expect(heavy.messageCount).toBeGreaterThan(light.messageCount);
    expect(affordableWriteUnits).toBeGreaterThanOrEqual(heavy.messageCount);
    expect(heavy.estimate).toBeGreaterThan(allowance);

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
        // ONE session slot, exactly as production ran. With a slot-sized candidate read the
        // refusal below would end the tick; the over-fetch is the only thing that supplies a
        // smaller candidate to descend to.
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000',
        PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '0',
        PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '1',
        PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: String(allowance),
        PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '5',
      },
      async () => {
        const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000));

        expect(stats).toMatchObject({ skipped: false, migrated: 1, failed: 0 });
        // The heavy session WAS tried and refused — that is what the descent is descending
        // from. Asserting it proves the fall-through ran, rather than the ceiling having
        // quietly excluded the heavy session after all.
        expect(stats.budgetUnaffordable).toBe(1);
        expect(stats.budgetWindowExhausted).toBe(0);

        expect(await readLocation(projectId, light.sessionId)).toMatchObject({
          location_state: 'archive_shard',
        });
        // The refused candidate opened no `migrating` fence, so it stays readable in root and
        // is a candidate again next tick.
        expect(await readLocation(projectId, heavy.sessionId)).toBeNull();
        expect(await source.getMessageCount(heavy.sessionId)).toBe(heavy.messageCount);

        // One refusal is not a stall: the tick migrated something.
        expect(await readCadence()).toMatchObject({
          last_status: 'succeeded',
          consecutive_budget_stalls: 0,
        });
      }
    );
  });

  it('stops reporting succeeded after consecutive sweeps that can afford nothing, and resets once one lands', async () => {
    await clearArchiveCadence();
    const { projectId, source } = await newArchiveProject('archive-stall');

    const heavy = await seedTerminalSession(source, 'heavy-only', 12, 48 * 1024);
    await isolateSweepFixture(projectId);

    // An allowance that admits the session by message_count but never by cost. The derived
    // ceiling cannot exclude it, so every tick reaches `reserve()` and is refused with
    // `exceeds_allowance` — the deadlock signature.
    const allowance = 1000 + 100;
    expect(allowance - 1000).toBeGreaterThanOrEqual(heavy.messageCount);
    expect(heavy.estimate).toBeGreaterThan(allowance);

    const stallEnv = {
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
      PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
      PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
      PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000',
      PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '0',
      PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '1',
      PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: String(allowance),
      PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1000',
      PROJECT_DATA_ARCHIVE_BUDGET_STALL_ALERT_SWEEPS: '3',
      PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '5',
    } as const;

    const base = Date.now() + 60_000;
    await withArchiveEnv(stallEnv, async () => {
      // Below the threshold the sweep still reports succeeded: an occasional unaffordable
      // candidate is expected, because the ceiling is derived from an ASSUMED overhead.
      for (const [index, tick] of [base, base + 10_000].entries()) {
        const stats = await runProjectDataArchiveSharding(testEnv, new Date(tick));
        expect(stats).toMatchObject({ migrated: 0, budgetUnaffordable: 1 });
        expect(await readCadence()).toMatchObject({
          last_status: 'succeeded',
          last_error: null,
          consecutive_budget_stalls: index + 1,
        });
      }

      await runProjectDataArchiveSharding(testEnv, new Date(base + 20_000));
      const stalled = await readCadence();
      expect(stalled).toMatchObject({ last_status: 'partial', consecutive_budget_stalls: 3 });
      // The message must name the recovery action, not just the symptom (`.claude/rules/72`),
      // and must say that waiting will not help — that was the false signal for four days.
      expect(stalled?.last_error).toContain('Waiting will not clear this');
      expect(stalled?.last_error).toContain('PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET');
      expect(stalled?.last_error).toContain('PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET');
    });

    // Control: a sweep that DOES migrate resets the streak, so an alert always describes a
    // CURRENT run of stuck ticks rather than accumulating for the object's lifetime
    // (`.claude/rules/61`).
    await withArchiveEnv(
      { ...stallEnv, PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: String(heavy.estimate) },
      async () => {
        const stats = await runProjectDataArchiveSharding(testEnv, new Date(base + 30_000));
        expect(stats).toMatchObject({ migrated: 1, budgetUnaffordable: 0 });
        expect(await readLocation(projectId, heavy.sessionId)).toMatchObject({
          location_state: 'archive_shard',
        });
        expect(await readCadence()).toMatchObject({
          last_status: 'succeeded',
          last_error: null,
          consecutive_budget_stalls: 0,
        });
      }
    );
  });

  it('does not count an exhausted daily pool as a stall', async () => {
    await clearArchiveCadence();
    const { projectId, source } = await newArchiveProject('archive-pool-spent');

    const first = await seedTerminalSession(source, 'first', 30);
    const second = await seedTerminalSession(source, 'second', 20);
    await isolateSweepFixture(projectId);

    // Enough for the first session, not enough for both. The second refusal is therefore a
    // SPENT POOL, whose recovery is simply the next UTC window — it must not be counted as a
    // stall, or the alert would fire on almost every tick of a healthy day.
    const allowance = first.estimate;
    expect(first.estimate + second.estimate).toBeGreaterThan(allowance);
    expect(second.estimate).toBeLessThanOrEqual(allowance);
    expect(allowance - 1000).toBeGreaterThanOrEqual(first.messageCount);

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '5000',
        PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '0',
        PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '1',
        PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: String(allowance),
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1000',
        // Threshold 1: even the most trigger-happy setting must not treat a spent pool as a
        // stall. Without the category split this assertion would fail on every healthy day.
        PROJECT_DATA_ARCHIVE_BUDGET_STALL_ALERT_SWEEPS: '1',
      },
      async () => {
        const base = Date.now() + 60_000;
        const firstTick = await runProjectDataArchiveSharding(testEnv, new Date(base));
        expect(firstTick).toMatchObject({ migrated: 1 });
        expect(await readLocation(projectId, first.sessionId)).toMatchObject({
          location_state: 'archive_shard',
        });

        // Same UTC window, pool now spent. The exact refusal COUNT is not the point (and is
        // sensitive to how many candidates the over-fetch reaches), so assert the categories:
        // at least one spent-pool refusal, and zero unaffordable ones.
        const secondTick = await runProjectDataArchiveSharding(testEnv, new Date(base + 10_000));
        expect(secondTick).toMatchObject({ migrated: 0 });
        expect(secondTick.budgetWindowExhausted ?? 0).toBeGreaterThanOrEqual(1);
        expect(secondTick.budgetUnaffordable).toBe(0);
        expect(await readLocation(projectId, second.sessionId)).toBeNull();

        // Even at a threshold of 1, an exhausted pool leaves the cadence clean.
        expect(await readCadence()).toMatchObject({
          last_status: 'succeeded',
          last_error: null,
          consecutive_budget_stalls: 0,
        });
      }
    );
  });
});
