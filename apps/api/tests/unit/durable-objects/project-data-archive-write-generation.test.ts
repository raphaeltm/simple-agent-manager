/**
 * The archive write-generation fence (DO migration 076) and the bounded root work it enables.
 *
 * The flip used to re-hash the whole session on the root object to prove nothing changed since
 * prepare, and the prepare hashed it under the transcript lock every message write takes. These
 * cases run the real migrations and archive functions on SQLite and prove:
 * - the triggers count every write to the rows a terminal version hashes, for a fenced,
 *   unflipped session only, and only real changes to hashed columns;
 * - a write landing between the fence and the end of the hash fails the prepare;
 * - the flip proves the root unchanged without reading the session, and refuses (as a value)
 *   when a writer that bypasses the transcript fence changed it;
 * - an intent prepared before the fence still flips through the whole recompute.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  beginArchiveSourcePrepare,
  completeArchiveSourcePrepare,
  computeTerminalVersion,
  exportArchiveChunk,
  flipArchiveSource,
  markSourceRecoveryManifestPersisted,
  markSourceTargetSealed,
  prepareArchiveSourceIntentOrRefuse,
  readArchiveWriteGeneration,
  reattachArchiveSourceToken,
} from '../../../src/durable-objects/project-data/archive-sharding';
import {
  ARCHIVE_MAX_ESTIMATE_INVENTORY_UNITS,
  ARCHIVE_WRITE_FIXED_RESERVATION,
  estimateArchiveWrites,
} from '../../../src/project-data-archive/write-budget';
import { createSqlStorage } from './sql-storage-test-utils';

const NOW = 1_800_000_000_000;
const PROJECT = 'project-wg';
const TARGET = 'project-wg:archive:g1:s1';

function makeSql(): { db: Database.Database; sql: SqlStorage } {
  const db = new Database(':memory:');
  const sql = createSqlStorage(db);
  Object.defineProperty(sql, 'databaseSize', { get: () => 123_456 });
  runMigrations(sql);
  return { db, sql };
}

function seedSession(sql: SqlStorage, sessionId: string, messages: number, bodyBytes = 64): void {
  sql.exec(
    `INSERT INTO chat_sessions
       (id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
        started_at, ended_at, created_at, updated_at, agent_completed_at, materialized_at)
     VALUES (?, 'ws', 'task', 'user', 'topic', 'stopped', ?, 1000, 1500, 1000, 1500, 1500, 1500)`,
    sessionId,
    messages
  );
  const body = 'x'.repeat(bodyBytes);
  for (let index = 0; index < messages; index++) {
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
      `${sessionId}-m-${String(index).padStart(6, '0')}`,
      sessionId,
      index % 2 === 0 ? 'user' : 'assistant',
      `${body} ${index}`,
      1100 + index,
      index + 1
    );
    if (index % 2 === 1) {
      sql.exec(
        `INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
         VALUES (?, ?, 'assistant', ?, ?)`,
        `${sessionId}-g-${String(index).padStart(6, '0')}`,
        sessionId,
        `${body} grouped ${index}`,
        1100 + index
      );
    }
  }
}

function prepareInput(sessionId: string, token = `token-${sessionId}`) {
  return {
    projectId: PROJECT,
    sessionId,
    migrationId: `migration-${sessionId}`,
    sourceOwnerName: PROJECT,
    targetOwnerName: TARGET,
    targetGeneration: 1,
    sourceIntentToken: token,
    now: NOW,
    minTerminalAgeMs: 0,
  };
}

async function prepare(sql: SqlStorage, sessionId: string) {
  const outcome = await prepareArchiveSourceIntentOrRefuse(sql, prepareInput(sessionId));
  if ('refused' in outcome && outcome.refused) throw new Error(`refused: ${outcome.reason}`);
  return outcome as Exclude<typeof outcome, { refused: true }>;
}

/** Drive a prepared intent to the state the flip requires. */
function markReadyToFlip(sql: SqlStorage, sessionId: string) {
  const input = prepareInput(sessionId);
  expect(
    markSourceTargetSealed(sql, {
      sessionId,
      migrationId: input.migrationId,
      sourceIntentToken: input.sourceIntentToken,
      targetAggregateSha256: 'a'.repeat(64),
      now: NOW,
    })
  ).toBe(true);
  expect(
    markSourceRecoveryManifestPersisted(sql, {
      sessionId,
      migrationId: input.migrationId,
      sourceIntentToken: input.sourceIntentToken,
      targetAggregateSha256: 'a'.repeat(64),
      r2ManifestKey: `manifest/${sessionId}`,
      now: NOW,
    })
  ).toBe(true);
}

function flipInput(sessionId: string, terminalVersionSha256: string) {
  const input = prepareInput(sessionId);
  return {
    ...input,
    expectedTerminalVersionSha256: terminalVersionSha256,
    targetAggregateSha256: 'a'.repeat(64),
    r2ManifestKey: `manifest/${sessionId}`,
  };
}

/** Wraps SqlStorage to record the largest row count any single SELECT returned. */
function recordReads(sql: SqlStorage) {
  const stats = { maxRows: 0, totalRows: 0, messageScans: 0 };
  const wrapped = {
    exec(query: string, ...params: unknown[]) {
      const cursor = sql.exec(query, ...params);
      const rows = cursor.toArray();
      stats.maxRows = Math.max(stats.maxRows, rows.length);
      stats.totalRows += rows.length;
      if (/FROM chat_messages\b/i.test(query) && !/COUNT\(\*\)/i.test(query)) stats.messageScans++;
      return { ...cursor, toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
    get databaseSize() {
      return sql.databaseSize;
    },
  } as unknown as SqlStorage;
  return { sql: wrapped, stats };
}

describe('archive write-generation fence', () => {
  it('counts only real changes to hashed rows of a fenced, unflipped session', async () => {
    const { db, sql } = makeSql();
    try {
      seedSession(sql, 's1', 4);
      seedSession(sql, 'other', 2);
      // No intent yet: writes are not counted.
      sql.exec(`UPDATE chat_sessions SET topic = 'renamed' WHERE id = 's1'`);
      expect(readArchiveWriteGeneration(sql, 's1')).toBe(0);

      await prepare(sql, 's1');
      const fenced = readArchiveWriteGeneration(sql, 's1');
      const bumps: Array<[string, () => void, number]> = [
        [
          'anchor column',
          () => sql.exec(`UPDATE chat_sessions SET topic = 'again' WHERE id = 's1'`),
          1,
        ],
        [
          'non-hashed column',
          () => sql.exec(`UPDATE chat_sessions SET archive_owner_name = 'x' WHERE id = 's1'`),
          0,
        ],
        [
          'same value',
          () => sql.exec(`UPDATE chat_sessions SET topic = 'again' WHERE id = 's1'`),
          0,
        ],
        [
          'message edit',
          () => sql.exec(`UPDATE chat_messages SET content = 'edited' WHERE id = 's1-m-000000'`),
          1,
        ],
        [
          'grouped insert',
          () =>
            sql.exec(
              `INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at) VALUES ('s1-late', 's1', 'assistant', 'late', 9999)`
            ),
          1,
        ],
        ['message delete', () => sql.exec(`DELETE FROM chat_messages WHERE id = 's1-m-000001'`), 1],
        [
          'other session',
          () => sql.exec(`UPDATE chat_sessions SET topic = 'unrelated' WHERE id = 'other'`),
          0,
        ],
      ];
      let expected = fenced;
      for (const [label, write, delta] of bumps) {
        write();
        expected += delta;
        expect({ label, generation: readArchiveWriteGeneration(sql, 's1') }).toEqual({
          label,
          generation: expected,
        });
      }
      expect(readArchiveWriteGeneration(sql, 'other')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('stops counting once the session flipped, so reclaim and copy-back writes do not move it', async () => {
    const { db, sql } = makeSql();
    try {
      seedSession(sql, 's2', 4);
      const prepared = await prepare(sql, 's2');
      markReadyToFlip(sql, 's2');
      const flipped = await flipArchiveSource(sql, flipInput('s2', prepared.terminalVersionSha256));
      expect('refused' in flipped).toBe(false);
      const after = readArchiveWriteGeneration(sql, 's2');
      sql.exec(`DELETE FROM chat_messages WHERE session_id = 's2'`);
      expect(readArchiveWriteGeneration(sql, 's2')).toBe(after);
    } finally {
      db.close();
    }
  });

  it('fails the prepare when the session is written between the fence and the end of the hash', async () => {
    const { db, sql } = makeSql();
    try {
      seedSession(sql, 's3', 6);
      const input = prepareInput('s3');
      const begun = beginArchiveSourcePrepare(sql, input, { estimateExceedsReservation: false });
      expect(begun.kind).toBe('proceed');
      if (begun.kind !== 'proceed') return;
      // The hash runs unlocked in production; a writer that bypasses the fence lands mid-hash.
      const terminalVersion = await computeTerminalVersion(sql, 's3', {
        hashPageRows: 2,
        yieldBetweenPages: async () => {
          sql.exec(`UPDATE chat_messages SET content = 'mid-hash' WHERE id = 's3-m-000005'`);
        },
      });
      expect(() => completeArchiveSourcePrepare(sql, input, begun, terminalVersion)).toThrow(
        expect.objectContaining({ reason: 'terminal_version_changed' })
      );
      // Control: the same phases with no interleaved write complete and record the generation.
      const { db: db2, sql: sql2 } = makeSql();
      try {
        seedSession(sql2, 's3', 6);
        const again = beginArchiveSourcePrepare(sql2, input, { estimateExceedsReservation: false });
        if (again.kind !== 'proceed') throw new Error('expected proceed');
        const version = await computeTerminalVersion(sql2, 's3', {
          hashPageRows: 2,
          yieldBetweenPages: async () => undefined,
        });
        const result = completeArchiveSourcePrepare(sql2, input, again, version);
        expect(result.terminalVersionSha256).toBe(version.sha256);
        const row = sql2
          .exec(
            `SELECT prepared_write_generation, terminal_components_json
             FROM project_data_archive_source_intents WHERE session_id = 's3'`
          )
          .toArray()[0];
        expect(row?.prepared_write_generation).toBe(again.generation);
        expect(JSON.parse(String(row?.terminal_components_json))).toMatchObject({
          groupedSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          commentThreads: 0,
        });
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });

  it('flips without reading the session, and refuses when a writer bypassed the transcript fence', async () => {
    const { db, sql } = makeSql();
    try {
      seedSession(sql, 'clean', 3_000);
      seedSession(sql, 'touched', 50);
      const cleanPrepared = await prepare(sql, 'clean');
      const touchedPrepared = await prepare(sql, 'touched');
      markReadyToFlip(sql, 'clean');
      markReadyToFlip(sql, 'touched');

      const recorder = recordReads(sql);
      const flipped = await flipArchiveSource(
        recorder.sql,
        flipInput('clean', cleanPrepared.terminalVersionSha256)
      );
      expect('refused' in flipped).toBe(false);
      // O(1) proof: no message scan, and no statement returned more than a handful of rows on a
      // 3,000-message session.
      expect(recorder.stats.messageScans).toBe(0);
      expect(recorder.stats.maxRows).toBeLessThanOrEqual(2);
      expect(
        sql
          .exec(
            `SELECT archive_state, archive_last_message_at FROM chat_sessions WHERE id = 'clean'`
          )
          .toArray()[0]
      ).toEqual({ archive_state: 'source_deleted', archive_last_message_at: 1100 + 2_999 });

      // An internal writer that does not check the source intent changes an anchor column.
      sql.exec(`UPDATE chat_sessions SET search_index_state = 'degraded' WHERE id = 'touched'`);
      const refused = await flipArchiveSource(
        sql,
        flipInput('touched', touchedPrepared.terminalVersionSha256)
      );
      expect(refused).toMatchObject({ refused: true, reason: 'terminal_version_changed' });
      expect(
        sql
          .exec(
            `SELECT state FROM project_data_archive_source_intents WHERE session_id = 'touched'`
          )
          .toArray()[0]?.state
      ).toBe('recovery_manifest_persisted');
    } finally {
      db.close();
    }
  });

  it('falls back to the whole recompute for an intent prepared before the fence existed', async () => {
    const { db, sql } = makeSql();
    try {
      seedSession(sql, 'legacy', 10);
      const prepared = await prepare(sql, 'legacy');
      markReadyToFlip(sql, 'legacy');
      sql.exec(
        `UPDATE project_data_archive_source_intents
         SET prepared_write_generation = NULL, terminal_components_json = NULL
         WHERE session_id = 'legacy'`
      );
      const recorder = recordReads(sql);
      const flipped = await flipArchiveSource(
        recorder.sql,
        flipInput('legacy', prepared.terminalVersionSha256)
      );
      expect('refused' in flipped).toBe(false);
      expect(recorder.stats.messageScans).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('archive source token rotation on resume', () => {
  it("rejects the previous claim's token once a resumed claim reattaches its own", async () => {
    const { db, sql } = makeSql();
    try {
      seedSession(sql, 'tok', 6);
      await prepare(sql, 'tok');
      const exportInput = (sourceIntentToken: string) => ({
        ...prepareInput('tok'),
        sourceIntentToken,
        tableName: 'chat_messages' as const,
        ordinal: 0,
        cursor: null,
        maxRows: 3,
        maxBytes: 1_000_000,
      });
      // Before the resume, the original claim's token exports.
      await expect(exportArchiveChunk(sql, exportInput('token-tok'))).resolves.toMatchObject({
        rowCount: 3,
      });
      expect(
        reattachArchiveSourceToken(sql, {
          ...prepareInput('tok'),
          sourceIntentToken: 'token-resumed',
          now: NOW + 1,
        })
      ).toBe(true);
      await expect(exportArchiveChunk(sql, exportInput('token-tok'))).rejects.toMatchObject({
        reason: 'source_intent_mismatch',
      });
      await expect(exportArchiveChunk(sql, exportInput('token-resumed'))).resolves.toMatchObject({
        rowCount: 3,
      });
    } finally {
      db.close();
    }
  });
});

describe('archive write estimate above the former 100k-unit cap', () => {
  it('prices a session whose inventory exceeds 100k units instead of calling it unaffordable', () => {
    const { db, sql } = makeSql();
    try {
      expect(ARCHIVE_MAX_ESTIMATE_INVENTORY_UNITS).toBeGreaterThanOrEqual(1_000_000);
      seedSession(sql, 'big', 80_000, 8);
      const estimate = estimateArchiveWrites(sql, 'big', 2, ARCHIVE_MAX_ESTIMATE_INVENTORY_UNITS);
      expect(estimate).toBeLessThan(Number.MAX_SAFE_INTEGER);
      // 80k messages + 40k grouped rows (+ FTS byte units): above the old 100k cap.
      expect((estimate - ARCHIVE_WRITE_FIXED_RESERVATION) / 2).toBeGreaterThan(100_000);
      // The cap still short-circuits an inventory larger than it.
      expect(estimateArchiveWrites(sql, 'big', 2, 50_000)).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      db.close();
    }
  }, 60_000);
});

describe('root work at the 100k-message outer limit (local measurement, not a production bound)', () => {
  it('hashes in bounded pages and flips in O(1)', async () => {
    const { db, sql } = makeSql();
    try {
      const messages = 100_000;
      seedSession(sql, 'outer', messages, 512);
      const pageRows = 500;
      let pages = 0;
      let longestPageMs = 0;
      let pageStartedAt = performance.now();
      const startedAt = performance.now();
      const input = prepareInput('outer');
      const begun = beginArchiveSourcePrepare(sql, input, { estimateExceedsReservation: false });
      if (begun.kind !== 'proceed') throw new Error('expected proceed');
      const version = await computeTerminalVersion(sql, 'outer', {
        hashPageRows: pageRows,
        yieldBetweenPages: async () => {
          const now = performance.now();
          longestPageMs = Math.max(longestPageMs, now - pageStartedAt);
          pages++;
          pageStartedAt = now;
        },
      });
      completeArchiveSourcePrepare(sql, input, begun, version);
      const hashMs = performance.now() - startedAt;
      markReadyToFlip(sql, 'outer');
      const flipStartedAt = performance.now();
      const flipped = await flipArchiveSource(sql, flipInput('outer', version.sha256));
      const flipMs = performance.now() - flipStartedAt;
      const estimateStartedAt = performance.now();
      estimateArchiveWrites(sql, 'outer', 2, ARCHIVE_MAX_ESTIMATE_INVENTORY_UNITS);
      const estimateMs = performance.now() - estimateStartedAt;

      expect('refused' in flipped).toBe(false);
      // 100k messages + 50k grouped rows at 500 rows per page, plus the table boundaries.
      expect(pages).toBeGreaterThanOrEqual(300);
      const measurement =
        `[archive-outer-limit] ${messages} msgs (512 B bodies): hash ${hashMs.toFixed(0)} ms over ` +
        `${pages} yields, longest slice ${longestPageMs.toFixed(1)} ms; flip ${flipMs.toFixed(1)} ms; ` +
        `estimate ${estimateMs.toFixed(0)} ms (better-sqlite3 + node:crypto, local)`;
      // The unit config drops console output; write the figure where a rollout can collect it.
      if (process.env.ARCHIVE_MEASUREMENT_FILE) {
        writeFileSync(process.env.ARCHIVE_MEASUREMENT_FILE, `${measurement}\n`, { flag: 'a' });
      }
    } finally {
      db.close();
    }
  }, 120_000);
});
