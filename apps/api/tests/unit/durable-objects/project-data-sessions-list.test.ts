import { describe, expect, it, vi } from 'vitest';

import { listSessions } from '../../../src/durable-objects/project-data/sessions';
import type { Env } from '../../../src/durable-objects/project-data/types';

type QueryRow = Record<string, unknown>;

/** A well-formed raw chat_sessions row (snake_case, matches the SELECT columns). */
function makeSessionRow(overrides: Partial<QueryRow> = {}): QueryRow {
  return {
    id: 'session-1',
    workspace_id: null,
    task_id: null,
    created_by_user_id: 'user-1',
    topic: 'A topic',
    status: 'active',
    message_count: 3,
    started_at: 1000,
    ended_at: null,
    created_at: 1000,
    updated_at: 2000,
    agent_completed_at: null,
    ...overrides,
  };
}

/**
 * Fake SqlStorage that dispatches by SQL text:
 *  - COUNT(*)                    -> [{ cnt }]
 *  - FROM chat_sessions ...      -> the provided session rows
 *  - session_attention_markers   -> [] (no active attention marker)
 */
function makeSql(sessionRows: QueryRow[], total: number) {
  const exec = vi.fn((sql: string) => {
    if (sql.includes('COUNT(*)')) {
      return { toArray: () => [{ cnt: total }] };
    }
    if (sql.includes('session_attention_markers')) {
      return { toArray: () => [] };
    }
    if (sql.includes('FROM chat_sessions')) {
      return { toArray: () => sessionRows };
    }
    return { toArray: () => [] };
  });
  return { exec } as unknown as Parameters<typeof listSessions>[0] & {
    exec: ReturnType<typeof vi.fn>;
  };
}

const env = {} as Env;

describe('ProjectData listSessions resilience', () => {
  it('returns all sessions and hasMore=false on the happy path', () => {
    const rows = [
      makeSessionRow({ id: 's1', updated_at: 3000 }),
      makeSessionRow({ id: 's2', updated_at: 2000 }),
    ];
    const sql = makeSql(rows, 2);

    const result = listSessions(sql, env, null, 100, 0);

    expect(result.total).toBe(2);
    expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.hasMore).toBe(false);
  });

  // REGRESSION: this is the production INTERNAL_ERROR. A single malformed row
  // (e.g. a legacy row with a NULL in a NOT-NULL-typed field) previously threw
  // out of `parseChatSessionListRow` and 500'd the whole list. It must now be
  // skipped, not fatal. This test FAILS on pre-fix code (listSessions throws).
  it('skips a single malformed row instead of throwing INTERNAL_ERROR', () => {
    const good1 = makeSessionRow({ id: 'good-1', updated_at: 3000 });
    const bad = makeSessionRow({ id: 'bad-1', updated_at: 2500, started_at: null });
    const good2 = makeSessionRow({ id: 'good-2', updated_at: 2000 });
    const sql = makeSql([good1, bad, good2], 3);

    let result: ReturnType<typeof listSessions> | undefined;
    expect(() => {
      result = listSessions(sql, env, null, 100, 0);
    }).not.toThrow();

    expect(result!.sessions.map((s) => s.id)).toEqual(['good-1', 'good-2']);
    // total still reflects the COUNT(*) of all rows; only the bad row is dropped.
    expect(result!.total).toBe(3);
  });

  it('tolerates every row being malformed and returns an empty, non-throwing list', () => {
    const bad1 = makeSessionRow({ id: 'bad-1', message_count: null });
    const bad2 = makeSessionRow({ id: 'bad-2', started_at: null });
    const sql = makeSql([bad1, bad2], 2);

    const result = listSessions(sql, env, null, 100, 0);
    expect(result.sessions).toEqual([]);
  });

  it('signals hasMore=true when the offset window has not reached total', () => {
    const rows = [makeSessionRow({ id: 's1' }), makeSessionRow({ id: 's2' })];
    const sql = makeSql(rows, 50); // 50 total, only 2 fetched at offset 0

    const result = listSessions(sql, env, null, 2, 0);
    expect(result.hasMore).toBe(true);
  });

  it('trims and sets hasMore when the RPC size budget is exceeded', () => {
    // Tiny budget forces truncation after the first row.
    const budgetEnv = { SESSIONS_LIST_RPC_BUDGET_BYTES: '300' } as Env;
    const huge = 'x'.repeat(5000);
    const rows = [
      makeSessionRow({ id: 's1', topic: huge, updated_at: 3000 }),
      makeSessionRow({ id: 's2', topic: huge, updated_at: 2000 }),
      makeSessionRow({ id: 's3', topic: huge, updated_at: 1000 }),
    ];
    const sql = makeSql(rows, 3);

    const result = listSessions(sql, budgetEnv, null, 100, 0);

    // At least the first row is always returned; the rest are trimmed.
    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    expect(result.sessions.length).toBeLessThan(3);
    expect(result.hasMore).toBe(true);
  });
});
