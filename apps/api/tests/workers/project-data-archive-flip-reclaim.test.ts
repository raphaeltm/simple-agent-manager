/**
 * Archive flip, then paged reclaim.
 *
 * The flip (`finalizeSourceDelete`) commits the routing anchors and the `source_deleted` intent
 * without deleting transcript rows; `reclaimArchiveSourcePage` deletes them afterwards in bounded
 * pages. These cases drive the real scheduled sweep against real DO SQLite, D1 and R2, and
 * interrupt reclaim with a failure injected on the root object's reclaim RPC: the state a reset
 * or lost RPC leaves after the flip committed.
 *
 * While rows remain in the root, the conversation must read from the shard, search must return
 * each message once, comments must be refused, and copy-back must never lose restored rows to a
 * concurrent reclaim. The next tick must finish reclaim without copying anything again.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import {
  copyBackProjectDataArchiveMigration,
  runProjectDataArchiveSharding,
} from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import {
  isolateSweepFixture,
  projectDataStub,
  readLocation,
  seedMessages,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const MESSAGES = 40;

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
    // Small pages so reclaim takes several RPCs, as a large session does.
    PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '7',
    ...overrides,
  };
}

async function seedArchivedCandidate(prefix: string): Promise<{
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
  const messages = seedMessages(MESSAGES).map((message) => ({
    ...message,
    messageId: `${prefix}-${message.messageId}`,
    content: `reclaimprobe ${message.content}`,
  }));
  await source.persistMessageBatch(sessionId, messages);
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  await isolateSweepFixture(projectId, { clearCadence: true });
  return { projectId, sessionId, messageIds: messages.map((m) => m.messageId), source };
}

async function rootRowCounts(
  source: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string
): Promise<{ messages: number; grouped: number; tools: number }> {
  return runInDurableObject(source, async (_instance, state) => {
    const count = (table: string) =>
      Number(
        state.storage.sql
          .exec(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, sessionId)
          .toArray()[0]?.n ?? 0
      );
    return {
      messages: count('chat_messages'),
      grouped: count('chat_messages_grouped'),
      tools: count('tool_payload_archives'),
    };
  });
}

async function publishedMigrationId(projectId: string, sessionId: string): Promise<string> {
  const row = await env.DATABASE.prepare(
    `SELECT migration_id FROM project_data_archive_migrations
     WHERE project_id = ? AND session_id = ? AND state = 'published'`
  )
    .bind(projectId, sessionId)
    .first<{ migration_id: string }>();
  if (!row) throw new Error('no published migration');
  return row.migration_id;
}

describe('archive flip then paged reclaim', () => {
  it('serves the shard while root rows remain, and the next tick reclaims them without re-copying', async () => {
    const { projectId, sessionId, messageIds, source } = await seedArchivedCandidate('reclaim');
    // Every reclaim attempt in tick 1 fails: the flip commits, nothing is reclaimed.
    await source.failNextArchiveReclaimPagesForTest(1);

    const first = await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000))
    );
    expect(first).toMatchObject({ migrated: 1, failed: 0, reclaimPending: 1 });
    expect(await readLocation(projectId, sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);

    await withArchiveEnv(sweepEnv(), async () => {
      // Reads route to the shard: the full transcript, in order.
      const page = await projectDataService.getMessages(testEnv, projectId, sessionId, 100);
      expect(page.messages.map((row) => String(row.id))).toEqual(messageIds);
      // The root still indexes the leftovers, so the project-wide search below sees each message
      // from the root AND from the shard; the assertion is that it returns each one once.
      const rootHits = await runInDurableObject(source, async (_instance, state) =>
        Number(
          state.storage.sql
            .exec(
              `SELECT COUNT(*) AS n FROM chat_messages_grouped_fts f
               JOIN chat_messages_grouped g ON g.rowid = f.rowid
               WHERE chat_messages_grouped_fts MATCH 'reclaimprobe' AND g.session_id = ?`,
              sessionId
            )
            .toArray()[0]?.n ?? 0
        )
      );
      expect(rootHits).toBeGreaterThan(0);
      const { results } = await projectDataService.searchMessagesWithArchiveMetadata(
        testEnv,
        projectId,
        'reclaimprobe',
        null,
        null,
        100
      );
      const ids = results.filter((r) => r.sessionId === sessionId).map((r) => r.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    });
    // A comment on a leftover row would be cascade-deleted by reclaim, so it is refused.
    // Captured inside the DO: an exception escaping a DO method is reported by the workers pool
    // as an unhandled error even when the caller awaits the rejection.
    const comment = await source.createCommentThreadCapturedForTest({
      sessionId,
      messageId: messageIds[0]!,
      body: 'late comment',
      actor: { kind: 'agent', id: 'reclaim-test', name: 'Reclaim Test' },
    });
    expect(comment).toMatchObject({ threw: true });
    expect(comment.message).toMatch(/moved to a ProjectData archive shard/);

    const second = await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 120_000))
    );
    expect(second).toMatchObject({ migrated: 0, chunksCopied: 0, failed: 0 });
    expect(second.reclaimedRows ?? 0).toBeGreaterThanOrEqual(MESSAGES);
    expect(second.reclaimPending ?? 0).toBe(0);
    expect(await rootRowCounts(source, sessionId)).toEqual({ messages: 0, grouped: 0, tools: 0 });
    // Still readable after reclaim.
    await withArchiveEnv(sweepEnv(), async () => {
      const page = await projectDataService.getMessages(testEnv, projectId, sessionId, 100);
      expect(page.messages).toHaveLength(MESSAGES);
    });
  });

  it('control: an uninterrupted tick reclaims every page itself', async () => {
    const { sessionId, source } = await seedArchivedCandidate('reclaim-control');
    const stats = await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000))
    );
    expect(stats).toMatchObject({ migrated: 1, failed: 0 });
    expect(stats.reclaimPending ?? 0).toBe(0);
    expect(await rootRowCounts(source, sessionId)).toEqual({ messages: 0, grouped: 0, tools: 0 });
  });

  it('never reclaims rows a copy-back has restored but not yet marked', async () => {
    const { projectId, sessionId, source } = await seedArchivedCandidate('reclaim-copyback');
    await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000))
    );
    expect((await rootRowCounts(source, sessionId)).messages).toBe(0);
    const migrationId = await publishedMigrationId(projectId, sessionId);

    // Copy-back restores every row, then fails before marking the restore complete.
    await source.failNextCopyBackMarkForTest();
    await withArchiveEnv(sweepEnv(), async () => {
      await expect(
        copyBackProjectDataArchiveMigration(testEnv, {
          migrationId,
          projectId,
          reason: 'reclaim fence test',
        })
      ).rejects.toThrow(/injected copy-back mark failure/);
    });
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);

    // The fence itself: a reclaim page asked for directly refuses and deletes nothing.
    const direct = await source.archiveSourceReclaimPage({
      projectId,
      sessionId,
      migrationId,
      maxRows: 1_000,
    });
    expect(direct).toMatchObject({
      messagesDeleted: 0,
      groupedRowsDeleted: 0,
      toolArchiveRowsDeleted: 0,
      remaining: true,
      copyBackInProgress: true,
    });
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);

    // Reclaim finished before the copy-back started, so the root holds no reclaim marker and
    // the restored rows are not pending. Defence in depth for a marker under the fence (the
    // copy-back drains reclaim first, so it should not coexist with the fence): the listing names
    // the session as fenced, the pass skips it, and its D1 flag survives, because a complete
    // listing proves a session clean only by omitting it.
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO do_meta (key, value) VALUES (?, ?)',
        `archive_reclaim_pending:${sessionId}`,
        migrationId
      );
    });
    await env.DATABASE.prepare(
      'UPDATE project_data_archive_migrations SET reclaim_pending = 1 WHERE migration_id = ?'
    )
      .bind(migrationId)
      .run();
    const listings = await source.reclaimListingCountForTest();
    // A sweep in that window must leave the restored rows alone.
    const tick = await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 120_000))
    );
    expect(await source.reclaimListingCountForTest()).toBe(listings + 1);
    expect(tick.reclaimedRows ?? 0).toBe(0);
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
    const flag = await env.DATABASE.prepare(
      'SELECT reclaim_pending FROM project_data_archive_migrations WHERE migration_id = ?'
    )
      .bind(migrationId)
      .first<{ reclaim_pending: number }>();
    expect(flag?.reclaim_pending).toBe(1);

    // Retrying the copy-back completes it.
    await withArchiveEnv(sweepEnv(), () =>
      copyBackProjectDataArchiveMigration(testEnv, {
        migrationId,
        projectId,
        reason: 'reclaim fence test retry',
      })
    );
    expect(await readLocation(projectId, sessionId)).toMatchObject({ location_state: 'root' });
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
  });

  it('copy-back over leftover rows reclaims them first and leaves the search index intact', async () => {
    const { projectId, sessionId, source } = await seedArchivedCandidate('reclaim-copyback-left');
    await source.failNextArchiveReclaimPagesForTest(1);
    await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000))
    );
    const left = await rootRowCounts(source, sessionId);
    expect(left.messages).toBe(MESSAGES);
    expect(left.grouped).toBeGreaterThan(0);
    const migrationId = await publishedMigrationId(projectId, sessionId);

    await withArchiveEnv(sweepEnv(), () =>
      copyBackProjectDataArchiveMigration(testEnv, {
        migrationId,
        projectId,
        reason: 'copy-back over leftovers',
      })
    );

    expect(await readLocation(projectId, sessionId)).toMatchObject({ location_state: 'root' });
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
    // Re-indexing grouped rows the FTS already held would leave duplicate postings, which an
    // FTS5 integrity check reports as a malformed index.
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rank) VALUES('integrity-check', 1)"
      );
    });
  });

  it('leaves leftover rows alone while the project breaker is open', async () => {
    const { projectId, sessionId, source } = await seedArchivedCandidate('reclaim-breaker');
    await source.failNextArchiveReclaimPagesForTest(1);
    await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000))
    );
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
    // An operator opened the breaker, for example because the shard is suspect.
    await env.DATABASE.prepare(
      `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
       VALUES (?, 'open', 'suspect shard', ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET state = 'open'`
    )
      .bind(projectId, Date.now(), Date.now())
      .run();

    const tick = await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 120_000))
    );
    expect(tick.reclaimedRows ?? 0).toBe(0);
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
  });

  it('caps one reclaim page at 2,000 rows whatever the caller asks for', async () => {
    const { projectId, sessionId, source } = await seedArchivedCandidate('reclaim-cap');
    // Grow the session past one capped page before archiving it.
    const extra = seedMessages(2_100).map((message) => ({
      ...message,
      messageId: `cap-${message.messageId}`,
      timestamp: new Date(9_000_000 + message.sequence * 1_000).toISOString(),
      sequence: message.sequence + MESSAGES,
    }));
    await source.failNextArchiveReclaimPagesForTest(1);
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec("UPDATE chat_sessions SET status = 'active' WHERE id = ?", sessionId);
    });
    for (let offset = 0; offset < extra.length; offset += 250) {
      await source.persistMessageBatch(sessionId, extra.slice(offset, offset + 250));
    }
    await source.stopSession(sessionId);
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });
    await withArchiveEnv(sweepEnv({ PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '10000' }), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000))
    );
    const migrationId = await publishedMigrationId(projectId, sessionId);

    const page = await source.archiveSourceReclaimPage({
      projectId,
      sessionId,
      migrationId,
      maxRows: 1_000_000,
    });
    expect(page.messagesDeleted).toBe(2_000);
    expect(page.remaining).toBe(true);
  });

  it('refuses to reclaim a session whose flip has not committed', async () => {
    const { projectId, sessionId, source } = await seedArchivedCandidate('reclaim-early');
    const refused = await source.archiveSourceReclaimPageCapturedForTest({
      projectId,
      sessionId,
      migrationId: 'not-a-migration',
      maxRows: 10,
    });
    expect(refused).toMatchObject({ threw: true });
    expect(refused.message).toMatch(/only after this migration flipped the session/);
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
  });
});
