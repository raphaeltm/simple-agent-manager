/**
 * `reclaim_pending`: D1's record of which flipped sessions may still have root rows.
 *
 * Every tick first finishes reclaims an earlier tick left unfinished. Before migration 0237 it
 * found them by waking the root object of every recently published project (two RPCs each, up
 * to 50 projects) on every tick. On staging (2026-11-13) 21 such projects made a 3 s tick take
 * 20 s and archive nothing, because the candidate batch then started out of time.
 *
 * These cases drive the real scheduled sweep against real DO SQLite, D1 and R2:
 * - clean published projects are never woken, even when listing them would be slow;
 * - a flag left by an older coordinator (or the migration's default) is cleared by one listing;
 * - a real leftover is still found and reclaimed, including after a flip whose journal is behind;
 * - a row flipped after the listing's D1 snapshot is never cleared by that listing.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import {
  projectDataStub,
  readLocation,
  seedMessages,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const CLEAN_PROJECTS = 12;

function sweepEnv(overrides: Record<string, string> = {}) {
  return {
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '20',
    PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '50',
    PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '60000',
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '2400000',
    PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '7',
    ...overrides,
  };
}

/** One scheduled tick at a distinct `now`, so the 1 ms cadence is always due. */
let tickClock = Date.now() + 60_000;
function tick(overrides: Record<string, string> = {}) {
  tickClock += 10_000;
  const at = new Date(tickClock);
  return withArchiveEnv(sweepEnv(overrides), () => runProjectDataArchiveSharding(testEnv, at));
}

type Seeded = {
  projectId: string;
  sessionId: string;
  source: DurableObjectStub<ProjectDataTestDouble>;
};

/** A stopped session in its own project. Does not isolate: callers isolate the whole set. */
async function seedSession(prefix: string, messages = 5): Promise<Seeded> {
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
  await source.persistMessageBatch(
    sessionId,
    seedMessages(messages).map((message) => ({
      ...message,
      messageId: `${prefix}-${suffix}-${message.messageId}`,
    }))
  );
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  return { projectId, sessionId, source };
}

/** Leave only these projects' rows visible to the sweep, with a fresh budget and cadence. */
async function isolateProjects(projectIds: string[]): Promise<void> {
  const marks = projectIds.map(() => '?').join(', ');
  await env.DATABASE.batch([
    env.DATABASE.prepare(`DELETE FROM session_summaries WHERE project_id NOT IN (${marks})`).bind(
      ...projectIds
    ),
    env.DATABASE.prepare(
      `DELETE FROM project_data_archive_migrations WHERE project_id NOT IN (${marks})`
    ).bind(...projectIds),
    env.DATABASE.prepare(
      `DELETE FROM project_data_session_locations WHERE project_id NOT IN (${marks})`
    ).bind(...projectIds),
    env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget'),
    env.DATABASE.prepare(
      `DELETE FROM project_data_archive_global_sweep_cadence
       WHERE sweep_name = 'archive_sharding_global_sweep'`
    ),
  ]);
}

type JournalRow = { migration_id: string; state: string; reclaim_pending: number };

async function readJournal(projectId: string, sessionId: string): Promise<JournalRow | null> {
  return env.DATABASE.prepare(
    `SELECT migration_id, state, reclaim_pending FROM project_data_archive_migrations
     WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(projectId, sessionId)
    .first<JournalRow>();
}

async function rootMessageCount(
  source: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string
): Promise<number> {
  return runInDurableObject(source, async (_instance, state) =>
    Number(
      state.storage.sql
        .exec('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?', sessionId)
        .toArray()[0]?.n ?? 0
    )
  );
}

/** Ticks until every given session is published. */
async function archiveAll(sessions: Seeded[]): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const states = await Promise.all(sessions.map((s) => readJournal(s.projectId, s.sessionId)));
    if (states.every((row) => row?.state === 'published')) return;
    const stats = await tick();
    expect(stats.failed).toBe(0);
  }
  throw new Error('sessions did not all publish');
}

describe('reclaim_pending flag', () => {
  it('wakes no clean root object, so slow clean projects cannot starve the candidate batch', async () => {
    const clean: Seeded[] = [];
    for (let index = 0; index < CLEAN_PROJECTS; index++) {
      clean.push(await seedSession(`clean${index}`));
    }
    await isolateProjects(clean.map((s) => s.projectId));
    await archiveAll(clean);
    // Each flip's own reclaim completed, so D1 records nothing pending.
    for (const s of clean) {
      expect(await readJournal(s.projectId, s.sessionId)).toMatchObject({
        state: 'published',
        reclaim_pending: 0,
      });
      expect(await rootMessageCount(s.source, s.sessionId)).toBe(0);
    }

    const candidate = await seedSession('afterclean');
    await isolateProjects([...clean.map((s) => s.projectId), candidate.projectId]);
    // A cold root object in another region: on staging each listing cost hundreds of ms.
    const before: number[] = [];
    for (const s of clean) {
      await s.source.setReclaimListingDelayForTest(150);
      before.push(await s.source.reclaimListingCountForTest());
    }

    const stats = await tick({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '600' });

    // Listing all twelve would take 1.8 s against a 0.6 s wall and leave no time to migrate.
    expect(stats).toMatchObject({ migrated: 1, failed: 0 });
    expect((await readJournal(candidate.projectId, candidate.sessionId))?.state).toBe('published');
    for (const [index, s] of clean.entries()) {
      expect(await s.source.reclaimListingCountForTest()).toBe(before[index]);
      await s.source.setReclaimListingDelayForTest(0);
    }
  });

  it('lists a project with a flag an older coordinator left once, clears it, and never again', async () => {
    const seeded = await seedSession('oldflag');
    await isolateProjects([seeded.projectId]);
    await archiveAll([seeded]);
    const journal = await readJournal(seeded.projectId, seeded.sessionId);
    expect(journal).toMatchObject({ reclaim_pending: 0 });
    // What migration 0237's default leaves on every pre-existing row, and what a coordinator
    // from before the column writes during a deploy.
    await env.DATABASE.prepare(
      'UPDATE project_data_archive_migrations SET reclaim_pending = 1 WHERE migration_id = ?'
    )
      .bind(journal!.migration_id)
      .run();

    const listings = await seeded.source.reclaimListingCountForTest();
    await tick();
    expect(await seeded.source.reclaimListingCountForTest()).toBe(listings + 1);
    expect(await readJournal(seeded.projectId, seeded.sessionId)).toMatchObject({
      reclaim_pending: 0,
    });

    await tick();
    expect(await seeded.source.reclaimListingCountForTest()).toBe(listings + 1);
  });

  it('keeps the flag while root rows remain and clears it once the next tick reclaims them', async () => {
    const seeded = await seedSession('leftover', 40);
    await isolateProjects([seeded.projectId]);
    await seeded.source.failNextArchiveReclaimPagesForTest(1);
    const first = await tick();
    expect(first).toMatchObject({ migrated: 1, failed: 0 });
    expect(await rootMessageCount(seeded.source, seeded.sessionId)).toBe(40);
    expect(await readJournal(seeded.projectId, seeded.sessionId)).toMatchObject({
      state: 'published',
      reclaim_pending: 1,
    });

    const second = await tick();
    expect(second.reclaimedRows ?? 0).toBeGreaterThanOrEqual(40);
    expect(await rootMessageCount(seeded.source, seeded.sessionId)).toBe(0);
    expect(await readJournal(seeded.projectId, seeded.sessionId)).toMatchObject({
      reclaim_pending: 0,
    });
  });

  it('reclaims rows behind a flip whose journal never reached source_deleted', async () => {
    const seeded = await seedSession('crashgap', 40);
    await isolateProjects([seeded.projectId]);
    await seeded.source.failNextArchiveReclaimPagesForTest(1);
    await tick();
    expect(await rootMessageCount(seeded.source, seeded.sessionId)).toBe(40);
    const journal = await readJournal(seeded.projectId, seeded.sessionId);
    // The crash gap: the root committed its flip (intent, marker) but the coordinator died
    // before the journal CAS, so D1 still says the manifest was persisted and the location is
    // migrating. Nothing in D1 says a flip happened.
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE project_data_archive_migrations
         SET state = 'recovery_manifest_persisted', source_deleted_at = NULL, published_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, reclaim_pending = 1
         WHERE migration_id = ?`
      ).bind(journal!.migration_id),
      env.DATABASE.prepare(
        `UPDATE project_data_session_locations SET location_state = 'migrating', published_at = NULL
         WHERE project_id = ? AND session_id = ?`
      ).bind(seeded.projectId, seeded.sessionId),
    ]);

    for (let attempt = 0; attempt < 5; attempt++) {
      const stats = await tick();
      expect(stats.poisoned).toBe(0);
      if ((await rootMessageCount(seeded.source, seeded.sessionId)) === 0) break;
    }
    expect(await rootMessageCount(seeded.source, seeded.sessionId)).toBe(0);
    expect(await readJournal(seeded.projectId, seeded.sessionId)).toMatchObject({
      state: 'published',
      reclaim_pending: 0,
    });
    expect((await readLocation(seeded.projectId, seeded.sessionId))?.location_state).toBe(
      'archive_shard'
    );
  });

  it('never clears a row flipped after the listing read its snapshot', async () => {
    const seeded = await seedSession('race');
    await isolateProjects([seeded.projectId]);
    await archiveAll([seeded]);
    const journal = await readJournal(seeded.projectId, seeded.sessionId);
    // Flag the clean row so the next tick lists this project.
    await env.DATABASE.prepare(
      'UPDATE project_data_archive_migrations SET reclaim_pending = 1 WHERE migration_id = ?'
    )
      .bind(journal!.migration_id)
      .run();
    const listings = await seeded.source.reclaimListingCountForTest();
    await seeded.source.setReclaimListingDelayForTest(1_500);

    const running = tick();
    // Hold the tick inside the listing: the D1 snapshot has been read, the root not yet answered.
    for (let wait = 0; wait < 100; wait++) {
      if ((await seeded.source.reclaimListingCountForTest()) > listings) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await seeded.source.reclaimListingCountForTest()).toBe(listings + 1);
    // A concurrent canary publishes another session of this project now. Its journal times are
    // its claim's START, well before this listing, and this listing cannot see its marker.
    const raceMigrationId = `race-${crypto.randomUUID()}`;
    const claimStartedAt = tickClock - 60_000;
    await env.DATABASE.prepare(
      `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
          target_generation, source_deleted_at, published_at, created_at, updated_at,
          reclaim_pending)
       VALUES (?, ?, ?, 'published', ?, ?, 1, ?, ?, ?, ?, 1)`
    )
      .bind(
        raceMigrationId,
        seeded.projectId,
        `race-session-${crypto.randomUUID()}`,
        seeded.projectId,
        `${seeded.projectId}:archive:race`,
        claimStartedAt,
        claimStartedAt,
        claimStartedAt,
        claimStartedAt
      )
      .run();
    await running;
    await seeded.source.setReclaimListingDelayForTest(0);

    // The snapshotted clean row is cleared; the row the snapshot never saw keeps its flag.
    expect(await readJournal(seeded.projectId, seeded.sessionId)).toMatchObject({
      reclaim_pending: 0,
    });
    const race = await env.DATABASE.prepare(
      'SELECT reclaim_pending FROM project_data_archive_migrations WHERE migration_id = ?'
    )
      .bind(raceMigrationId)
      .first<{ reclaim_pending: number }>();
    expect(race?.reclaim_pending).toBe(1);
  });
});
