/**
 * One resumable archive path for every session size.
 *
 * A migration is a cursor: journal phase + D1 copy checkpoints + target receipts + the shard's
 * paged R2 verification progress + the root rows left to reclaim. These cases drive the real
 * scheduled sweep against real DO SQLite, D1 and R2, and make a tick end mid-migration with a
 * short `PROJECT_DATA_ARCHIVE_WALL_TIME_MS` on a session far larger than one tick can copy.
 *
 * What must hold across ticks:
 * - the transcript stays readable (from the root until the flip, from the shard after it);
 * - writes stay fenced until the migration publishes or unwinds;
 * - a resumed tick neither re-reserves the write budget nor re-puts an R2 chunk;
 * - a claim that advanced resets the no-progress poison count; one that cannot advance poisons
 *   after `PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS` claims;
 * - a late write or marker found at the flip unwinds to the root, never poison or breaker.
 */
import type { MessagePosition } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import {
  isolateSweepFixture,
  projectDataStub,
  readLocation,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv & Record<string, unknown>;

/** Large enough that a short tick cannot copy it: ~86 chunks of 7 rows. */
const LARGE_MESSAGES = 600;

function sweepEnv(overrides: Record<string, string> = {}) {
  return {
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '5',
    PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '50',
    PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '60000',
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '2400000',
    PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '2',
    PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS: '0',
    // The production value: proves the selection ceiling no longer applies it.
    PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '10000',
    PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '7',
    ...overrides,
  };
}

function messagesFor(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `${prefix}-${String(index).padStart(5, '0')}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `cursorprobe ${prefix} turn ${index} ${'x'.repeat(index % 97)}`,
    toolMetadata: null,
    timestamp: new Date(1_000_000 + index * 1_000).toISOString(),
    sequence: index + 1,
  }));
}

async function seedCandidate(
  prefix: string,
  count: number
): Promise<{
  projectId: string;
  sessionId: string;
  messageIds: string[];
  source: DurableObjectStub<ProjectDataTestDouble>;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `${prefix}-user-${suffix}`;
  const installationId = `${prefix}-install-${suffix}`;
  const projectId = `${prefix}-project-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId, { name: `${prefix} ${suffix}` });
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  const sessionId = await source.createSession(null, prefix);
  const messages = messagesFor(prefix, count);
  for (let offset = 0; offset < messages.length; offset += 250) {
    await source.persistMessageBatch(sessionId, messages.slice(offset, offset + 250));
  }
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  await isolateSweepFixture(projectId, { clearCadence: true });
  return { projectId, sessionId, messageIds: messages.map((m) => m.messageId), source };
}

type JournalRow = {
  migration_id: string;
  state: string;
  attempt_count: number;
  lease_owner: string | null;
  error_code: string | null;
  error_message: string | null;
};

async function readJournal(projectId: string, sessionId: string): Promise<JournalRow | null> {
  return env.DATABASE.prepare(
    `SELECT migration_id, state, attempt_count, lease_owner, error_code, error_message
     FROM project_data_archive_migrations
     WHERE project_id = ? AND session_id = ?
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(projectId, sessionId)
    .first<JournalRow>();
}

async function reservedWrites(): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT reserved_writes FROM project_data_archive_write_budget WHERE id = 'global'`
  ).first<{ reserved_writes: number }>();
  return row?.reserved_writes ?? 0;
}

async function readAllMessageIds(projectId: string, sessionId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: MessagePosition | null = null;
  // Bounded so a cursor that stops advancing fails the test instead of hanging the suite.
  for (let page = 0; page < 50; page++) {
    const result = await projectDataService.getMessages(
      testEnv,
      projectId,
      sessionId,
      200,
      null,
      after,
      undefined,
      false,
      'asc'
    );
    ids.push(...result.messages.map((row) => String(row.id)));
    const last = result.messages[result.messages.length - 1];
    if (!result.hasMore || !last) return ids;
    after = {
      createdAt: Number(last.createdAt),
      sequence: Number(last.sequence),
      id: String(last.id),
    };
  }
  throw new Error('transcript paging did not finish');
}

/** Counts R2 puts per key on the binding the coordinator writes chunks through. */
function countingR2(inner: R2Bucket, options: { failPuts?: () => boolean } = {}) {
  const puts = new Map<string, number>();
  const bucket = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'put') {
        return async (key: string, ...rest: unknown[]) => {
          if (options.failPuts?.()) throw new Error('injected R2 put failure');
          puts.set(key, (puts.get(key) ?? 0) + 1);
          return (target.put as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { bucket, puts };
}

async function withR2<T>(bucket: R2Bucket, fn: () => Promise<T>): Promise<T> {
  const previous = testEnv.PROJECT_DATA_ARCHIVE_R2;
  testEnv.PROJECT_DATA_ARCHIVE_R2 = bucket;
  try {
    return await fn();
  } finally {
    testEnv.PROJECT_DATA_ARCHIVE_R2 = previous;
  }
}

/** One scheduled tick at a distinct `now`, so the 1 ms cadence is always due. */
let tickClock = Date.now() + 60_000;
function tick(overrides: Record<string, string> = {}) {
  tickClock += 10_000;
  const at = new Date(tickClock);
  return withArchiveEnv(sweepEnv(overrides), () => runProjectDataArchiveSharding(testEnv, at));
}

describe('resumable archive cursor', () => {
  it('copies a large session across ticks, readable and write-fenced throughout, with one reservation and no duplicate puts', async () => {
    const { projectId, sessionId, messageIds } = await seedCandidate('cursor', LARGE_MESSAGES);
    const { bucket, puts } = countingR2(env.PROJECT_DATA_ARCHIVE_R2 as R2Bucket);

    let ticks = 0;
    let yields = 0;
    let reservationAfterFirstTick: number | null = null;
    await withR2(bucket, async () => {
      for (; ticks < 60;) {
        const stats = await tick({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '150' });
        ticks++;
        expect(stats.failed).toBe(0);
        expect(stats.poisoned).toBe(0);
        yields += stats.yielded ?? 0;
        if (reservationAfterFirstTick === null && (await readJournal(projectId, sessionId))) {
          reservationAfterFirstTick = await reservedWrites();
        }
        const journal = await readJournal(projectId, sessionId);
        if (journal?.state === 'published') break;
        if (!journal) continue;
        // Between ticks the lease is released, and a claim that moved the migration resets
        // the no-progress count.
        expect(journal.lease_owner).toBeNull();
        expect(journal.attempt_count).toBe(0);
        // Readable from the root while it migrates: the whole transcript, in order.
        await withArchiveEnv(sweepEnv(), async () => {
          expect((await readLocation(projectId, sessionId))?.location_state).toBe('migrating');
          expect(await readAllMessageIds(projectId, sessionId)).toEqual(messageIds);
          await expect(
            projectDataService.persistMessage(
              testEnv,
              projectId,
              sessionId,
              'user',
              'late write',
              null
            )
          ).rejects.toThrow(/fenced/);
        });
      }
    });

    expect((await readJournal(projectId, sessionId))?.state).toBe('published');
    // More than one tick, and at least one pause at the deadline.
    expect(ticks).toBeGreaterThan(1);
    expect(yields).toBeGreaterThan(0);
    // The estimate was reserved once, when the journal was created; resumed ticks added none.
    expect(reservationAfterFirstTick).not.toBeNull();
    expect(await reservedWrites()).toBe(reservationAfterFirstTick);
    // Every immutable chunk object was written exactly once.
    expect(puts.size).toBeGreaterThan(1);
    expect([...puts.values()].every((count) => count === 1)).toBe(true);
    await withArchiveEnv(sweepEnv(), async () => {
      expect((await readLocation(projectId, sessionId))?.location_state).toBe('archive_shard');
      expect(await readAllMessageIds(projectId, sessionId)).toEqual(messageIds);
    });
  });

  it('resumes after a transient R2 failure without re-putting a chunk, and resets the poison count on progress', async () => {
    const { projectId, sessionId, messageIds } = await seedCandidate('transient', 120);
    let putCalls = 0;
    const { bucket, puts } = countingR2(env.PROJECT_DATA_ARCHIVE_R2 as R2Bucket, {
      // Puts 4 and 9 fail once each, each after earlier chunks of the same claim committed.
      failPuts: () => {
        putCalls++;
        return putCalls === 4 || putCalls === 9;
      },
    });
    await withR2(bucket, async () => {
      const first = await tick();
      expect(first).toMatchObject({ failed: 1, poisoned: 0 });
      const failed = await readJournal(projectId, sessionId);
      // The claim advanced before it failed, so it did not spend a poison attempt.
      expect(failed).toMatchObject({ state: 'failed', attempt_count: 0 });

      // Even at the poison threshold, a claim that advances before failing is not poisoned.
      await env.DATABASE.prepare(
        'UPDATE project_data_archive_migrations SET attempt_count = 2 WHERE migration_id = ?'
      )
        .bind(failed!.migration_id)
        .run();
      const second = await tick();
      expect(second).toMatchObject({ failed: 1, poisoned: 0 });
      expect(await readJournal(projectId, sessionId)).toMatchObject({
        state: 'failed',
        attempt_count: 0,
      });

      const third = await tick();
      expect(third).toMatchObject({ migrated: 1, failed: 0 });
    });
    expect((await readJournal(projectId, sessionId))?.state).toBe('published');
    expect([...puts.values()].every((count) => count === 1)).toBe(true);
    await withArchiveEnv(sweepEnv(), async () => {
      expect(await readAllMessageIds(projectId, sessionId)).toEqual(messageIds);
    });
  });

  it('poisons a migration that cannot advance after the configured number of claims', async () => {
    const { projectId, sessionId, source } = await seedCandidate('permanent', 30);
    const { bucket } = countingR2(env.PROJECT_DATA_ARCHIVE_R2 as R2Bucket, {
      failPuts: () => true,
    });
    const states: string[] = [];
    await withR2(bucket, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await tick();
        states.push((await readJournal(projectId, sessionId))?.state ?? 'none');
      }
    });
    expect(states).toEqual(['failed', 'failed', 'poisoned']);
    // Nothing was flipped: the root still holds the whole session.
    const remaining = await runInDurableObject(source, async (_instance, state) =>
      Number(
        state.storage.sql
          .exec('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?', sessionId)
          .toArray()[0]?.n
      )
    );
    expect(remaining).toBe(30);
  });

  it('unwinds to the root when an attention marker appears mid-migration, without poison or breaker', async () => {
    const { projectId, sessionId, source } = await seedCandidate('latemarker', LARGE_MESSAGES);
    // First tick copies part of the session and pauses.
    const first = await tick({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '150' });
    expect(first.yielded ?? 0).toBe(1);
    // An alarm raises a marker on the fenced session (no transcript write involved).
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO session_attention_markers (id, session_id, kind, source, created_at)
         VALUES (?, ?, 'wake_failed', 'test', ?)`,
        crypto.randomUUID(),
        sessionId,
        // Fresh relative to the tick clock the sweep runs on (ahead of wall time).
        tickClock + 86_400_000
      );
    });
    let unwound = 0;
    for (let ticks = 0; ticks < 60; ticks++) {
      const stats = await tick();
      expect(stats.poisoned).toBe(0);
      unwound += stats.flipUnwound ?? 0;
      const journal = await readJournal(projectId, sessionId);
      if (journal?.state === 'frozen') break;
    }
    expect(unwound).toBe(1);
    const journal = await readJournal(projectId, sessionId);
    expect(journal).toMatchObject({ state: 'frozen', error_code: 'precopy_refused' });
    expect((await readLocation(projectId, sessionId))?.location_state).toBe('root');
    const breaker = await env.DATABASE.prepare(
      'SELECT state FROM project_data_archive_circuit_breakers WHERE project_id = ?'
    )
      .bind(projectId)
      .first<{ state: string }>();
    expect(breaker?.state ?? 'closed').toBe('closed');
    // The source intent is gone, so the session accepts writes again.
    await withArchiveEnv(sweepEnv(), async () => {
      await projectDataService.persistMessage(
        testEnv,
        projectId,
        sessionId,
        'user',
        'after unwind',
        null
      );
    });
  });

  it('unwinds when a transcript row changes under the fence before the flip', async () => {
    const { projectId, sessionId, source } = await seedCandidate('lateedit', LARGE_MESSAGES);
    const first = await tick({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '150' });
    expect(first.yielded ?? 0).toBe(1);
    // A writer that bypasses the fence (the class of bug the flip recompute exists to catch).
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE chat_messages SET content = content || ' edited'
         WHERE session_id = ? AND rowid = (SELECT MAX(rowid) FROM chat_messages WHERE session_id = ?)`,
        sessionId,
        sessionId
      );
    });
    let unwound = 0;
    for (let ticks = 0; ticks < 60; ticks++) {
      const stats = await tick();
      expect(stats.poisoned).toBe(0);
      unwound += stats.flipUnwound ?? 0;
      if ((await readJournal(projectId, sessionId))?.state === 'frozen') break;
    }
    expect(unwound).toBe(1);
    expect((await readLocation(projectId, sessionId))?.location_state).toBe('root');
    await withArchiveEnv(sweepEnv(), async () => {
      const ids = await readAllMessageIds(projectId, sessionId);
      expect(ids).toHaveLength(LARGE_MESSAGES);
    });
  });

  it('refuses to flip when an R2 chunk no longer matches what the root exported', async () => {
    const { projectId, sessionId, source } = await seedCandidate('corrupt', 40);
    const r2 = env.PROJECT_DATA_ARCHIVE_R2 as R2Bucket;
    // Lose the first raw chunk once the copy is sealed: the commit already verified it, so only
    // the pre-flip re-read can notice. The recovery manifest is the last write before that read.
    let corrupted = false;
    const corrupting = new Proxy(r2, {
      get(target, property, receiver) {
        if (property === 'put') {
          return async (key: string, ...rest: unknown[]) => {
            const result = await (target.put as (...args: unknown[]) => Promise<unknown>)(
              key,
              ...rest
            );
            if (!corrupted && key.endsWith('/manifest.json')) {
              corrupted = true;
              const listed = await r2.list({ prefix: key.replace(/manifest\.json$/, 'raw/') });
              const first = listed.objects.find((object) => object.key.endsWith('/raw/0.json.gz'));
              if (first) await r2.delete(first.key);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stats = await withR2(corrupting as R2Bucket, () => tick());
    expect(corrupted).toBe(true);
    expect(stats).toMatchObject({ migrated: 0, failed: 1 });
    const journal = await readJournal(projectId, sessionId);
    expect(journal?.state).toBe('failed');
    expect(journal?.error_message).toMatch(/failed R2 verification/);
    // The flip never happened: root intent is not flipped and every row is still there.
    const root = await runInDurableObject(source, async (_instance, state) => ({
      rows: Number(
        state.storage.sql
          .exec('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?', sessionId)
          .toArray()[0]?.n
      ),
      intent: state.storage.sql
        .exec(
          'SELECT state FROM project_data_archive_source_intents WHERE session_id = ?',
          sessionId
        )
        .toArray()[0]?.state,
    }));
    expect(root.rows).toBe(40);
    expect(root.intent).not.toBe('source_deleted');
  });

  it('renews the lease during a tick longer than the lease', async () => {
    const { projectId, sessionId } = await seedCandidate('renew', LARGE_MESSAGES);
    // A lease far shorter than the tick: without renewal the fence is lost mid-copy and the
    // claim fails with lease_fence_lost. Long enough to survive the tick's setup before the claim.
    // At wall-clock time, because the lease is claimed from the tick's `now`.
    const stats = await withArchiveEnv(
      sweepEnv({ PROJECT_DATA_ARCHIVE_LEASE_MS: '400', PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '2000' }),
      () => runProjectDataArchiveSharding(testEnv, new Date())
    );
    const journal = await readJournal(projectId, sessionId);
    expect(journal?.error_message ?? null).toBeNull();
    expect(stats.failed).toBe(0);
    expect(['copying', 'target_sealed', 'recovery_manifest_persisted', 'published']).toContain(
      journal?.state
    );
  });

  it('stops reclaim at the tick deadline, flags a stuck reclaim, then frees the bytes', async () => {
    const pageRows = 7;
    const { sessionId, source } = await seedCandidate('reclaimdeadline', 40);
    const rootRows = () =>
      runInDurableObject(source, async (_instance, state) =>
        Number(
          state.storage.sql
            .exec('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?', sessionId)
            .toArray()[0]?.n
        )
      );
    // Tick 1 flips and publishes, and its post-flip reclaim fails: every row is left over.
    await source.failNextArchiveReclaimPagesForTest(1);
    const first = await tick();
    expect(first).toMatchObject({ migrated: 1, reclaimPending: 1 });
    expect(await rootRows()).toBe(40);
    // The flip happened long ago, so the leftover is past the stuck threshold.
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_data_archive_source_intents SET source_deleted_at = ? WHERE session_id = ?`,
        Date.now() - 86_400_000,
        sessionId
      );
    });

    // A 1 ms tick: the pending pass is past its deadline before or right after one page.
    const second = await tick({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '1' });
    expect(second.reclaimPending).toBe(1);
    expect(second.reclaimStuck).toBe(1);
    expect(40 - (await rootRows())).toBeLessThanOrEqual(pageRows);

    const third = await tick();
    expect(third.reclaimPending ?? 0).toBe(0);
    expect(third.reclaimStuck ?? 0).toBe(0);
    expect(await rootRows()).toBe(0);
    // workerd's databaseSize subtracts the freelist, so deleted pages show up as freed bytes.
    expect(third.reclaimedBytes ?? 0).toBeGreaterThan(0);
  });
});
