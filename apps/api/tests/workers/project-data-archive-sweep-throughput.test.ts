/**
 * The sweep message budget is a SELECTION PREDICATE, not just a pacing knob.
 *
 * `selectCandidates` binds `config.sweepMessageCeiling` into
 * `AND ss.message_count <= ?` whenever `PROJECT_DATA_ARCHIVE_COMPACT_ENABLED` is `true`, so a
 * session larger than the budget is not deferred — it is invisible to every tick for as long
 * as the budget stands. Measured in production D1 on 2026-09-20 while the root ProjectData
 * object sat at 9.98 GB of its 10 GB configured limit: at the then-deployed budget of 5000,
 * 306 eligible SAM sessions holding 2,341,731 messages (40% of that project's eligible
 * backlog) could never be selected at all.
 *
 * Both cases below drive the real `runProjectDataArchiveSharding` against real DO SQLite, real
 * D1 and the real R2 binding, over ONE fixture, and differ only in the shipped budget value
 * (`.claude/rules/62`, `.claude/rules/74`). Neither tells the sweep which candidate to take:
 * selection, estimation, reservation, chunking and the source-deletion proof all run for
 * themselves. The first case is the divergence proof — it must fail if the ceiling stops
 * excluding the band — and it carries a liveness assertion beside its absence assertion, so a
 * sweep that migrated nothing at all cannot pass it.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, inject,it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import { projectDataStub, readLocation, withArchiveEnv } from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'archive-throughput-owner';
const INSTALLATION = 'archive-throughput-installation';

/**
 * The checked-in `[vars]` table, injected by `vitest.workers.config.ts` because `node:fs` does
 * not exist inside workerd. Reading the shipped value rather than retyping it is what keeps
 * this pair honest: a test that pins a hand-copied 20000 stays green after someone edits
 * `wrangler.toml` (`.claude/rules/70`). Both vars read here were verified absent from the
 * `production` and `staging` GitHub Environments on 2026-09-20, so the checked-in value IS the
 * deployed value.
 */
const SHIPPED_VARS = JSON.parse(inject<string>('SHIPPED_WORKER_VARS_JSON')) as Record<
  string,
  unknown
>;

function shippedVar(name: string): string {
  const value = SHIPPED_VARS[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} is not a string in the [vars] table of apps/api/wrangler.toml`);
  }
  return value;
}

/** The budget production ran until 2026-09-20, and the ceiling that hid the band. */
const PREVIOUS_SWEEP_MESSAGE_BUDGET = '5000';

/**
 * A session sized to the shipped ceiling itself, not merely somewhere inside the band.
 *
 * The largest compact (`r2-gzip-v1`) session production had ever published as of 2026-09-20
 * was 4,994 messages, so the raised budget is a 4x extrapolation past anything that has run.
 * Seeding the ceiling exactly means the copy/seal/manifest/finalize state machine is exercised
 * at the size the sweep will now actually select — roughly 40 R2 chunks at CHUNK_ROWS=500,
 * against the real binding.
 *
 * What this does NOT establish: workerd under Miniflare has no Cloudflare CPU accounting and
 * no real R2 latency, so a green run here proves correctness at this size (no chunk gaps, hash
 * agreement, complete source deletion) but licenses no claim about the deployed tick's wall
 * clock or `cpu_ms` budget. That question is answered from production `phaseDurationsMs`
 * telemetry and recorded in the task file.
 */
const BAND_MESSAGE_COUNT = 20_000;

/** Liveness control: comfortably under BOTH budgets, so it moves whatever the ceiling is. */
const SMALL_MESSAGE_COUNT = 40;

function messagesFor(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `${prefix}-${String(index).padStart(5, '0')}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${prefix} payload ${index}`,
    toolMetadata: null,
    timestamp: new Date(3_000_000 + index * 1_000).toISOString(),
    sequence: index + 1,
  }));
}

async function seedTerminalSession(
  source: DurableObjectStub<ProjectDataTestDouble>,
  prefix: string,
  count: number
): Promise<{ sessionId: string; messageCount: number }> {
  const sessionId = await source.createSession(null, prefix);
  // Persist in slices: one 20000-row RPC argument exceeds the DO RPC size budget.
  const messages = messagesFor(prefix, count);
  for (let offset = 0; offset < messages.length; offset += 500) {
    await source.persistMessageBatch(sessionId, messages.slice(offset, offset + 500));
  }
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  const row = await env.DATABASE.prepare(
    'SELECT message_count FROM session_summaries WHERE id = ?'
  )
    .bind(sessionId)
    .first<{ message_count: number }>();
  if (!row) throw new Error(`No session_summaries row for ${prefix}`);
  return { sessionId, messageCount: row.message_count };
}

/**
 * Every input `selectMigrationWork` reads is global — candidate ranking, reclaimable
 * migrations and the single `'global'` write-budget row — so a leftover fixture from another
 * file competes for this tick's one session slot. Clearing them is fixture hygiene, not
 * hand-feeding: within the project the sweep still sees a mix and chooses for itself.
 */
async function isolateSweepFixture(projectId: string): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM session_summaries WHERE project_id != ?').bind(projectId),
    env.DATABASE.prepare('DELETE FROM project_data_archive_migrations WHERE project_id != ?').bind(
      projectId
    ),
    env.DATABASE.prepare('DELETE FROM project_data_session_locations WHERE project_id != ?').bind(
      projectId
    ),
    env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget'),
    env.DATABASE.prepare(
      `DELETE FROM project_data_archive_global_sweep_cadence
       WHERE sweep_name = 'archive_sharding_global_sweep'`
    ),
  ]);
}

/**
 * The shipped production shape, minus the two values under test. The grace period is the one
 * deliberate divergence: production holds sessions for 7 days and a test cannot wait.
 */
function sweepEnv(messageBudget: string, sweepSessions: string) {
  return {
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: sweepSessions,
    PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: messageBudget,
    PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '100',
    PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '2',
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '800000',
    PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '500',
  };
}

async function countTargetRawChunks(ownerName: string, sessionId: string): Promise<number> {
  const target = projectDataStub(ownerName);
  return runInDurableObject(target, async (_instance, state) =>
    Number(
      state.storage.sql
        .exec(
          'SELECT COUNT(*) AS n FROM project_data_archive_raw_chunks WHERE session_id = ?',
          sessionId
        )
        .toArray()[0]?.n ?? 0
    )
  );
}

describe('archive sweep message budget as a selection ceiling', () => {
  it('hides a 5k-20k band session at the previous 5000 budget and migrates it at the shipped budget', async () => {
    const projectId = `archive-throughput-${crypto.randomUUID()}`;
    await seedUser(OWNER);
    await seedInstallation(INSTALLATION, OWNER);
    await seedProject(projectId, OWNER, INSTALLATION, { name: `Archive Throughput ${projectId}` });
    const source = projectDataStub(projectId);
    await source.ensureProjectId(projectId);

    const band = await seedTerminalSession(source, 'band', BAND_MESSAGE_COUNT);
    const small = await seedTerminalSession(source, 'small', SMALL_MESSAGE_COUNT);
    await isolateSweepFixture(projectId);

    // Fixture preconditions. Without these the pair could stop discriminating — if the band
    // session ever fell under the previous budget, the first tick would migrate it and the
    // second case would prove nothing.
    expect(band.messageCount).toBeGreaterThan(Number(PREVIOUS_SWEEP_MESSAGE_BUDGET));
    expect(band.messageCount).toBe(BAND_MESSAGE_COUNT);
    expect(small.messageCount).toBe(SMALL_MESSAGE_COUNT);

    // --- Tick 1: the previous budget. The band session is excluded by the SQL ceiling. ---
    await withArchiveEnv(sweepEnv(PREVIOUS_SWEEP_MESSAGE_BUDGET, '8'), async () => {
      const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000));

      expect(stats).toMatchObject({ skipped: false, failed: 0 });
      expect(stats.messageCeiling).toBe(Number(PREVIOUS_SWEEP_MESSAGE_BUDGET));
      // Absence: the band session did not move and is still readable in root.
      expect(await readLocation(projectId, band.sessionId)).toBeNull();
      expect(await source.getMessageCount(band.sessionId)).toBe(BAND_MESSAGE_COUNT);
      // Liveness beside it (`.claude/rules/62`): the tick was not merely dead. It selected,
      // reserved and published the one candidate the ceiling did admit.
      expect(stats.migrated).toBe(1);
      expect(await readLocation(projectId, small.sessionId)).toMatchObject({
        location_state: 'archive_shard',
      });
      // The exclusion is the SELECTOR, not the write budget: the band session never reached
      // `reserveArchiveWrites`, so no refusal was recorded for it.
      expect(stats.budgetUnaffordable).toBe(0);
      expect(stats.budgetWindowExhausted).toBe(0);
    });

    // --- Tick 2: the shipped budget, same fixture. Only the budget changed. ---
    const shippedBudget = shippedVar('PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET');
    // The shipped budget must actually admit the band, or this half proves nothing.
    expect(Number(shippedBudget)).toBeGreaterThanOrEqual(BAND_MESSAGE_COUNT);

    await withArchiveEnv(
      sweepEnv(shippedBudget, shippedVar('PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS')),
      async () => {
      const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 120_000));

      expect(stats).toMatchObject({ skipped: false, migrated: 1, failed: 0, refused: 0 });
      expect(stats.messageCeiling).toBe(Number(shippedBudget));

      const location = await readLocation(projectId, band.sessionId);
      expect(location).toMatchObject({ location_state: 'archive_shard' });
      // Published means the whole state machine ran: intent, chunk copy, seal, recovery
      // manifest, source deletion proof, publish. An aggregate hash only exists after seal.
      expect(location?.target_aggregate_sha256).toMatch(/^[0-9a-f]{64}$/);
      // The source object actually gave the bytes back — the point of the whole sweep.
      expect(await source.getMessageCount(band.sessionId)).toBe(0);
      // Chunked rather than moved in one oversized RPC: 20000 rows at CHUNK_ROWS=500.
      expect(
        await countTargetRawChunks(location?.owner_name ?? '', band.sessionId)
      ).toBeGreaterThanOrEqual(BAND_MESSAGE_COUNT / 500);
      }
    );
    // The small session from tick 1 is still archived — tick 2 did not disturb it.
    expect(await readLocation(projectId, small.sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });
  }, 180_000);
});
