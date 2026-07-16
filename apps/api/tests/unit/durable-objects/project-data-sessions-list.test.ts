import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSession,
  getSessionsByTaskIds,
  listSessions,
} from '../../../src/durable-objects/project-data/sessions';
import { log } from '../../../src/lib/logger';

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

describe('ProjectData listSessions resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all sessions and hasMore=false on the happy path', () => {
    const rows = [
      makeSessionRow({ id: 's1', updated_at: 3000 }),
      makeSessionRow({ id: 's2', updated_at: 2000 }),
    ];
    const sql = makeSql(rows, 2);

    const result = listSessions(sql, null, 100, 0);

    expect(result.total).toBe(2);
    expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.hasMore).toBe(false);
  });

  // REGRESSION: this is the production INTERNAL_ERROR. A single malformed row
  // (e.g. a legacy row that fails the valibot schema) previously threw out of
  // `parseChatSessionListRow` and 500'd the whole list. It must now be skipped,
  // not fatal. This test FAILS on pre-fix code (listSessions throws).
  it('skips a single malformed row instead of throwing INTERNAL_ERROR', () => {
    const good1 = makeSessionRow({ id: 'good-1', updated_at: 3000 });
    const bad = makeSessionRow({ id: 'bad-1', updated_at: 2500, started_at: null });
    const good2 = makeSessionRow({ id: 'good-2', updated_at: 2000 });
    const sql = makeSql([good1, bad, good2], 3);

    let result: ReturnType<typeof listSessions> | undefined;
    expect(() => {
      result = listSessions(sql, null, 100, 0);
    }).not.toThrow();

    expect(result!.sessions.map((s) => s.id)).toEqual(['good-1', 'good-2']);
    // total still reflects the COUNT(*) of all rows; only the bad row is dropped.
    expect(result!.total).toBe(3);
  });

  it('tolerates every row being malformed and returns an empty, non-throwing list', () => {
    const bad1 = makeSessionRow({ id: 'bad-1', message_count: null });
    const bad2 = makeSessionRow({ id: 'bad-2', started_at: null });
    const sql = makeSql([bad1, bad2], 2);

    const result = listSessions(sql, null, 100, 0);
    expect(result.sessions).toEqual([]);
  });

  it('signals hasMore=true when the offset window has not reached total', () => {
    const rows = [makeSessionRow({ id: 's1' }), makeSessionRow({ id: 's2' })];
    const sql = makeSql(rows, 50); // 50 total, only 2 fetched at offset 0

    const result = listSessions(sql, null, 2, 0);
    expect(result.hasMore).toBe(true);
  });

  // The skip log is the whole point of the fix — it surfaces the offending
  // field in production. Assert it fires with a diagnosable payload.
  it('logs sessions.list_row_skipped with the row id and error for a bad row', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sql = makeSql(
      [
        makeSessionRow({ id: 'good-1', updated_at: 3000 }),
        makeSessionRow({ id: 'bad-1', updated_at: 2000, started_at: null }),
      ],
      2
    );

    listSessions(sql, null, 100, 0);

    expect(warn).toHaveBeenCalledWith(
      'sessions.list_row_skipped',
      expect.objectContaining({ rowId: 'bad-1', error: expect.stringContaining('started_at') })
    );
    // And a degraded-summary log with the skipped count.
    expect(warn).toHaveBeenCalledWith(
      'sessions.list_degraded',
      expect.objectContaining({ skipped: 1, returned: 1, fetched: 2 })
    );
  });

  it('does not emit a degraded log on the clean happy path', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sql = makeSql([makeSessionRow({ id: 's1' })], 1);

    listSessions(sql, null, 100, 0);

    expect(warn).not.toHaveBeenCalledWith('sessions.list_degraded', expect.anything());
    expect(warn).not.toHaveBeenCalledWith('sessions.list_row_skipped', expect.anything());
  });
});

describe('ProjectData getSessionsByTaskIds resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // getSessionsByTaskIds routes through the same tolerant mapping helper as
  // listSessions. A malformed row must be skipped, not throw the whole lookup.
  it('skips a malformed row instead of throwing', () => {
    const rows = [
      makeSessionRow({ id: 'good-1', task_id: 't1' }),
      makeSessionRow({ id: 'bad-1', task_id: 't1', message_count: null }),
      makeSessionRow({ id: 'good-2', task_id: 't2' }),
    ];
    const sql = makeSql(rows, rows.length);

    let result: Record<string, unknown>[] | undefined;
    expect(() => {
      result = getSessionsByTaskIds(sql, ['t1', 't2']);
    }).not.toThrow();

    expect(result!.map((s) => s.id)).toEqual(['good-1', 'good-2']);
  });

  it('returns an empty array for no task ids without touching sql', () => {
    const sql = makeSql([], 0);
    expect(getSessionsByTaskIds(sql, [])).toEqual([]);
  });
});

describe('ProjectData getSession resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A malformed row must NOT 500 the hot single-session path (chat-state poll,
  // deep links, task repair). Degrade to null (caller returns 404) + log.
  it('returns null and logs instead of throwing for a malformed row', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sql = makeSql([makeSessionRow({ id: 'bad-1', message_count: null })], 1);

    let result: Record<string, unknown> | null | undefined;
    expect(() => {
      result = getSession(sql, 'bad-1');
    }).not.toThrow();

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'sessions.get_row_skipped',
      expect.objectContaining({ rowId: 'bad-1', error: expect.stringContaining('message_count') })
    );
  });

  it('returns the session on the happy path', () => {
    const sql = makeSql([makeSessionRow({ id: 'ok-1' })], 1);
    const result = getSession(sql, 'ok-1');
    expect(result?.id).toBe('ok-1');
  });

  it('returns null for a missing session', () => {
    const sql = makeSql([], 0);
    expect(getSession(sql, 'nope')).toBeNull();
  });
});
