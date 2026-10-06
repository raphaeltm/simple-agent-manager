/**
 * Bounded ProjectData message search (`message-search.ts`), in the workerd runtime against real
 * Durable Object SQLite and a real FTS5 index.
 *
 * The defect this guards: on the SAM root object a project-wide search full-scanned
 * `chat_messages` (7.4 M rows) in the keyword fallback and scored every FTS match, burning the
 * 30 s CPU allowance and queuing every other request behind it (2026-09-18..24). No harness here
 * enforces the CPU limit (`apps/api/.claude/rules/69`), so the discriminating assertions measure
 * the SHAPE that prevents it — SQLite rows read by one search — and the coverage disclosure a
 * consumer relies on to know the result is partial.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createRowMeteredSqlStorage } from '../../src/durable-objects/project-data/alarm-sections';
import { materializeSession } from '../../src/durable-objects/project-data/materialization';
import {
  DEFAULT_PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT,
  DEFAULT_PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT,
  type MessageSearchBounds,
  searchMessagesWithCoverage,
} from '../../src/durable-objects/project-data/message-search';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const WIDE: MessageSearchBounds = {
  ftsCandidateLimit: 10_000,
  ftsScanLimit: 10_000,
  keywordScanRowLimit: 1_000_000,
};

function freshStub(): DurableObjectStub<ProjectDataTestDouble> {
  const projectId = `bounded-search-${crypto.randomUUID()}`;
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

let clock = 1_700_000_000_000;
function nextTime(): number {
  clock += 1_000;
  return clock;
}

function insertSession(sql: SqlStorage, id: string, status = 'active'): void {
  const now = nextTime();
  sql.exec(
    `INSERT INTO chat_sessions (id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
    id,
    `topic ${id}`,
    status,
    now,
    now,
    now
  );
}

let sequence = 0;
function insertMessage(sql: SqlStorage, sessionId: string, role: string, content: string): void {
  sql.exec(
    `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    crypto.randomUUID(),
    sessionId,
    role,
    content,
    nextTime(),
    ++sequence
  );
}

/** Indexed (grouped + full-text) rows written directly, so a test can hold thousands of them. */
function indexedRows(sql: SqlStorage, sessionId: string, count: number, text: string): void {
  for (let i = 0; i < count; i++) {
    sql.exec(
      `INSERT INTO chat_messages_grouped (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
      crypto.randomUUID(),
      sessionId,
      `${text} ${i}`,
      nextTime()
    );
  }
}

function rebuildFullTextIndex(sql: SqlStorage): void {
  sql.exec(`INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts) VALUES('rebuild')`);
}

function fillerRows(sql: SqlStorage, sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) insertMessage(sql, sessionId, 'user', `routine update ${i}`);
}

/** Runs one search against the object's real SQLite and counts every row it read. */
function meteredSearch(
  sql: SqlStorage,
  query: string,
  sessionId: string | null,
  bounds: MessageSearchBounds,
  limit = 10
) {
  const { sql: metered, meter } = createRowMeteredSqlStorage(sql);
  meter.begin();
  const search = searchMessagesWithCoverage(metered, query, sessionId, ['user'], limit, bounds);
  return { ...search, rowsRead: meter.end().rowsRead };
}

describe('bounded ProjectData message search', () => {
  it('keyword fallback reads only its window, however large the table is', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'live');
      // An unindexed (never materialized) session: every row is a keyword-fallback candidate.
      insertMessage(sql, 'live', 'user', 'the deploy needle is here');
      fillerRows(sql, 'live', 3_000);

      const bounded = meteredSearch(sql, 'needle', null, {
        ...WIDE,
        keywordScanRowLimit: 200,
      });
      const unbounded = meteredSearch(sql, 'needle', null, WIDE);

      // The only match is older than the newest 200 rows: not found, and disclosed as such.
      expect(bounded.results).toEqual([]);
      expect(bounded.coverage).toMatchObject({
        keywordFallbackRan: true,
        keywordScanTruncated: true,
        keywordScanRowLimit: 200,
      });
      // The shape that keeps CPU bounded: a few hundred rows, not the table.
      expect(bounded.rowsRead).toBeLessThan(1_000);
      // Control: the same search without a window reads the whole table and finds the needle.
      expect(unbounded.rowsRead).toBeGreaterThan(3_000);
      expect(unbounded.results.map((r) => r.snippet)).toEqual(['the deploy needle is here']);
      expect(unbounded.coverage.keywordScanTruncated).toBe(false);
    });
  });

  it('keyword fallback finds recent unindexed text inside the window', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'live');
      fillerRows(sql, 'live', 500);
      insertMessage(sql, 'live', 'user', 'fresh needle from the active turn');

      const search = meteredSearch(sql, 'needle', null, { ...WIDE, keywordScanRowLimit: 50 });

      expect(search.results.map((r) => r.snippet)).toEqual(['fresh needle from the active turn']);
      expect(search.coverage.keywordScanTruncated).toBe(true);
    });
  });

  it('session-scoped keyword fallback windows that session, not the project', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'target');
      insertSession(sql, 'noisy');
      insertMessage(sql, 'target', 'user', 'target needle');
      fillerRows(sql, 'target', 20);
      // Newer rows from another session must not push the target's rows out of its own window.
      fillerRows(sql, 'noisy', 2_000);

      const inWindow = meteredSearch(sql, 'needle', 'target', { ...WIDE, keywordScanRowLimit: 50 });
      const pastWindow = meteredSearch(sql, 'needle', 'target', {
        ...WIDE,
        keywordScanRowLimit: 10,
      });

      expect(inWindow.results.map((r) => r.snippet)).toEqual(['target needle']);
      expect(inWindow.coverage.keywordScanTruncated).toBe(false);
      expect(inWindow.rowsRead).toBeLessThan(500);
      expect(pastWindow.results).toEqual([]);
      expect(pastWindow.coverage.keywordScanTruncated).toBe(true);
    });
  });

  it('ranks only the newest full-text matches and says so', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < 6; i++) {
        const id = `indexed-${i}`;
        insertSession(sql, id);
        insertMessage(sql, id, 'user', `vestigial marker number ${i}`);
        sql.exec(`UPDATE chat_sessions SET status = 'stopped' WHERE id = ?`, id);
        materializeSession(sql, id);
      }

      const windowed = meteredSearch(sql, 'vestigial', null, { ...WIDE, ftsCandidateLimit: 3 });
      const complete = meteredSearch(sql, 'vestigial', null, WIDE);

      expect(windowed.results.map((r) => r.sessionId).sort()).toEqual([
        'indexed-3',
        'indexed-4',
        'indexed-5',
      ]);
      expect(windowed.coverage.ftsCandidatesTruncated).toBe(true);
      // Control: a window larger than the matches ranks all of them and reports no truncation.
      expect(complete.results).toHaveLength(6);
      expect(complete.coverage.ftsCandidatesTruncated).toBe(false);
    });
  });

  it('full-text search reads only its window, however many rows match', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'busy', 'stopped');
      indexedRows(sql, 'busy', 3_000, 'zymurgy note');
      rebuildFullTextIndex(sql);

      const bounded = meteredSearch(sql, 'zymurgy', null, { ...WIDE, ftsCandidateLimit: 50 });
      const unbounded = meteredSearch(sql, 'zymurgy', null, WIDE);

      expect(bounded.results).toHaveLength(10);
      expect(bounded.coverage).toMatchObject({
        ftsCandidatesTruncated: true,
        keywordFallbackRan: false,
      });
      // The shape that keeps CPU bounded: the window plus the rows returned, not every match.
      expect(bounded.rowsRead).toBeLessThan(500);
      // Control: a window as large as the match set reads every match.
      expect(unbounded.rowsRead).toBeGreaterThan(3_000);
      expect(unbounded.coverage.ftsCandidatesTruncated).toBe(false);
    });
  });

  it('a session-scoped full-text search walks the index once', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'target', 'stopped');
      insertSession(sql, 'busy', 'stopped');
      indexedRows(sql, 'target', 20, 'zymurgy target note');
      indexedRows(sql, 'busy', 3_000, 'zymurgy busy note');
      rebuildFullTextIndex(sql);

      const search = meteredSearch(sql, 'zymurgy', 'target', {
        ...WIDE,
        ftsCandidateLimit: 5,
        ftsScanLimit: 100,
      });

      expect(search.results).toHaveLength(5);
      expect(search.results.every((r) => r.sessionId === 'target')).toBe(true);
      expect(search.coverage.ftsCandidatesTruncated).toBe(true);
      // Reaching an old session's span steps over every newer match once (FTS5 cannot seek to a
      // rowid bound); scoring in that same scan means there is no second walk.
      expect(search.rowsRead).toBeGreaterThan(3_000);
      expect(search.rowsRead).toBeLessThan(4_000);
    });
  });

  it("a session-scoped full-text window counts that session's matches, not its neighbours'", async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'target');
      insertSession(sql, 'neighbour');
      // Interleave materialization passes so the neighbour's grouped rows sit inside the
      // target's rowid span, newer than most of the target's own matches.
      for (let round = 0; round < 4; round++) {
        insertMessage(sql, 'target', 'user', `quixotic target note ${round}`);
        materializeSession(sql, 'target');
        for (let n = 0; n < 5; n++) {
          insertMessage(sql, 'neighbour', 'user', `quixotic neighbour note ${round}-${n}`);
          materializeSession(sql, 'neighbour');
        }
      }
      insertMessage(sql, 'target', 'user', 'quixotic target note final');
      materializeSession(sql, 'target');

      const search = meteredSearch(sql, 'quixotic', 'target', {
        ...WIDE,
        ftsCandidateLimit: 3,
        ftsScanLimit: 100,
      });

      expect(search.results).toHaveLength(3);
      expect(search.results.every((r) => r.sessionId === 'target')).toBe(true);
      expect(search.coverage.ftsCandidatesTruncated).toBe(true);
    });
  });

  it('caps how far a session-scoped window may walk and discloses the cap', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      insertSession(sql, 'target');
      insertSession(sql, 'neighbour');
      insertMessage(sql, 'target', 'user', 'recondite target note old');
      materializeSession(sql, 'target');
      for (let n = 0; n < 30; n++) {
        insertMessage(sql, 'neighbour', 'user', `recondite neighbour note ${n}`);
        materializeSession(sql, 'neighbour');
      }
      insertMessage(sql, 'target', 'user', 'recondite target note new');
      materializeSession(sql, 'target');

      const capped = meteredSearch(sql, 'recondite', 'target', {
        ...WIDE,
        ftsCandidateLimit: 5,
        ftsScanLimit: 5,
      });
      const uncapped = meteredSearch(sql, 'recondite', 'target', {
        ...WIDE,
        ftsCandidateLimit: 5,
        ftsScanLimit: 100,
      });

      // Only the newest scanned entries were considered: the old target note is out of reach.
      expect(capped.results.map((r) => r.snippet)).toEqual(['recondite target note new']);
      expect(capped.coverage.ftsCandidatesTruncated).toBe(true);
      expect(uncapped.results.map((r) => r.snippet).sort()).toEqual([
        'recondite target note new',
        'recondite target note old',
      ]);
      expect(uncapped.coverage.ftsCandidatesTruncated).toBe(false);
    });
  });

  it('the RPC applies the configured default windows', async () => {
    const stub = freshStub();
    await stub.ensureProjectId(`bounded-search-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      insertSession(state.storage.sql, 'live');
      insertMessage(state.storage.sql, 'live', 'user', 'default window needle');
    });

    const search = await stub.searchMessagesWithCoverage('needle', null, ['user'], 10);

    expect(search.results.map((r) => r.snippet)).toEqual(['default window needle']);
    expect(search.coverage).toEqual({
      ftsCandidateLimit: DEFAULT_PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT,
      ftsCandidatesTruncated: false,
      keywordScanRowLimit: DEFAULT_PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT,
      keywordFallbackRan: true,
      keywordScanTruncated: false,
    });
    // The array-returning RPC every existing caller uses runs the same bounded search.
    expect(await stub.searchMessages('needle', null, ['user'], 10)).toEqual(search.results);
  });
});
