import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  type ArchiveSourceExportChunkInput,
  archiveSourceReadMessages,
  archiveTargetSearchProjectMessages,
  commitArchiveTargetChunk,
  computeTerminalVersion,
  exportArchiveChunk,
  finalizeSourceDelete,
  markSourceRecoveryManifestPersisted,
  markSourceTargetSealed,
  prepareArchiveSourceIntent,
  prepareArchiveTarget,
  sealArchiveTarget,
} from '../../../src/durable-objects/project-data/archive-sharding';
import {
  persistMessage,
  PROJECT_DATA_TRANSCRIPT_WRITE_FENCED,
} from '../../../src/durable-objects/project-data/messages';
import {
  PROJECT_DATA_ARCHIVE_SURFACE_INVENTORY,
  PROJECT_DATA_ARCHIVE_TABLES,
  type ProjectDataArchiveSurface,
} from '../../../src/project-data-archive/contract';
import { createSqlStorage } from './sql-storage-test-utils';

const NOW = 2_000_000;

function makeSql(): { db: Database.Database; sql: SqlStorage } {
  const db = new Database(':memory:');
  const sql = createSqlStorage(db);
  Object.defineProperty(sql, 'databaseSize', {
    get: () => 123_456,
  });
  runMigrations(sql);
  return { db, sql };
}

function seedTerminalSession(sql: SqlStorage, sessionId = 'session-archive'): void {
  const firstMessageId = `${sessionId}-message-1`;
  const secondMessageId = `${sessionId}-message-2`;
  sql.exec(
    `INSERT INTO chat_sessions
       (id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
        started_at, ended_at, created_at, updated_at, agent_completed_at, materialized_at)
     VALUES (?, ?, ?, ?, ?, 'stopped', 2, 1000, 1500, 1000, 1500, 1500, 1500)`,
    sessionId,
    'workspace-old',
    'task-old',
    'user-old',
    'terminal topic'
  );
  for (const message of [
    { id: firstMessageId, role: 'user', content: 'hello archive', createdAt: 1100, sequence: 1 },
    {
      id: secondMessageId,
      role: 'assistant',
      content: 'archived reply',
      createdAt: 1200,
      sequence: 2,
    },
  ]) {
    sql.exec(
      `INSERT INTO chat_messages
         (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      message.id,
      sessionId,
      message.role,
      message.content,
      null,
      message.createdAt,
      message.sequence
    );
  }
  sql.exec(
    `INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
     VALUES (?, ?, 'user', 'hello archive', 1100)`,
    `${sessionId}-group-1`,
    sessionId
  );
  sql.exec(
    `INSERT INTO tool_payload_archives
       (message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
        archived_at, message_created_at, message_sequence, archive_version)
     VALUES (?, ?, 'r2/tool/message-2', 10, 20, 1300, 1200, 2, 1)`,
    secondMessageId,
    sessionId
  );
}

/**
 * Seed a terminal session whose transcript spans several bind sub-batches.
 *
 * NOTE: this suite runs on better-sqlite3, whose bound-parameter ceiling is far
 * above Cloudflare's 100. It therefore CANNOT reproduce the production
 * `too many SQL variables` failure at any fixture size — that regression lives in
 * tests/workers/project-data-archive-sharding.test.ts against real workerd SQLite.
 * What these cases do cover is engine-independent: the sub-batch arithmetic, the
 * completeness total across batches, and the row-order guard.
 */
function seedWideTerminalSession(sql: SqlStorage, sessionId: string, messageCount: number): void {
  sql.exec(
    `INSERT INTO chat_sessions
       (id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
        started_at, ended_at, created_at, updated_at, agent_completed_at, materialized_at)
     VALUES (?, ?, ?, ?, ?, 'stopped', ?, 1000, 1500, 1000, 1500, 1500, 1500)`,
    sessionId,
    'workspace-wide',
    'task-wide',
    'user-wide',
    'wide terminal topic',
    messageCount
  );
  for (let index = 0; index < messageCount; index++) {
    sql.exec(
      `INSERT INTO chat_messages
         (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
      `${sessionId}-message-${String(index).padStart(4, '0')}`,
      sessionId,
      index % 2 === 0 ? 'user' : 'assistant',
      `wide payload ${index}`,
      1100 + index,
      index + 1
    );
  }
}

async function exportWideChatMessagesChunk(sql: SqlStorage, sessionId: string, maxRows: number) {
  return exportArchiveChunk(sql, {
    projectId: 'project-archive',
    sessionId,
    migrationId: 'migration-wide',
    sourceOwnerName: 'project-archive',
    targetOwnerName: 'project-archive:archive:g1:s1',
    targetGeneration: 1,
    sourceIntentToken: 'intent-wide',
    tableName: 'chat_messages',
    ordinal: 0,
    cursor: null,
    maxRows,
    maxBytes: 1024 * 1024,
  });
}

/** Drives the real prepare-intent -> prepare-target handshake, as the coordinator does. */
async function prepareWideTarget(
  source: SqlStorage,
  target: SqlStorage,
  sessionId: string
): Promise<void> {
  const prepared = await prepareArchiveSourceIntent(source, {
    projectId: 'project-archive',
    sessionId,
    migrationId: 'migration-wide',
    sourceOwnerName: 'project-archive',
    targetOwnerName: 'project-archive:archive:g1:s1',
    targetGeneration: 1,
    sourceIntentToken: 'intent-wide',
    now: NOW,
    minTerminalAgeMs: 0,
  });
  prepareArchiveTarget(target, {
    projectId: 'project-archive',
    sessionId,
    migrationId: 'migration-wide',
    sourceOwnerName: 'project-archive',
    targetOwnerName: 'project-archive:archive:g1:s1',
    targetGeneration: 1,
    sourceIntentToken: 'intent-wide',
    terminalVersionSha256: prepared.terminalVersionSha256,
    sessionRow: prepared.sessionRow,
    expectedMessageCount: prepared.messageCount,
    now: NOW,
  });
}

async function copyAllChunks(
  source: SqlStorage,
  target: SqlStorage,
  base: Omit<ArchiveSourceExportChunkInput, 'tableName' | 'ordinal' | 'cursor'>
): Promise<string[]> {
  const hashes: string[] = [];
  for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
    let cursor: string | null = null;
    let ordinal = 0;
    do {
      const chunk = await exportArchiveChunk(source, {
        ...base,
        tableName,
        ordinal,
        cursor,
        maxRows: 1,
        maxBytes: 1024 * 1024,
      });
      const committed = await commitArchiveTargetChunk(target, { ...chunk, now: NOW });
      expect(committed.sha256).toBe(chunk.sha256);
      const replay = await commitArchiveTargetChunk(target, { ...chunk, now: NOW });
      expect(replay.idempotent).toBe(true);
      hashes.push(chunk.sha256);
      cursor = chunk.hasMore ? chunk.cursor : null;
      ordinal++;
    } while (cursor);
  }
  return hashes;
}

describe('ProjectData terminal archive sharding bridge', () => {
  it('keeps the archive surface inventory explicit and ordered', () => {
    const expected: ProjectDataArchiveSurface[] = [
      'chat_sessions-root-anchor',
      'chat_messages-exact-transcript-read-write',
      'chat_messages_grouped-search-materialization',
      'chat_messages_grouped_fts-search-index-rebuilt-in-target',
      'tool_payload_archives-r2-ledger',
      'tool_payload_cleanup_attempts-eligibility-fence',
      'session_state-current-plan-and-activity-fence',
      'session_summaries-d1-last-message-summary-anchor',
      'workspace_activity-liveness-fence',
      'acp_sessions-liveness-fence',
      'idle_cleanup_schedule-liveness-fence',
      'task_wait_subscriptions-wake-fence',
      'comment_threads-no-cascade-deletion-fence',
      'comment_replies-no-cascade-deletion-fence',
      'message-count-dedup-sequence-source-of-truth',
      'project-wide-search-explicit-partial-plane',
    ];

    expect(PROJECT_DATA_ARCHIVE_SURFACE_INVENTORY).toEqual(expected);
  });

  describe('chunk verification read across bind sub-batches', () => {
    const SESSION = 'session-wide';
    const WIDE_ROWS = 250;

    it('verifies a chunk whose row count spans several sub-batches', async () => {
      const source = makeSql();
      const target = makeSql();
      try {
        seedWideTerminalSession(source.sql, SESSION, WIDE_ROWS);
        await prepareWideTarget(source.sql, target.sql, SESSION);
        const chunk = await exportWideChatMessagesChunk(source.sql, SESSION, 500);
        expect(chunk.rowCount).toBe(WIDE_ROWS);

        const committed = await commitArchiveTargetChunk(target.sql, { ...chunk, now: NOW });
        // The committed hash is recomputed from the read-back rows, so a batch
        // concatenated out of order could not produce the source chunk hash.
        expect(committed.sha256).toBe(chunk.sha256);
        expect(committed.rowCount).toBe(WIDE_ROWS);
      } finally {
        source.db.close();
        target.db.close();
      }
    });

    it('counts missing rows across every sub-batch, not just the first', async () => {
      const source = makeSql();
      const target = makeSql();
      try {
        seedWideTerminalSession(source.sql, SESSION, WIDE_ROWS);
        await prepareWideTarget(source.sql, target.sql, SESSION);
        const chunk = await exportWideChatMessagesChunk(source.sql, SESSION, 500);

        // A row id that will never be committed, appended past the first
        // sub-batch. A per-batch completeness check would miss it.
        await expect(
          commitArchiveTargetChunk(target.sql, {
            ...chunk,
            rowIds: [...chunk.rowIds, `${SESSION}-message-absent`],
            now: NOW,
          })
        ).rejects.toMatchObject({ reason: 'target_chunk_missing_rows' });
      } finally {
        source.db.close();
        target.db.close();
      }
    });

    it('rejects row ids that are not in source chunk order', async () => {
      const source = makeSql();
      const target = makeSql();
      try {
        seedWideTerminalSession(source.sql, SESSION, WIDE_ROWS);
        await prepareWideTarget(source.sql, target.sql, SESSION);
        const chunk = await exportWideChatMessagesChunk(source.sql, SESSION, 500);

        // Sub-batching makes the returned sequence depend on rowIds being globally
        // ordered; pre-fix that ordering came entirely from SQL. Reversing the ids
        // must fail fast and namefully rather than surfacing as a hash mismatch.
        await expect(
          commitArchiveTargetChunk(target.sql, {
            ...chunk,
            rowIds: [...chunk.rowIds].reverse(),
            now: NOW,
          })
        ).rejects.toMatchObject({ reason: 'target_chunk_row_order_mismatch' });
      } finally {
        source.db.close();
        target.db.close();
      }
    });
  });

  it('copies bounded chunks idempotently, seals by recomputed hashes, then finalizes source deletion with a last-message anchor', async () => {
    const source = makeSql();
    const target = makeSql();
    try {
      seedTerminalSession(source.sql);
      const prepared = await prepareArchiveSourceIntent(source.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-1',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-1',
        now: NOW,
        minTerminalAgeMs: 0,
      });
      expect(prepared.lastMessageAt).toBe(1200);
      expect(prepared.terminalVersionSha256).toMatch(/^[a-f0-9]{64}$/);

      const targetPrepared = prepareArchiveTarget(target.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-1',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-1',
        terminalVersionSha256: prepared.terminalVersionSha256,
        sessionRow: prepared.sessionRow,
        expectedMessageCount: prepared.messageCount,
        now: NOW,
      });
      expect(targetPrepared.idempotent).toBe(false);

      const chunkHashes = await copyAllChunks(source.sql, target.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-1',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-1',
      });

      const sealed = await sealArchiveTarget(target.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-1',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-1',
        terminalVersionSha256: prepared.terminalVersionSha256,
        expectedChunkHashes: chunkHashes,
        now: NOW,
      });
      expect(sealed.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(sealed.messageCount).toBe(2);
      expect(sealed.groupedCount).toBe(1);
      expect(sealed.toolArchiveCount).toBe(1);
      expect(
        archiveTargetSearchProjectMessages(
          target.sql,
          {
            kind: 'archive_shard',
            projectId: 'project-archive',
            ownerName: 'project-archive:archive:g1:s1',
            generation: 1,
          },
          'archived reply',
          null,
          10
        ).map((result) => result.id)
      ).toEqual(['session-archive-message-2']);

      expect(
        markSourceTargetSealed(source.sql, {
          sessionId: 'session-archive',
          migrationId: 'migration-1',
          sourceIntentToken: 'intent-1',
          targetAggregateSha256: sealed.aggregateSha256,
          now: NOW,
        })
      ).toBe(true);
      expect(
        markSourceRecoveryManifestPersisted(source.sql, {
          sessionId: 'session-archive',
          migrationId: 'migration-1',
          sourceIntentToken: 'intent-1',
          targetAggregateSha256: sealed.aggregateSha256,
          r2ManifestKey: 'project-data/session-archives/project/session/migration/manifest.json',
          now: NOW,
        })
      ).toBe(true);

      const finalized = await finalizeSourceDelete(source.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-1',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-1',
        expectedTerminalVersionSha256: prepared.terminalVersionSha256,
        targetAggregateSha256: sealed.aggregateSha256,
        r2ManifestKey: 'project-data/session-archives/project/session/migration/manifest.json',
        now: NOW,
        minTerminalAgeMs: 0,
      });
      expect(finalized).toMatchObject({
        idempotent: false,
        lastMessageAt: 1200,
        messagesDeleted: 2,
        groupedRowsDeleted: 1,
        toolArchiveRowsDeleted: 1,
      });
      expect(
        source.db
          .prepare('SELECT archive_last_message_at, archive_state FROM chat_sessions WHERE id = ?')
          .get('session-archive')
      ).toEqual({ archive_last_message_at: 1200, archive_state: 'source_deleted' });
      expect(
        target.db
          .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?')
          .get('session-archive')
      ).toEqual({ count: 2 });
      expect(() =>
        archiveSourceReadMessages(
          source.sql,
          {} as never,
          {
            projectId: 'project-archive',
            sessionId: 'session-archive',
            ownerName: 'project-archive',
            generation: 0,
            migrationId: 'migration-1',
          },
          10,
          null,
          null,
          undefined,
          false,
          'asc'
        )
      ).toThrow(/failed closed/);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it('fences DO-local transcript writers once archive source hashing/finalize can be in flight', async () => {
    const source = makeSql();
    try {
      seedTerminalSession(source.sql);
      await prepareArchiveSourceIntent(source.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-local-writer-fence',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-local-writer-fence',
        now: NOW,
        minTerminalAgeMs: 0,
      });

      expect(() =>
        persistMessage(
          source.sql,
          {} as never,
          'session-archive',
          'assistant',
          'late local write',
          null
        )
      ).toThrow(expect.objectContaining({ code: PROJECT_DATA_TRANSCRIPT_WRITE_FENCED }));
    } finally {
      source.db.close();
    }
  });

  it('refuses active sessions and sessions with comments before any source delete can cascade', async () => {
    const source = makeSql();
    try {
      seedTerminalSession(source.sql, 'session-active');
      source.sql.exec(
        "UPDATE chat_sessions SET status = 'active', ended_at = NULL WHERE id = 'session-active'"
      );
      await expect(
        prepareArchiveSourceIntent(source.sql, {
          projectId: 'project-archive',
          sessionId: 'session-active',
          migrationId: 'migration-active',
          sourceOwnerName: 'project-archive',
          targetOwnerName: 'project-archive:archive:g1:s1',
          targetGeneration: 1,
          sourceIntentToken: 'intent-active',
          now: NOW,
          minTerminalAgeMs: 0,
        })
      ).rejects.toMatchObject({ reason: 'session_not_terminal' });

      seedTerminalSession(source.sql, 'session-commented');
      source.sql.exec(
        `INSERT INTO comment_threads
           (id, session_id, anchor_kind, message_id, body, author_type, author_id,
            status, created_at, updated_at, sequence, version)
         VALUES ('thread-1', 'session-commented', 'message', 'session-commented-message-1',
                 'comment', 'human', 'user-1', 'open', 1600, 1600, 1, 1)`
      );
      await expect(
        prepareArchiveSourceIntent(source.sql, {
          projectId: 'project-archive',
          sessionId: 'session-commented',
          migrationId: 'migration-commented',
          sourceOwnerName: 'project-archive',
          targetOwnerName: 'project-archive:archive:g1:s2',
          targetGeneration: 1,
          sourceIntentToken: 'intent-commented',
          now: NOW,
          minTerminalAgeMs: 0,
        })
      ).rejects.toMatchObject({ reason: 'message_comments_present' });
      expect(
        source.db
          .prepare('SELECT COUNT(*) AS count FROM comment_threads WHERE session_id = ?')
          .get('session-commented')
      ).toEqual({ count: 1 });
      expect(
        source.db
          .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?')
          .get('session-commented')
      ).toEqual({ count: 2 });
    } finally {
      source.db.close();
    }
  });

  it('defines unchanged terminal version as a committed-row hash instead of relying on a missing chat_sessions version column', async () => {
    const source = makeSql();
    try {
      seedTerminalSession(source.sql);
      const before = await computeTerminalVersion(source.sql, 'session-archive');
      source.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
         VALUES ('message-new', 'session-archive', 'assistant', 'late write', NULL, 1250, 3, NULL)`
      );
      const after = await computeTerminalVersion(source.sql, 'session-archive');
      expect(after.sha256).not.toBe(before.sha256);
    } finally {
      source.db.close();
    }
  });

  it('fails closed when a single source row cannot fit inside the configured chunk byte budget', async () => {
    const source = makeSql();
    try {
      seedTerminalSession(source.sql);
      const prepared = await prepareArchiveSourceIntent(source.sql, {
        projectId: 'project-archive',
        sessionId: 'session-archive',
        migrationId: 'migration-small-budget',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-small-budget',
        now: NOW,
        minTerminalAgeMs: 0,
      });
      expect(prepared.messageCount).toBe(2);
      await expect(
        exportArchiveChunk(source.sql, {
          projectId: 'project-archive',
          sessionId: 'session-archive',
          migrationId: 'migration-small-budget',
          sourceOwnerName: 'project-archive',
          targetOwnerName: 'project-archive:archive:g1:s1',
          targetGeneration: 1,
          sourceIntentToken: 'intent-small-budget',
          tableName: 'chat_messages',
          ordinal: 0,
          maxRows: 10,
          maxBytes: 1,
        })
      ).rejects.toMatchObject({ reason: 'archive_row_exceeds_chunk_budget' });
    } finally {
      source.db.close();
    }
  });
});
