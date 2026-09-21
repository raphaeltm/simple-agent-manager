/**
 * Incremental search materialization on sleep.
 *
 * These tests run in the workerd runtime against real Durable Object SQLite and
 * a real FTS5 index. The claim "a sleep reaches the indexer" — the defect this
 * feature exists to fix — is proven ONLY through the production entry points
 * (`sleepSession` / `wakeSession` / `stopSession` / `failSession`), because a test
 * that calls the indexer cannot observe a transition that never reaches it
 * (`.claude/rules/62`).
 *
 * A few tests do call `materializeSession` directly. Each is asserting an
 * invariant of the pass itself — idempotency, replay safety, refusal of a pruned
 * session — rather than the wiring, and each still sets its state up through the
 * real transitions first.
 *
 * Every assistant fixture below splits its searchable word ACROSS token rows
 * ("vest" + "igial"), exactly as streaming does in production. No raw
 * `chat_messages` row contains the whole word, so a hit can only come from the
 * grouped/FTS index — which is what makes these assertions discriminating
 * rather than accidentally satisfied by the raw-message LIKE fallback.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runProjectDataGroupedFtsCleanup } from '../../src/durable-objects/project-data/grouped-fts-cleanup';
import { resolveStorageSafetyConfig } from '../../src/durable-objects/project-data/storage-safety';
import type { Env as WorkerEnv } from '../../src/env';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

/** Stream `content` one character-run at a time, the way the VM agent does. */
async function streamAssistant(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string,
  chunks: string[]
): Promise<void> {
  for (const chunk of chunks) {
    await stub.persistMessage(sessionId, 'assistant', chunk, null);
  }
}

type SessionIndexRow = {
  status: string;
  materialized_at: number | null;
  search_index_state: string | null;
  materialized_through_created_at: number | null;
  materialized_through_sequence: number | null;
};

async function readIndexState(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string
): Promise<SessionIndexRow> {
  return runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql
      .exec(
        `SELECT status, materialized_at, search_index_state,
                materialized_through_created_at, materialized_through_sequence
         FROM chat_sessions WHERE id = ?`,
        sessionId
      )
      .toArray()[0] as SessionIndexRow;
  });
}

async function readGroupedRows(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string
): Promise<Array<{ id: string; role: string; content: string }>> {
  return runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql
      .exec(
        `SELECT id, role, content FROM chat_messages_grouped
         WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
        sessionId
      )
      .toArray() as Array<{ id: string; role: string; content: string }>;
  });
}

/** How many FTS index entries currently match `term` for this session. */
async function countFtsHits(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string,
  term: string
): Promise<number> {
  return runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql
      .exec(
        `SELECT COUNT(*) AS count
         FROM chat_messages_grouped_fts f
         JOIN chat_messages_grouped g ON g.rowid = f.rowid
         WHERE f.chat_messages_grouped_fts MATCH ? AND g.session_id = ?`,
        term,
        sessionId
      )
      .toArray()[0] as { count: number };
    return row.count;
  });
}

/**
 * Wrap the Durable Object's own `SqlStorage` so a real transition can be
 * measured. Cursors are returned untouched and their `rowsRead` is summed after
 * the operation completes, so production code consumes them exactly as it
 * normally would.
 */
function createSqlProbe(real: SqlStorage): {
  sql: SqlStorage;
  rowsReadMatching: (pattern: RegExp) => number;
  maxRowsReadByOneStatement: (pattern: RegExp) => number;
  maxRowsMaterializedByOneStatement: (pattern: RegExp) => number;
  totalRowsRead: () => number;
  totalRowsWritten: () => number;
} {
  const cursors: Array<{
    query: string;
    cursor: { rowsRead: number; rowsWritten: number };
    materialized: number;
  }> = [];
  const proxy = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== 'exec') {
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (query: string, ...bindings: unknown[]) => {
        const cursor = target.exec(query, ...(bindings as never[]));
        const entry = { query: query.replace(/\s+/g, ' ').trim(), cursor, materialized: 0 };
        cursors.push(entry);
        // `toArray()` is what allocates, so it is the honest measure of how many
        // rows a statement puts in the isolate's heap at once.
        return new Proxy(cursor, {
          get(cursorTarget, cursorProp) {
            const cursorValue = Reflect.get(cursorTarget, cursorProp) as unknown;
            if (cursorProp !== 'toArray') {
              return typeof cursorValue === 'function'
                ? (cursorValue as () => unknown).bind(cursorTarget)
                : cursorValue;
            }
            return () => {
              const rows = cursorTarget.toArray();
              entry.materialized = Math.max(entry.materialized, rows.length);
              return rows;
            };
          },
        });
      };
    },
  });
  return {
    sql: proxy as SqlStorage,
    rowsReadMatching: (pattern) =>
      cursors.reduce((n, e) => (pattern.test(e.query) ? n + e.cursor.rowsRead : n), 0),
    maxRowsReadByOneStatement: (pattern) =>
      cursors.reduce((n, e) => (pattern.test(e.query) ? Math.max(n, e.cursor.rowsRead) : n), 0),
    maxRowsMaterializedByOneStatement: (pattern) =>
      cursors.reduce((n, e) => (pattern.test(e.query) ? Math.max(n, e.materialized) : n), 0),
    totalRowsRead: () => cursors.reduce((n, e) => n + e.cursor.rowsRead, 0),
    totalRowsWritten: () => cursors.reduce((n, e) => n + e.cursor.rowsWritten, 0),
  };
}

/** The incremental token scan in `materialization.ts`, matched on its projection. */
const TOKEN_SCAN = /SELECT id, role, content, created_at, sequence FROM chat_messages/;

describe('incremental materialization on sleep', () => {
  it('indexes a sleeping session, and indexes the tail written after it wakes', async () => {
    const stub = getStub('project-incremental-sleep-wake-sleep');
    const sessionId = await stub.createSession('ws-incremental-1', 'Sleep wake sleep');

    // --- First half of the conversation, then sleep -------------------------
    await stub.persistMessage(sessionId, 'user', 'What did the old handler do?', null);
    await streamAssistant(stub, sessionId, ['It kept a ', 'vest', 'igial ', 'branch alive.']);

    // Pre-condition: the word exists in no single raw row, so search cannot
    // find it yet. This is the reproduced production symptom.
    expect(await stub.searchMessages('vestigial', sessionId, ['assistant'])).toEqual([]);

    expect(await stub.sleepSession(sessionId)).toBe(true);

    const afterFirstSleep = await stub.searchMessages('vestigial', sessionId, ['assistant']);
    expect(afterFirstSleep.length).toBeGreaterThanOrEqual(1);
    expect(afterFirstSleep[0]!.role).toBe('assistant');

    // --- Wake, write more, sleep again --------------------------------------
    expect(await stub.wakeSession(sessionId, 'ws-incremental-1', 'task-incremental-1')).toBe(true);
    await stub.persistMessage(sessionId, 'user', 'And after the rewrite?', null);
    await streamAssistant(stub, sessionId, ['Now it is ', 'crom', 'ulent ', 'and indexed.']);

    expect(await stub.sleepSession(sessionId)).toBe(true);

    // THE load-bearing assertion: text written after the first sleep is
    // searchable. A `materialized_at IS NOT NULL` early return loses this.
    const secondBatch = await stub.searchMessages('cromulent', sessionId, ['assistant']);
    expect(secondBatch.length).toBeGreaterThanOrEqual(1);
    expect(secondBatch[0]!.snippet).toContain('cromulent');

    // Liveness control: a passing result above must not mean materialization
    // became a no-op that silently dropped the first batch.
    const firstBatch = await stub.searchMessages('vestigial', sessionId, ['assistant']);
    expect(firstBatch.length).toBeGreaterThanOrEqual(1);
    expect(firstBatch[0]!.snippet).toContain('vestigial');

    // A sleeping session is indexed but not finished.
    const state = await readIndexState(stub, sessionId);
    expect(state.status).toBe('sleeping');
    expect(state.search_index_state).toBe('partial');
    expect(state.materialized_through_created_at).not.toBeNull();
    expect(state.materialized_through_sequence).not.toBeNull();
  });

  it('final stop still captures everything written after the last sleep', async () => {
    const stub = getStub('project-incremental-stop-tail');
    const sessionId = await stub.createSession('ws-incremental-2', 'Stop tail');

    await streamAssistant(stub, sessionId, ['Sleeping with ', 'quix', 'otic ', 'plans.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    expect(await stub.wakeSession(sessionId, 'ws-incremental-2', 'task-incremental-2')).toBe(true);
    await stub.persistMessage(sessionId, 'user', 'Wrap up please', null);
    await streamAssistant(stub, sessionId, ['Final ', 'zephy', 'rous ', 'summary.']);

    expect(await stub.stopSession(sessionId)).toBe(true);

    const tail = await stub.searchMessages('zephyrous', sessionId, ['assistant']);
    expect(tail.length).toBeGreaterThanOrEqual(1);
    // Control: the pre-sleep half is still there.
    expect((await stub.searchMessages('quixotic', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);

    const state = await readIndexState(stub, sessionId);
    expect(state.status).toBe('stopped');
    expect(state.search_index_state).toBe('complete');
  });

  it('extends the trailing run instead of splitting a word across a sleep boundary', async () => {
    const stub = getStub('project-incremental-boundary');
    const sessionId = await stub.createSession('ws-incremental-3', 'Boundary run');

    // The sleep lands mid-word, mid-assistant-run.
    await streamAssistant(stub, sessionId, ['Let me ana']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    expect(await stub.wakeSession(sessionId, 'ws-incremental-3', 'task-incremental-3')).toBe(true);
    await streamAssistant(stub, sessionId, ['lyze the ', 'code now.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.content).toBe('Let me analyze the code now.');

    // The word only exists once the two halves are joined, so an FTS hit is
    // proof the boundary run was merged rather than split into two rows.
    const results = await stub.searchMessages('analyze the code', sessionId, ['assistant']);
    expect(results).toHaveLength(1);

    // The extension replaced its FTS entry rather than adding a second one.
    expect(await countFtsHits(stub, sessionId, 'analyze')).toBe(1);
    expect(await countFtsHits(stub, sessionId, 'Let')).toBe(1);
  });

  it('keeps system-origin messages out of the index across a sleep boundary', async () => {
    const stub = getStub('project-incremental-system-origin');
    const sessionId = await stub.createSession('ws-incremental-sys', 'System origin');

    await streamAssistant(stub, sessionId, ['Before the ', 'sys']);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-sys', 'task-sys')).toBe(true);

    // Injected context arrives mid-run. It must not be indexed, and it must not
    // break the run it lands inside — the grouped row has to read as if it were
    // never there.
    await stub.persistMessageBatch(sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'quarantined injected sentinel',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
        origin: 'system',
      },
    ]);
    await streamAssistant(stub, sessionId, ['tem ', 'message.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.role).toBe('assistant');
    expect(grouped[0]!.content).toBe('Before the system message.');

    // The system message is invisible to search on both halves of the search path.
    expect(await stub.searchMessages('quarantined injected sentinel', sessionId)).toEqual([]);
    // Liveness control: the surrounding run IS searchable, so the empty result
    // above cannot mean the session was never indexed at all.
    expect((await stub.searchMessages('system message', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('does not start a new grouped row when the role changes across the boundary', async () => {
    const stub = getStub('project-incremental-boundary-role');
    const sessionId = await stub.createSession('ws-incremental-4', 'Role change boundary');

    await streamAssistant(stub, sessionId, ['Assistant half.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-4', 'task-incremental-4')).toBe(true);
    await stub.persistMessage(sessionId, 'user', 'A user turn.', null);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped.map((row) => row.role)).toEqual(['assistant', 'user']);
    expect(grouped[0]!.content).toBe('Assistant half.');
    expect(grouped[1]!.content).toBe('A user turn.');
  });

  it('groups tool and thinking runs across a sleep boundary, not just assistant', async () => {
    const stub = getStub('project-incremental-roles');
    const sessionId = await stub.createSession('ws-incremental-roles', 'Groupable roles');

    await stub.persistMessage(sessionId, 'thinking', 'Considering the ', null);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-roles', 'task-roles')).toBe(true);
    await stub.persistMessage(sessionId, 'thinking', 'recondite option.', null);
    await stub.persistMessage(sessionId, 'tool', 'Read(sub', null);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-roles', 'task-roles')).toBe(true);
    await stub.persistMessage(sessionId, 'tool', 'terranean.md)', null);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    // Both groupable non-assistant roles must merge across their boundaries, or a
    // word split by streaming stays split in the index for those roles only.
    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped.map((row) => row.role)).toEqual(['thinking', 'tool']);
    expect(grouped[0]!.content).toBe('Considering the recondite option.');
    expect(grouped[1]!.content).toBe('Read(subterranean.md)');
    expect((await stub.searchMessages('recondite', sessionId, ['thinking'])).length)
      .toBeGreaterThanOrEqual(1);
    expect((await stub.searchMessages('subterranean', sessionId, ['tool'])).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('indexes the tail when a session fails rather than stops', async () => {
    const stub = getStub('project-incremental-fail');
    const sessionId = await stub.createSession('ws-incremental-fail', 'Failed session');

    await streamAssistant(stub, sessionId, ['Before ', 'the ', 'deba', 'cle.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-fail', 'task-fail')).toBe(true);
    await streamAssistant(stub, sessionId, ['Then the ', 'catastro', 'phe struck.']);

    expect(await stub.failSession(sessionId, 'agent crashed')).toBe(true);

    expect((await stub.searchMessages('catastrophe', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
    expect((await stub.searchMessages('debacle', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
    const state = await readIndexState(stub, sessionId);
    expect(state.status).toBe('failed');
    expect(state.search_index_state).toBe('complete');
  });

  it('marks an empty session complete only once it terminalizes', async () => {
    const stub = getStub('project-incremental-empty');
    const sessionId = await stub.createSession('ws-incremental-empty', 'Empty session');

    expect(await stub.sleepSession(sessionId)).toBe(true);
    // Nothing to index and nothing to record: a sleeping empty session is not
    // "complete", and writing state for it on every sleep would be pure churn.
    const sleeping = await readIndexState(stub, sessionId);
    expect(sleeping.search_index_state).toBeNull();
    expect(sleeping.materialized_at).toBeNull();

    expect(await stub.wakeSession(sessionId, 'ws-incremental-empty', 'task-empty')).toBe(true);
    expect(await stub.stopSession(sessionId)).toBe(true);
    const stopped = await readIndexState(stub, sessionId);
    expect(stopped.search_index_state).toBe('complete');
    expect(stopped.materialized_at).not.toBeNull();
  });

  it('does not re-scan a large same-millisecond cluster below the watermark', async () => {
    const stub = getStub('project-incremental-same-ms');
    const sessionId = await stub.createSession('ws-incremental-ms', 'Same millisecond');

    // Every streaming token in one burst can share a `created_at`, and the scan's
    // index seek can only bound on `created_at` — the `sequence` term is a
    // residual filter. Force the collision the natural RPC-paced fixtures never
    // produce, so the "only re-filters the boundary millisecond" claim is checked.
    const CLUSTER = 200;
    const sharedTimestamp = new Date().toISOString();
    await stub.persistMessageBatch(
      sessionId,
      Array.from({ length: CLUSTER }, (_, i) => ({
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: `c${i} `,
        toolMetadata: null,
        timestamp: sharedTimestamp,
      }))
    );
    const firstPass = await measureSleep(stub, sessionId);
    expect(firstPass.tokenScanRows).toBeGreaterThanOrEqual(CLUSTER);

    expect(await stub.wakeSession(sessionId, 'ws-incremental-ms', 'task-ms')).toBe(true);
    await stub.persistMessage(sessionId, 'user', 'a later question', null);
    const secondPass = await measureSleep(stub, sessionId);

    // The second pass must not re-walk the cluster at all: the row-value seek
    // lands inside the shared millisecond rather than at the start of it. One new
    // message, so at most a couple of rows.
    expect(secondPass.tokenScanRows).toBeLessThanOrEqual(2);
    expect((await stub.searchMessages('a later question', sessionId, ['user'])).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('is a no-op when a sleeping session is re-materialized with nothing new', async () => {
    const stub = getStub('project-incremental-idempotent');
    const sessionId = await stub.createSession('ws-incremental-5', 'Idempotent');

    await streamAssistant(stub, sessionId, ['Nothing ', 'chan', 'ges ', 'here.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const first = await readIndexState(stub, sessionId);
    const groupedBefore = await readGroupedRows(stub, sessionId);

    // Re-run the indexer with no new messages. Assert on WRITES, not on value
    // equality: a redundant `UPDATE ... SET materialized_at = ?` executed in the
    // same millisecond would leave every value identical and still be a write on
    // a path that runs on every sleep.
    const rowsWritten = await runInDurableObject(stub, async (instance) => {
      const holder = instance as unknown as { sql: SqlStorage };
      const originalSql = holder.sql;
      const probe = createSqlProbe(originalSql);
      holder.sql = probe.sql;
      try {
        instance.materializeSession(sessionId);
        instance.materializeSession(sessionId);
      } finally {
        holder.sql = originalSql;
      }
      return probe.totalRowsWritten();
    });
    expect(rowsWritten).toBe(0);

    const groupedAfter = await readGroupedRows(stub, sessionId);
    expect(groupedAfter).toEqual(groupedBefore);
    expect(await countFtsHits(stub, sessionId, 'changes')).toBe(1);

    const second = await readIndexState(stub, sessionId);
    expect(second.materialized_at).toBe(first.materialized_at);
    expect(second.materialized_through_created_at).toBe(first.materialized_through_created_at);
    expect(second.materialized_through_sequence).toBe(first.materialized_through_sequence);
  });

  it('does not double-index when a pass replays groups that already exist', async () => {
    const stub = getStub('project-incremental-replay');
    const sessionId = await stub.createSession('ws-incremental-replay', 'Replayed pass');

    await stub.persistMessage(sessionId, 'user', 'indexed question', null);
    await streamAssistant(stub, sessionId, ['Reply with ', 'palin', 'drome ', 'text.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    // Both watermark sources cleared while the grouped rows survive — the shape
    // an interrupted prune or a half-applied backfill leaves behind. The next
    // pass re-reads every token and re-derives groups that already exist.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE chat_sessions
         SET materialized_at = NULL,
             materialized_through_created_at = NULL,
             materialized_through_sequence = NULL
         WHERE id = ?`,
        sessionId
      );
    });

    await stub.materializeSession(sessionId);

    // The replay must leave the index intact: no duplicated grouped rows, no
    // duplicated search hits, and the original content unchanged.
    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(2);
    expect(grouped[1]!.content).toBe('Reply with palindrome text.');
    expect(await countFtsHits(stub, sessionId, 'palindrome')).toBe(1);
    expect(await stub.searchMessages('palindrome', sessionId, ['assistant'])).toHaveLength(1);
  });

  it('reads only the new tail on the second pass, not the whole session', async () => {
    const stub = getStub('project-incremental-rows-read');
    const sessionId = await stub.createSession('ws-incremental-6', 'Rows read');

    const FIRST_BATCH = 60;
    const SECOND_BATCH = 4;

    const firstChunks = Array.from({ length: FIRST_BATCH }, (_, i) => `a${i} `);
    await streamAssistant(stub, sessionId, firstChunks);

    const firstPass = await measureSleep(stub, sessionId);
    expect(firstPass.tokenScanRows).toBeGreaterThanOrEqual(FIRST_BATCH);

    expect(await stub.wakeSession(sessionId, 'ws-incremental-6', 'task-incremental-6')).toBe(true);
    await streamAssistant(
      stub,
      sessionId,
      Array.from({ length: SECOND_BATCH }, (_, i) => `b${i} `)
    );

    const secondPass = await measureSleep(stub, sessionId);

    // A full rebuild would re-read all 64 tokens. Incremental reads ~4.
    expect(secondPass.tokenScanRows).toBeLessThanOrEqual(SECOND_BATCH + 1);
    expect(secondPass.tokenScanRows).toBeLessThan(firstPass.tokenScanRows);
    // Nothing else in the sleep path compensates by scanning the session either.
    expect(secondPass.totalRows).toBeLessThan(FIRST_BATCH);

    // And the index is still correct after the cheap pass.
    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.content).toContain('a0 ');
    expect(grouped[0]!.content).toContain(`b${SECOND_BATCH - 1} `);
  });

  it('never materializes more than one page of tokens per statement', async () => {
    const stub = getStub('project-incremental-paging');
    const sessionId = await stub.createSession('ws-incremental-page', 'Paged pass');

    // 2N+1 so the run covers full pages plus a remainder: an off-by-one cannot
    // pass by landing on a clean page boundary (rule 69).
    const PAGE_ROWS = 50;
    const TOKEN_COUNT = PAGE_ROWS * 2 + 1;
    await streamAssistant(
      stub,
      sessionId,
      Array.from({ length: TOKEN_COUNT }, (_, i) => `p${i} `)
    );

    const measured = await measureSleep(stub, sessionId, {
      PROJECT_DATA_MATERIALIZATION_PAGE_ROWS: String(PAGE_ROWS),
    });

    // The Durable Object isolate memory ceiling has no test harness, so the guard
    // is proven by the shape that prevents the reset: no single statement pulls
    // more than a page into memory. The one-shot implementation reads all 101.
    expect(measured.largestTokenPage).toBeLessThanOrEqual(PAGE_ROWS);
    // SQLite reads one row past a satisfied LIMIT to learn the scan is done, so
    // the billed read is bounded at page + 1 rather than at page.
    expect(measured.largestTokenPageRead).toBeLessThanOrEqual(PAGE_ROWS + 1);
    expect(measured.tokenScanRows).toBeGreaterThanOrEqual(TOKEN_COUNT);

    // Paged output must equal what a single pass would have produced: one grouped
    // row whose content is every token concatenated in order.
    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.content).toBe(
      Array.from({ length: TOKEN_COUNT }, (_, i) => `p${i} `).join('')
    );
    expect((await stub.searchMessages(`p${TOKEN_COUNT - 1}`, sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);

    const state = await readIndexState(stub, sessionId);
    expect(state.search_index_state).toBe('partial');
  });

  it('starts a new grouped row instead of rewriting a run past the size cap', async () => {
    const stub = getStub('project-incremental-group-cap');
    const sessionId = await stub.createSession('ws-incremental-cap', 'Group size cap');

    await streamAssistant(stub, sessionId, ['x'.repeat(40), ' oversize ']);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-cap', 'task-cap')).toBe(true);
    await streamAssistant(stub, sessionId, ['continuation ', 'after the cap.']);

    // The trailing row is already past the cap, so the continuation must not
    // rewrite it — extending would cost O(accumulated size) on every later pass.
    await measureSleep(stub, sessionId, {
      PROJECT_DATA_MATERIALIZATION_MAX_GROUP_CHARS: '10',
    });

    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.content).toBe(`${'x'.repeat(40)} oversize `);
    expect(grouped[1]!.content).toBe('continuation after the cap.');
    expect(grouped.every((row) => row.role === 'assistant')).toBe(true);

    // Both rows are still indexed — capping must not drop content from search.
    expect((await stub.searchMessages('oversize', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
    expect((await stub.searchMessages('continuation after', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('defers the remainder when a pass hits its row budget, and resumes on the next pass', async () => {
    const stub = getStub('project-incremental-budget');
    const sessionId = await stub.createSession('ws-incremental-budget', 'Budgeted pass');

    await stub.persistMessage(sessionId, 'user', 'first budgeted question', null);
    await stub.persistMessage(sessionId, 'user', 'second budgeted question', null);
    await stub.persistMessage(sessionId, 'user', 'third budgeted question', null);

    // Budget of 2 leaves the third message unindexed.
    await measureSleep(stub, sessionId, {
      PROJECT_DATA_MATERIALIZATION_MAX_ROWS_PER_PASS: '2',
      PROJECT_DATA_MATERIALIZATION_PAGE_ROWS: '2',
    });

    expect(await readGroupedRows(stub, sessionId)).toHaveLength(2);
    expect((await readIndexState(stub, sessionId)).search_index_state).toBe('partial');

    // A truncated pass must not claim 'complete' even once the session terminalizes,
    // or the sweep would stop selecting a session that still has unindexed messages.
    expect(await stub.wakeSession(sessionId, 'ws-incremental-budget', 'task-budget')).toBe(true);
    await runInDurableObject(stub, async (instance) => {
      const holder = instance as unknown as { env: Record<string, unknown> };
      const originalEnv = holder.env;
      holder.env = { ...originalEnv, PROJECT_DATA_MATERIALIZATION_MAX_ROWS_PER_PASS: '1' };
      try {
        await instance.stopSession(sessionId);
      } finally {
        holder.env = originalEnv;
      }
    });
    expect((await readIndexState(stub, sessionId)).search_index_state).toBe('partial');

    // The next unbudgeted pass drains the remainder and promotes to complete.
    await stub.materializeSession(sessionId);
    expect(await readGroupedRows(stub, sessionId)).toHaveLength(3);
    expect((await readIndexState(stub, sessionId)).search_index_state).toBe('complete');
    expect((await stub.searchMessages('third budgeted', sessionId, ['user'])).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('treats a pre-watermark session as indexed through materialized_at', async () => {
    const stub = getStub('project-incremental-legacy-watermark');
    const sessionId = await stub.createSession('ws-incremental-7', 'Legacy watermark');

    await streamAssistant(stub, sessionId, ['Legacy ', 'oblig', 'ato ', 'content.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    // Reproduce a row written by the pre-watermark implementation (and the shape
    // an archive rehome produces, since the anchor columns carry
    // `materialized_at` but not the watermark).
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE chat_sessions
         SET materialized_through_created_at = NULL,
             materialized_through_sequence = NULL
         WHERE id = ?`,
        sessionId
      );
    });

    expect(await stub.wakeSession(sessionId, 'ws-incremental-7', 'task-incremental-7')).toBe(true);
    await streamAssistant(stub, sessionId, [' Plus ', 'fungi', 'ble ', 'tail.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    // The legacy half must not be re-appended (which would double its text) and
    // the new tail must be indexed.
    const grouped = await readGroupedRows(stub, sessionId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.content).toBe('Legacy obligato content. Plus fungible tail.');
    expect(await countFtsHits(stub, sessionId, 'obligato')).toBe(1);
    expect((await stub.searchMessages('fungible', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('keeps a batch that landed below the watermark findable through the fallback', async () => {
    const stub = getStub('project-incremental-late-batch');
    const sessionId = await stub.createSession('ws-incremental-late', 'Late batch');

    await stub.persistMessage(sessionId, 'user', 'on time question', null);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const watermark = await readIndexState(stub, sessionId);
    expect(watermark.materialized_through_created_at).not.toBeNull();

    // The VM agent stamps `timestamp` when it GENERATES a message and retries
    // delivery for up to five minutes, while `sleepSession` runs before the
    // workspace is stopped. So a batch can land after the watermark with a
    // created_at below it — the indexed scan seeks past these rows.
    await stub.persistMessageBatch(sessionId, [
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'retrodated straggler message',
        toolMetadata: null,
        timestamp: new Date(watermark.materialized_through_created_at! - 60_000).toISOString(),
      },
    ]);

    // It is not in the FTS index, so the fallback is the only thing that can
    // return it. Losing it silently is the bug this whole feature exists to fix.
    const found = await stub.searchMessages('retrodated straggler', sessionId, ['user']);
    expect(found.length).toBeGreaterThanOrEqual(1);

    // Liveness control: the on-time message is still returned exactly once.
    expect(await stub.searchMessages('on time question', sessionId, ['user'])).toHaveLength(1);
  });

  it('keeps a woken session tail findable through the raw-message fallback', async () => {
    const stub = getStub('project-incremental-live-tail');
    const sessionId = await stub.createSession('ws-incremental-8', 'Live tail');

    await stub.persistMessage(sessionId, 'user', 'first indexed question', null);
    expect(await stub.sleepSession(sessionId)).toBe(true);
    expect(await stub.wakeSession(sessionId, 'ws-incremental-8', 'task-incremental-8')).toBe(true);

    // Written after the last sleep, so it is not in the FTS index yet. Stamping
    // `materialized_at` must not exclude it from the LIKE fallback.
    await stub.persistMessage(sessionId, 'user', 'unindexed follow-up question', null);

    const tail = await stub.searchMessages('unindexed follow-up', sessionId, ['user']);
    expect(tail.length).toBeGreaterThanOrEqual(1);

    // Control: the already-indexed message is returned exactly once, not twice
    // by both halves of the search.
    const indexed = await stub.searchMessages('first indexed question', sessionId, ['user']);
    expect(indexed).toHaveLength(1);
  });
});

describe('incremental materialization and storage relief', () => {
  it('refuses to re-index a pruned session and leaves it LIKE-searchable', async () => {
    const projectId = 'project-incremental-pruned';
    await seedUser('incremental-owner');
    await seedInstallation('incremental-installation', 'incremental-owner');
    await seedProject(projectId, 'incremental-owner', 'incremental-installation', {
      name: 'Incremental pruning',
    });
    const stub = getStub(projectId);

    const sessionId = await stub.createSession('ws-incremental-9', 'Pruned session');
    await stub.persistMessage(sessionId, 'user', 'prunable sentinel phrase', null);
    await streamAssistant(stub, sessionId, ['Also ', 'prun', 'able ', 'assistant text.']);
    expect(await stub.stopSession(sessionId)).toBe(true);

    const before = await readIndexState(stub, sessionId);
    expect(before.materialized_through_created_at).not.toBeNull();

    // Age the session past the cleanup's minimum, then run the real pruner.
    const oldUpdatedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
        oldUpdatedAt,
        sessionId
      );
    });

    const cleanup = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      return runProjectDataGroupedFtsCleanup(
        state.storage.sql,
        testEnv,
        projectId,
        {
          ...resolveStorageSafetyConfig(testEnv),
          limitBytes: Math.ceil(state.storage.sql.databaseSize / 0.92),
          groupedFtsCleanupEnabled: true,
          groupedFtsCleanupTriggerRatio: 0.9,
          groupedFtsCleanupTargetRatio: 0.85,
          groupedFtsCleanupBatchSessions: 5,
          groupedFtsCleanupBatchRows: 50,
          groupedFtsCleanupBatchBytes: 1_000_000,
          groupedFtsCleanupMinSessionAgeMs: 7 * 24 * 60 * 60 * 1000,
          groupedFtsCleanupWeakReclaimBytes: 0,
        },
        { allowStart: true }
      );
    });
    expect(cleanup?.groupedRowsDeleted).toBeGreaterThan(0);

    // The watermark must die with the rows it described, or the raw-message
    // fallback this session now depends on would skip it.
    const pruned = await readIndexState(stub, sessionId);
    expect(pruned.search_index_state).toBe('grouped_fts_pruned');
    expect(pruned.materialized_at).toBeNull();
    expect(pruned.materialized_through_created_at).toBeNull();
    expect(pruned.materialized_through_sequence).toBeNull();

    const fallback = await stub.searchMessages('prunable sentinel phrase', sessionId, ['user']);
    expect(fallback.length).toBeGreaterThanOrEqual(1);

    // Re-indexing would undo the reclaimed bytes, so the pass must refuse.
    await stub.materializeSession(sessionId);
    expect(await readGroupedRows(stub, sessionId)).toHaveLength(0);
    expect((await readIndexState(stub, sessionId)).search_index_state).toBe('grouped_fts_pruned');

    // The sweep must not re-select it either.
    const swept = await stub.materializePendingSessions();
    expect(swept.errors).toBe(0);
    expect(await readGroupedRows(stub, sessionId)).toHaveLength(0);

    // Defence in depth: with the refusal marker gone, a leftover watermark would
    // claim the deleted head rows were still indexed and re-group only the tail.
    // Because the pruner cleared it, a re-index rebuilds the whole session.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE chat_sessions SET search_index_state = NULL WHERE id = ?",
        sessionId
      );
    });
    await stub.materializeSession(sessionId);
    const rebuilt = await readGroupedRows(stub, sessionId);
    expect(rebuilt.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rebuilt[0]!.content).toBe('prunable sentinel phrase');
    expect(rebuilt[1]!.content).toBe('Also prunable assistant text.');
  });
});

describe('materializePendingSessions sweep', () => {
  it('selects sleeping sessions whose transcript outran their index', async () => {
    const stub = getStub('project-incremental-sweep');

    const sleeping = await stub.createSession('ws-sweep-1', 'Sleeping backlog');
    await streamAssistant(stub, sleeping, ['Backlogged ', 'perip', 'atetic ', 'notes.']);
    // Put it to sleep WITHOUT indexing, reproducing a session that was already
    // asleep when incremental materialization shipped.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE chat_sessions SET status = 'sleeping' WHERE id = ?",
        sleeping
      );
    });

    expect(await stub.searchMessages('peripatetic', sleeping, ['assistant'])).toEqual([]);

    const first = await stub.materializePendingSessions();
    expect(first.errors).toBe(0);
    expect(first.materialized).toBeGreaterThanOrEqual(1);
    expect((await stub.searchMessages('peripatetic', sleeping, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);

    // Second sweep: nothing is pending any more, so it must not re-select.
    const second = await stub.materializePendingSessions();
    expect(second.remaining).toBe(0);
    expect(second.materialized).toBe(0);
    expect(await countFtsHits(stub, sleeping, 'peripatetic')).toBe(1);
  });

  it('selects a partially-indexed session that has grown past its watermark', async () => {
    const stub = getStub('project-incremental-sweep-partial');

    const sessionId = await stub.createSession('ws-sweep-2', 'Partial backlog');
    await streamAssistant(stub, sessionId, ['Indexed ', 'antedi', 'luvian ', 'half.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const indexed = await readIndexState(stub, sessionId);
    expect(indexed.search_index_state).toBe('partial');
    expect(indexed.materialized_through_created_at).not.toBeNull();

    // Control: with a watermark and nothing past it, the sweep must NOT select it.
    expect((await stub.materializePendingSessions()).materialized).toBe(0);

    // Now grow the session past its watermark WITHOUT sleeping, so only the sweep
    // can index the tail. This is the branch where the sweep's predicate has to
    // agree with `resolveWatermark()` on the (created_at, sequence) tuple.
    expect(await stub.wakeSession(sessionId, 'ws-sweep-2', 'task-sweep-2')).toBe(true);
    await streamAssistant(stub, sessionId, ['Unindexed ', 'pusilla', 'nimous ', 'tail.']);

    const swept = await stub.materializePendingSessions();
    expect(swept.errors).toBe(0);
    expect(swept.materialized).toBeGreaterThanOrEqual(1);

    expect((await stub.searchMessages('pusillanimous', sessionId, ['assistant'])).length)
      .toBeGreaterThanOrEqual(1);
    // Liveness control: the first half is still indexed exactly once.
    expect(await countFtsHits(stub, sessionId, 'antediluvian')).toBe(1);
  });
});

/**
 * Drive the real `sleepSession` transition with the object's own `SqlStorage`
 * instrumented, so the measurement covers the production path rather than a
 * direct call to the indexer.
 */
async function measureSleep(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string,
  envOverrides: Record<string, string> = {}
): Promise<{
  tokenScanRows: number;
  largestTokenPage: number;
  largestTokenPageRead: number;
  totalRows: number;
}> {
  return runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as { sql: SqlStorage; env: Record<string, unknown> };
    const originalSql = holder.sql;
    const originalEnv = holder.env;
    const probe = createSqlProbe(originalSql);
    holder.sql = probe.sql;
    holder.env = { ...originalEnv, ...envOverrides };
    try {
      const slept = await instance.sleepSession(sessionId);
      if (!slept) throw new Error('sleepSession did not transition the session');
    } finally {
      holder.sql = originalSql;
      holder.env = originalEnv;
    }
    return {
      tokenScanRows: probe.rowsReadMatching(TOKEN_SCAN),
      largestTokenPage: probe.maxRowsMaterializedByOneStatement(TOKEN_SCAN),
      largestTokenPageRead: probe.maxRowsReadByOneStatement(TOKEN_SCAN),
      totalRows: probe.totalRowsRead(),
    };
  });
}
