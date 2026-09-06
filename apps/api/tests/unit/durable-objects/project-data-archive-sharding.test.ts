import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  abandonArchiveSourceIntent,
  abandonArchiveTargetSession,
  type ArchiveSourceExportChunkInput,
  archiveSourceReadMessages,
  archiveTargetSearchProjectMessages,
  commitArchiveTargetChunk,
  computeTerminalVersion,
  exportArchiveChunk,
  finalizeSourceDelete,
  GROUPED_ROW_PAGE_SQL,
  markArchiveTargetRehomeExported,
  markSourceRecoveryManifestPersisted,
  markSourceTargetSealed,
  prepareArchiveSourceIntent,
  prepareArchiveSourceIntentOrRefuse,
  prepareArchiveTarget,
  ProjectDataArchiveInvariantError,
  resolveArchiveHashPageRows,
  sealArchiveTarget,
} from '../../../src/durable-objects/project-data/archive-sharding';
import {
  persistMessage,
  PROJECT_DATA_TRANSCRIPT_WRITE_FENCED,
} from '../../../src/durable-objects/project-data/messages';
import { D1_MAX_BOUND_PARAMETERS } from '../../../src/lib/d1-limits';
import {
  PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS,
  PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS,
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

/**
 * Seed the tool-payload ledger for an already-seeded wide session.
 *
 * Exists because `readCommittedRowsForChunk` short-circuits on an empty rowIds list, so a
 * fixture with no tool payloads never invokes the sub-batching loop for this table at all —
 * it was the one archive table with zero above-ceiling coverage.
 */
function seedWideToolPayloadArchives(sql: SqlStorage, sessionId: string, count: number): void {
  for (let index = 0; index < count; index++) {
    sql.exec(
      `INSERT INTO tool_payload_archives
         (message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
          archived_at, message_created_at, message_sequence, archive_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      `${sessionId}-message-${String(index).padStart(4, '0')}`,
      sessionId,
      `r2/tool/${sessionId}/${index}`,
      10 + index,
      20 + index,
      1300 + index,
      1100 + index,
      index + 1
    );
  }
}

async function exportWideChunk(
  sql: SqlStorage,
  sessionId: string,
  maxRows: number,
  tableName: 'chat_messages' | 'tool_payload_archives' = 'chat_messages'
) {
  return exportArchiveChunk(sql, {
    projectId: 'project-archive',
    sessionId,
    migrationId: 'migration-wide',
    sourceOwnerName: 'project-archive',
    targetOwnerName: 'project-archive:archive:g1:s1',
    targetGeneration: 1,
    sourceIntentToken: 'intent-wide',
    tableName,
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
        const chunk = await exportWideChunk(source.sql, SESSION, 500);
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

    // The 201-row Workers test proves workerd accepts a full 100-bind batch (it sends two).
    // What it cannot cheaply do is sweep the arithmetic either side of the boundary, so that
    // is pinned here: an off-by-one in the slice bounds shows up as a wrong row set, which is
    // engine-independent and therefore legitimate to assert against better-sqlite3.
    it.each([
      D1_MAX_BOUND_PARAMETERS - 1,
      D1_MAX_BOUND_PARAMETERS,
      D1_MAX_BOUND_PARAMETERS + 1,
      D1_MAX_BOUND_PARAMETERS * 2 + 1,
    ])(
      'reads back exactly the right rows at the exact sub-batch boundary (%i rows)',
      async (rowCount) => {
        const source = makeSql();
        const target = makeSql();
        const sessionId = `${SESSION}-${rowCount}`;
        try {
          seedWideTerminalSession(source.sql, sessionId, rowCount);
          await prepareWideTarget(source.sql, target.sql, sessionId);
          const chunk = await exportWideChunk(source.sql, sessionId, 500);
          expect(chunk.rowCount).toBe(rowCount);

          const committed = await commitArchiveTargetChunk(target.sql, { ...chunk, now: NOW });
          // Hash equality over the read-back rows is the strong assertion: it can only hold if
          // every row was returned exactly once, in the source chunk's order.
          expect(committed.sha256).toBe(chunk.sha256);
          expect(committed.rowCount).toBe(rowCount);
        } finally {
          source.db.close();
          target.db.close();
        }
      }
    );

    it('counts missing rows across every sub-batch, not just the first', async () => {
      const source = makeSql();
      const target = makeSql();
      try {
        seedWideTerminalSession(source.sql, SESSION, WIDE_ROWS);
        await prepareWideTarget(source.sql, target.sql, SESSION);
        const chunk = await exportWideChunk(source.sql, SESSION, 500);

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

    it('sub-batches the tool-payload ledger above the ceiling too, not just chat_messages', async () => {
      const source = makeSql();
      const target = makeSql();
      try {
        seedWideTerminalSession(source.sql, SESSION, WIDE_ROWS);
        seedWideToolPayloadArchives(source.sql, SESSION, WIDE_ROWS);
        await prepareWideTarget(source.sql, target.sql, SESSION);

        const chunk = await exportWideChunk(source.sql, SESSION, 500, 'tool_payload_archives');
        expect(chunk.rowCount).toBe(WIDE_ROWS);
        expect(chunk.rowCount).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);

        const committed = await commitArchiveTargetChunk(target.sql, { ...chunk, now: NOW });
        expect(committed.sha256).toBe(chunk.sha256);
        expect(committed.rowCount).toBe(WIDE_ROWS);
      } finally {
        source.db.close();
        target.db.close();
      }
    });

    it('rejects duplicate row ids instead of letting a batch boundary restore the count', async () => {
      const source = makeSql();
      const target = makeSql();
      try {
        seedWideTerminalSession(source.sql, SESSION, WIDE_ROWS);
        await prepareWideTarget(source.sql, target.sql, SESSION);
        const chunk = await exportWideChunk(source.sql, SESSION, 500);

        // `IN (...)` de-duplicates. One statement read a repeat once and the
        // count check caught it; batched, the repeat is read once per batch it
        // lands in, which would restore the count and hide it.
        const duplicated = [...chunk.rowIds];
        duplicated.splice(D1_MAX_BOUND_PARAMETERS, 0, duplicated[D1_MAX_BOUND_PARAMETERS - 1]!);

        await expect(
          commitArchiveTargetChunk(target.sql, {
            ...chunk,
            rowIds: duplicated,
            now: NOW,
          })
        ).rejects.toMatchObject({ reason: 'target_chunk_duplicate_row_ids' });
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
        const chunk = await exportWideChunk(source.sql, SESSION, 500);

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

  it('returns a typed pre-copy refusal before any write, and throws once an intent exists', async () => {
    const source = makeSql();
    try {
      seedTerminalSession(source.sql, 'session-refused');
      // The DO-local guard the D1 candidate query cannot see (production `ea87d375`).
      source.sql.exec(
        `INSERT INTO session_state (session_id, activity, activity_at)
         VALUES ('session-refused', 'prompting', ?)`,
        NOW
      );
      const input = {
        projectId: 'project-archive',
        sessionId: 'session-refused',
        migrationId: 'migration-refused',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s3',
        targetGeneration: 1,
        sourceIntentToken: 'intent-refused',
        now: NOW,
        minTerminalAgeMs: 0,
      };
      const countIntents = () =>
        (
          source.db
            .prepare(
              'SELECT COUNT(*) AS count FROM project_data_archive_source_intents WHERE session_id = ?'
            )
            .get('session-refused') as { count: number }
        ).count;

      // Returned, not thrown: the value crosses the RPC boundary with its reason intact.
      await expect(prepareArchiveSourceIntentOrRefuse(source.sql, input)).resolves.toMatchObject({
        refused: true,
        reason: 'active_session_state',
        message: 'ProjectData archive refuses sessions with active session_state rows',
      });
      expect(countIntents()).toBe(0);
      // The throwing entry point keeps its contract for callers that expect success.
      await expect(prepareArchiveSourceIntent(source.sql, input)).rejects.toMatchObject({
        reason: 'active_session_state',
      });
      expect(countIntents()).toBe(0);

      // Owner control: once the condition clears the same call prepares the intent.
      source.sql.exec(
        "UPDATE session_state SET activity = 'idle' WHERE session_id = 'session-refused'"
      );
      await expect(prepareArchiveSourceIntentOrRefuse(source.sql, input)).resolves.toMatchObject({
        idempotent: false,
        sourceIntentToken: 'intent-refused',
      });
      expect(countIntents()).toBe(1);

      // With an intent row present the transcript is fenced on this object: the same invariant
      // must THROW so the coordinator keeps its fail-closed retry path, never unfence.
      source.sql.exec(
        "UPDATE session_state SET activity = 'prompting' WHERE session_id = 'session-refused'"
      );
      await expect(prepareArchiveSourceIntentOrRefuse(source.sql, input)).rejects.toMatchObject({
        reason: 'active_session_state',
      });
      expect(countIntents()).toBe(1);
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

/**
 * Wrap a SqlStorage so every SELECT records how many rows it materialised.
 *
 * The Durable Object memory ceiling that reset production is a platform limit better-sqlite3
 * does not enforce (rule 69), so the discriminating assertion here is the statement shape:
 * no single SELECT may return more rows than the hash page size. The one-shot definition
 * returned the whole session in one statement and fails this at any fixture above the page.
 */
function recordSelectRows(base: SqlStorage): {
  sql: SqlStorage;
  maxRowsPerSelect: number;
  selects: number;
} {
  const recorder = { maxRowsPerSelect: 0, selects: 0 } as {
    sql: SqlStorage;
    maxRowsPerSelect: number;
    selects: number;
  };
  recorder.sql = {
    exec(query: string, ...params: unknown[]) {
      const cursor = base.exec(query, ...params);
      if (!/^\s*SELECT/i.test(query)) return cursor;
      const rows = cursor.toArray();
      recorder.selects++;
      recorder.maxRowsPerSelect = Math.max(recorder.maxRowsPerSelect, rows.length);
      return { toArray: () => rows, rowsWritten: 0 } as unknown as ReturnType<SqlStorage['exec']>;
    },
    get databaseSize() {
      return base.databaseSize;
    },
  } as unknown as SqlStorage;
  return recorder;
}

function seedWideGroupedRows(sql: SqlStorage, sessionId: string, count: number): void {
  for (let index = 0; index < count; index++) {
    sql.exec(
      `INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      `${sessionId}-group-${String(index).padStart(4, '0')}`,
      sessionId,
      index % 2 === 0 ? 'user' : 'assistant',
      `grouped payload ${index}`,
      1100 + index
    );
  }
}

const WIDE_SESSION_ROWS = 1205; // two full 500-row pages plus a remainder per table

describe('resolveArchiveHashPageRows clamps the memory-safety page size at the env boundary', () => {
  it('honors an in-range override', () => {
    expect(resolveArchiveHashPageRows({ PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS: '250' })).toBe(250);
  });

  it('falls back to the default when the env var is absent, blank, or unparseable', () => {
    expect(resolveArchiveHashPageRows(undefined)).toBe(PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS);
    expect(resolveArchiveHashPageRows({})).toBe(PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS);
    for (const value of ['', ' ', 'abc', 'NaN', '0', '-5', '-0']) {
      expect(resolveArchiveHashPageRows({ PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS: value })).toBe(
        PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS
      );
    }
  });

  it('clamps an oversize override to the configured ceiling instead of honoring it', () => {
    const over = String(PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS * 100);
    expect(resolveArchiveHashPageRows({ PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS: over })).toBe(
      PROJECT_DATA_ARCHIVE_MAX_HASH_PAGE_ROWS
    );
    expect(
      resolveArchiveHashPageRows({ PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS: '99999999999999999999' })
    ).toBe(PROJECT_DATA_ARCHIVE_DEFAULT_HASH_PAGE_ROWS);
  });
});

describe('ProjectData archive terminal-version hashing streams bounded pages', () => {
  it('never materialises more than one page per statement and is invariant to the page size', async () => {
    const { db, sql } = makeSql();
    try {
      seedWideTerminalSession(sql, 'session-paged', WIDE_SESSION_ROWS);
      seedWideGroupedRows(sql, 'session-paged', WIDE_SESSION_ROWS);
      seedWideToolPayloadArchives(sql, 'session-paged', WIDE_SESSION_ROWS);

      const recorder = recordSelectRows(sql);
      const paged = await computeTerminalVersion(recorder.sql, 'session-paged', {
        hashPageRows: 500,
      });
      expect(recorder.maxRowsPerSelect).toBeLessThanOrEqual(500);
      // Three archive tables, each needing ceil(1205 / 500) = 3 pages.
      expect(recorder.selects).toBeGreaterThanOrEqual(9);
      expect(paged.messageCount).toBe(WIDE_SESSION_ROWS);

      const onePage = await computeTerminalVersion(sql, 'session-paged', { hashPageRows: 10_000 });
      const rowByRow = await computeTerminalVersion(sql, 'session-paged', { hashPageRows: 1 });
      const exactPages = await computeTerminalVersion(sql, 'session-paged', {
        hashPageRows: WIDE_SESSION_ROWS,
      });
      expect(onePage.sha256).toBe(paged.sha256);
      expect(rowByRow.sha256).toBe(paged.sha256);
      expect(exactPages.sha256).toBe(paged.sha256);
      expect(paged.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it('pages grouped rows through the session index instead of sorting the whole session per page', () => {
    // A rowid-keyed page over this table plans as a temp b-tree over every remaining row of
    // the session on EVERY page (O(N^2 / pageRows)); the (created_at, id) seek must be an
    // index range scan so the memory fix does not become a CPU-time regression.
    const store = makeSql();
    try {
      seedTerminalSession(store.sql, 'session-plan');
      seedWideGroupedRows(store.sql, 'session-plan', 10);
      const plan = store.db
        .prepare(`EXPLAIN QUERY PLAN ${GROUPED_ROW_PAGE_SQL}`)
        .all('session-plan', -1, -1, '', 500) as Array<{ detail: string }>;
      const details = plan.map((row) => row.detail);
      expect(details.some((detail) => detail.includes('idx_grouped_messages_session'))).toBe(true);
      const fullSort = details.filter(
        (detail) => /TEMP B-TREE FOR ORDER BY/i.test(detail) && !/LAST TERM/i.test(detail)
      );
      expect(fullSort).toEqual([]);

      const rowidPlan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid, content FROM chat_messages_grouped
           WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`
        )
        .all('session-plan', -1, 500) as Array<{ detail: string }>;
      // Control: the rejected shape really does sort per page on this schema.
      expect(rowidPlan.some((row) => /TEMP B-TREE FOR ORDER BY/i.test(row.detail))).toBe(true);
    } finally {
      store.db.close();
    }
  });

  it('keeps every source-side scan bounded through seal and finalize on a multi-page session', async () => {
    const source = makeSql();
    const target = makeSql();
    try {
      seedWideTerminalSession(source.sql, 'session-paged', WIDE_SESSION_ROWS);
      seedWideGroupedRows(source.sql, 'session-paged', WIDE_SESSION_ROWS);
      const base = {
        projectId: 'project-archive',
        sessionId: 'session-paged',
        migrationId: 'migration-paged',
        sourceOwnerName: 'project-archive',
        targetOwnerName: 'project-archive:archive:g1:s1',
        targetGeneration: 1,
        sourceIntentToken: 'intent-paged',
      };
      const sourceRecorder = recordSelectRows(source.sql);
      const prepared = await prepareArchiveSourceIntent(sourceRecorder.sql, {
        ...base,
        now: NOW,
        minTerminalAgeMs: 0,
        hashPageRows: 500,
      });
      prepareArchiveTarget(target.sql, {
        ...base,
        terminalVersionSha256: prepared.terminalVersionSha256,
        sessionRow: prepared.sessionRow,
        expectedMessageCount: prepared.messageCount,
        now: NOW,
      });
      const hashes: string[] = [];
      for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
        let cursor: string | null = null;
        let ordinal = 0;
        do {
          const chunk = await exportArchiveChunk(source.sql, {
            ...base,
            tableName,
            ordinal,
            cursor,
            maxRows: 500,
            maxBytes: 8 * 1024 * 1024,
          });
          await commitArchiveTargetChunk(target.sql, { ...chunk, now: NOW });
          hashes.push(chunk.sha256);
          cursor = chunk.hasMore ? chunk.cursor : null;
          ordinal++;
        } while (cursor);
      }
      const targetRecorder = recordSelectRows(target.sql);
      const sealed = await sealArchiveTarget(targetRecorder.sql, {
        ...base,
        terminalVersionSha256: prepared.terminalVersionSha256,
        expectedChunkHashes: hashes,
        now: NOW,
        hashPageRows: 500,
      });
      expect(targetRecorder.maxRowsPerSelect).toBeLessThanOrEqual(500);
      expect(sealed.messageCount).toBe(WIDE_SESSION_ROWS);
      expect(sealed.groupedCount).toBe(WIDE_SESSION_ROWS);

      markSourceTargetSealed(source.sql, {
        sessionId: base.sessionId,
        migrationId: base.migrationId,
        sourceIntentToken: base.sourceIntentToken,
        targetAggregateSha256: sealed.aggregateSha256,
        now: NOW,
      });
      markSourceRecoveryManifestPersisted(source.sql, {
        sessionId: base.sessionId,
        migrationId: base.migrationId,
        sourceIntentToken: base.sourceIntentToken,
        targetAggregateSha256: sealed.aggregateSha256,
        r2ManifestKey: 'project-data/session-archives/paged/manifest.json',
        now: NOW,
      });
      const finalizeRecorder = recordSelectRows(source.sql);
      const finalized = await finalizeSourceDelete(finalizeRecorder.sql, {
        ...base,
        expectedTerminalVersionSha256: prepared.terminalVersionSha256,
        targetAggregateSha256: sealed.aggregateSha256,
        r2ManifestKey: 'project-data/session-archives/paged/manifest.json',
        now: NOW,
        minTerminalAgeMs: 0,
        hashPageRows: 500,
      });
      expect(finalizeRecorder.maxRowsPerSelect).toBeLessThanOrEqual(500);
      expect(finalized).toMatchObject({
        messagesDeleted: WIDE_SESSION_ROWS,
        groupedRowsDeleted: WIDE_SESSION_ROWS,
      });
      expect(
        source.db
          .prepare('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?')
          .get('session-paged')
      ).toEqual({ count: 0 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe('ProjectData archive abandon primitives', () => {
  const base = {
    projectId: 'project-archive',
    sessionId: 'session-archive',
    migrationId: 'migration-1',
    sourceOwnerName: 'project-archive',
    targetOwnerName: 'project-archive:archive:g1:s1',
    targetGeneration: 1,
    sourceIntentToken: 'intent-1',
  };

  function countRows(db: Database.Database, table: string, sessionId = 'session-archive') {
    const column = table === 'chat_sessions' ? 'id' : 'session_id';
    return (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(sessionId) as {
        count: number;
      }
    ).count;
  }

  it('drops a partial shard copy and the root intent while leaving root transcript rows untouched', async () => {
    const source = makeSql();
    const target = makeSql();
    try {
      seedTerminalSession(source.sql);
      const prepared = await prepareArchiveSourceIntent(source.sql, {
        ...base,
        now: NOW,
        minTerminalAgeMs: 0,
      });
      prepareArchiveTarget(target.sql, {
        ...base,
        terminalVersionSha256: prepared.terminalVersionSha256,
        sessionRow: prepared.sessionRow,
        expectedMessageCount: prepared.messageCount,
        now: NOW,
      });
      // Copy only the first message chunk: the shape of a migration interrupted mid-copy.
      const chunk = await exportArchiveChunk(source.sql, {
        ...base,
        tableName: 'chat_messages',
        ordinal: 0,
        cursor: null,
        maxRows: 1,
        maxBytes: 1024 * 1024,
      });
      await commitArchiveTargetChunk(target.sql, { ...chunk, now: NOW });
      expect(countRows(target.db, 'chat_messages')).toBe(1);
      expect(countRows(target.db, 'project_data_archive_target_chunks')).toBe(1);

      const targetResult = abandonArchiveTargetSession(target.sql, { ...base, now: NOW });
      expect(targetResult).toMatchObject({
        removed: true,
        state: 'copying',
        messagesDeleted: 1,
        chunksDeleted: 1,
      });
      for (const table of [
        'chat_messages',
        'chat_messages_grouped',
        'tool_payload_archives',
        'project_data_archive_target_chunks',
        'project_data_archive_target_sessions',
        'chat_sessions',
      ]) {
        expect(countRows(target.db, table)).toBe(0);
      }
      expect(
        archiveTargetSearchProjectMessages(
          target.sql,
          {
            kind: 'archive_shard',
            projectId: 'project-archive',
            ownerName: 'project-archive:archive:g1:s1',
            generation: 1,
          },
          'hello',
          null,
          10
        )
      ).toEqual([]);
      // Idempotent: a rerun after the shard is clean reports nothing removed.
      expect(abandonArchiveTargetSession(target.sql, { ...base, now: NOW })).toMatchObject({
        removed: false,
        state: null,
      });

      const sourceResult = abandonArchiveSourceIntent(source.sql, { ...base, now: NOW });
      expect(sourceResult).toMatchObject({ removed: true, state: 'intent_prepared' });
      expect(countRows(source.db, 'project_data_archive_source_intents')).toBe(0);
      expect(countRows(source.db, 'chat_messages')).toBe(2);
      expect(countRows(source.db, 'chat_messages_grouped')).toBe(1);
      expect(countRows(source.db, 'tool_payload_archives')).toBe(1);
      expect(abandonArchiveSourceIntent(source.sql, { ...base, now: NOW })).toMatchObject({
        removed: false,
        state: null,
      });

      // The session is migratable again under a fresh migration and hashes identically.
      const again = await prepareArchiveSourceIntent(source.sql, {
        ...base,
        migrationId: 'migration-2',
        sourceIntentToken: 'intent-2',
        now: NOW,
        minTerminalAgeMs: 0,
      });
      expect(again.terminalVersionSha256).toBe(prepared.terminalVersionSha256);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it('keeps the grouped-row and FTS teardown paged when abandoning a multi-page shard copy', async () => {
    // The abandon path is the recovery route for exactly the sessions that reset the object,
    // so its own scans must stay bounded by the page size too (rule 69, memory ceiling).
    const source = makeSql();
    const target = makeSql();
    try {
      const wide = { ...base, sessionId: 'session-paged', migrationId: 'migration-paged' };
      seedWideTerminalSession(source.sql, 'session-paged', WIDE_SESSION_ROWS);
      const prepared = await prepareArchiveSourceIntent(source.sql, {
        ...wide,
        now: NOW,
        minTerminalAgeMs: 0,
        hashPageRows: 500,
      });
      prepareArchiveTarget(target.sql, {
        ...wide,
        terminalVersionSha256: prepared.terminalVersionSha256,
        sessionRow: prepared.sessionRow,
        expectedMessageCount: prepared.messageCount,
        now: NOW,
      });
      seedWideGroupedRows(target.sql, 'session-paged', WIDE_SESSION_ROWS);
      expect(
        target.db
          .prepare('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?')
          .get('session-paged')
      ).toEqual({ count: WIDE_SESSION_ROWS });

      const recorder = recordSelectRows(target.sql);
      const result = abandonArchiveTargetSession(recorder.sql, {
        ...wide,
        now: NOW,
        hashPageRows: 500,
      });
      expect(result).toMatchObject({ removed: true, groupedRowsDeleted: WIDE_SESSION_ROWS });
      expect(recorder.maxRowsPerSelect).toBeLessThanOrEqual(500);
      expect(recorder.selects).toBeGreaterThanOrEqual(Math.ceil(WIDE_SESSION_ROWS / 500));
      expect(
        target.db
          .prepare('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?')
          .get('session-paged')
      ).toEqual({ count: 0 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it('refuses to abandon a sealed target without source proof and refuses once the source is deleted', async () => {
    const source = makeSql();
    const target = makeSql();
    try {
      seedTerminalSession(source.sql);
      const prepared = await prepareArchiveSourceIntent(source.sql, {
        ...base,
        now: NOW,
        minTerminalAgeMs: 0,
      });
      prepareArchiveTarget(target.sql, {
        ...base,
        terminalVersionSha256: prepared.terminalVersionSha256,
        sessionRow: prepared.sessionRow,
        expectedMessageCount: prepared.messageCount,
        now: NOW,
      });
      const chunkHashes = await copyAllChunks(source.sql, target.sql, base);
      const sealed = await sealArchiveTarget(target.sql, {
        ...base,
        terminalVersionSha256: prepared.terminalVersionSha256,
        expectedChunkHashes: chunkHashes,
        now: NOW,
      });

      // Sealed target, source still intact: refused without proof, allowed with it.
      expect(() => abandonArchiveTargetSession(target.sql, { ...base, now: NOW })).toThrow(
        ProjectDataArchiveInvariantError
      );
      try {
        abandonArchiveTargetSession(target.sql, { ...base, now: NOW });
      } catch (error) {
        expect((error as ProjectDataArchiveInvariantError).reason).toBe(
          'target_sealed_requires_source_proof'
        );
      }
      expect(countRows(target.db, 'chat_messages')).toBe(2);

      // Owner control: the same call with source proof is allowed while the source is intact.
      const sourceIntentBefore = abandonArchiveSourceIntent(source.sql, { ...base, now: NOW });
      expect(sourceIntentBefore).toMatchObject({ removed: true, state: 'intent_prepared' });
      expect(
        abandonArchiveTargetSession(target.sql, { ...base, sourceIntactVerified: true, now: NOW })
      ).toMatchObject({ removed: true, state: 'sealed', messagesDeleted: 2 });

      // Now drive a second migration all the way through source deletion.
      const second = { ...base, migrationId: 'migration-2', sourceIntentToken: 'intent-2' };
      const preparedAgain = await prepareArchiveSourceIntent(source.sql, {
        ...second,
        now: NOW,
        minTerminalAgeMs: 0,
      });
      prepareArchiveTarget(target.sql, {
        ...second,
        terminalVersionSha256: preparedAgain.terminalVersionSha256,
        sessionRow: preparedAgain.sessionRow,
        expectedMessageCount: preparedAgain.messageCount,
        now: NOW,
      });
      const secondHashes = await copyAllChunks(source.sql, target.sql, second);
      const sealedAgain = await sealArchiveTarget(target.sql, {
        ...second,
        terminalVersionSha256: preparedAgain.terminalVersionSha256,
        expectedChunkHashes: secondHashes,
        now: NOW,
      });
      expect(sealedAgain.aggregateSha256).toBe(sealed.aggregateSha256);
      markSourceTargetSealed(source.sql, {
        sessionId: second.sessionId,
        migrationId: second.migrationId,
        sourceIntentToken: second.sourceIntentToken,
        targetAggregateSha256: sealedAgain.aggregateSha256,
        now: NOW,
      });
      markSourceRecoveryManifestPersisted(source.sql, {
        sessionId: second.sessionId,
        migrationId: second.migrationId,
        sourceIntentToken: second.sourceIntentToken,
        targetAggregateSha256: sealedAgain.aggregateSha256,
        r2ManifestKey: 'project-data/session-archives/abandon/manifest.json',
        now: NOW,
      });
      await finalizeSourceDelete(source.sql, {
        ...second,
        expectedTerminalVersionSha256: preparedAgain.terminalVersionSha256,
        targetAggregateSha256: sealedAgain.aggregateSha256,
        r2ManifestKey: 'project-data/session-archives/abandon/manifest.json',
        now: NOW,
        minTerminalAgeMs: 0,
      });

      expect(() => abandonArchiveSourceIntent(source.sql, { ...second, now: NOW })).toThrow(
        /already been deleted|use copy-back/
      );
      expect(countRows(source.db, 'project_data_archive_source_intents')).toBe(1);

      markArchiveTargetRehomeExported(target.sql, { ...second, now: NOW });
      expect(() =>
        abandonArchiveTargetSession(target.sql, {
          ...second,
          sourceIntactVerified: true,
          now: NOW,
        })
      ).toThrow(/abandon refused/);
      expect(countRows(target.db, 'chat_messages')).toBe(2);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
