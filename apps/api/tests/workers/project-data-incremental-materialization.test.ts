/**
 * Incremental search materialization on sleep.
 *
 * These tests run in the workerd runtime against real Durable Object SQLite and
 * a real FTS5 index, and they drive the production entry points
 * (`sleepSession` / `wakeSession` / `stopSession`) rather than calling
 * `materializeSession` directly — the defect this feature exists to fix was a
 * transition that never reached the indexer, so a test that calls the indexer
 * cannot observe it (`.claude/rules/62`).
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
  totalRowsRead: () => number;
} {
  const cursors: Array<{ query: string; cursor: { rowsRead: number } }> = [];
  const proxy = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== 'exec') {
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (query: string, ...bindings: unknown[]) => {
        const cursor = target.exec(query, ...(bindings as never[]));
        cursors.push({ query: query.replace(/\s+/g, ' ').trim(), cursor });
        return cursor;
      };
    },
  });
  return {
    sql: proxy as SqlStorage,
    rowsReadMatching: (pattern) =>
      cursors.reduce((n, e) => (pattern.test(e.query) ? n + e.cursor.rowsRead : n), 0),
    totalRowsRead: () => cursors.reduce((n, e) => n + e.cursor.rowsRead, 0),
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
    expect(results.length).toBe(1);

    // The extension replaced its FTS entry rather than adding a second one.
    expect(await countFtsHits(stub, sessionId, 'analyze')).toBe(1);
    expect(await countFtsHits(stub, sessionId, 'Let')).toBe(1);
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

  it('is a no-op when a sleeping session is re-materialized with nothing new', async () => {
    const stub = getStub('project-incremental-idempotent');
    const sessionId = await stub.createSession('ws-incremental-5', 'Idempotent');

    await streamAssistant(stub, sessionId, ['Nothing ', 'chan', 'ges ', 'here.']);
    expect(await stub.sleepSession(sessionId)).toBe(true);

    const first = await readIndexState(stub, sessionId);
    const groupedBefore = await readGroupedRows(stub, sessionId);

    // Re-run the indexer with no new messages. It must not append, must not
    // duplicate the FTS entry, and must not move the watermark.
    await stub.materializeSession(sessionId);
    await stub.materializeSession(sessionId);

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
});

/**
 * Drive the real `sleepSession` transition with the object's own `SqlStorage`
 * instrumented, so the measurement covers the production path rather than a
 * direct call to the indexer.
 */
async function measureSleep(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string
): Promise<{ tokenScanRows: number; totalRows: number }> {
  return runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as { sql: SqlStorage };
    const original = holder.sql;
    const probe = createSqlProbe(original);
    holder.sql = probe.sql;
    try {
      const slept = await instance.sleepSession(sessionId);
      if (!slept) throw new Error('sleepSession did not transition the session');
    } finally {
      holder.sql = original;
    }
    return { tokenScanRows: probe.rowsReadMatching(TOKEN_SCAN), totalRows: probe.totalRowsRead() };
  });
}
