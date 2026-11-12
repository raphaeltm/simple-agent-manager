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
      // Project-wide search sees the root leftovers AND the shard copy; each message once.
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
    await expect(
      source.createCommentThread({
        sessionId,
        messageId: messageIds[0]!,
        body: 'late comment',
        actor: { kind: 'agent', id: 'reclaim-test', name: 'Reclaim Test' },
      })
    ).rejects.toThrow(/moved to a ProjectData archive shard/);

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

    // A sweep in that window must leave the restored rows alone.
    const tick = await withArchiveEnv(sweepEnv(), () =>
      runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 120_000))
    );
    expect(tick.reclaimedRows ?? 0).toBe(0);
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);

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

  it('refuses to reclaim a session whose flip has not committed', async () => {
    const { projectId, sessionId, source } = await seedArchivedCandidate('reclaim-early');
    await expect(
      source.archiveSourceReclaimPage({
        projectId,
        sessionId,
        migrationId: 'not-a-migration',
        maxRows: 10,
      })
    ).rejects.toThrow(/only after this migration flipped the session/);
    expect((await rootRowCounts(source, sessionId)).messages).toBe(MESSAGES);
  });
});
