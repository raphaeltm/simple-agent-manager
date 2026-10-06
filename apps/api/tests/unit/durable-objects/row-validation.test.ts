/**
 * Unit tests for the cross-DO row-validation helpers (`mapRows`, `parseRowOrNull`)
 * and the shared ProjectAgent/SamSession row schemas.
 *
 * See .claude/rules/50-list-read-row-fault-isolation.md — a single malformed
 * row must never throw a whole list read; single-row lookups must degrade to
 * null instead of an opaque throw.
 */
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

import {
  ConversationSummaryRowSchema,
  mapRows,
  MessageRowSchema,
  parseRow,
  parseRowOrNull,
  RateLimitRowSchema,
  RowidRowSchema,
} from '../../../src/durable-objects/row-validation';
import { log } from '../../../src/lib/logger';

// =============================================================================
// mapRows — list-read fault isolation
// =============================================================================

describe('mapRows', () => {
  const TestSchema = v.object({ id: v.string(), count: v.number() });

  it('returns all rows on the happy path', () => {
    const rows = [
      { id: 'a', count: 1 },
      { id: 'b', count: 2 },
    ];
    expect(mapRows(rows, TestSchema, 'test.list')).toEqual(rows);
  });

  // REGRESSION (rule 50): a single malformed row must be skipped, not thrown.
  it('skips a malformed row in the middle and keeps the good rows either side', () => {
    const good1 = { id: 'good-1', count: 1 };
    const bad = { id: 'bad-1', count: 'not-a-number' }; // violates v.number()
    const good2 = { id: 'good-2', count: 2 };

    let result: unknown;
    expect(() => {
      result = mapRows([good1, bad, good2], TestSchema, 'test.list');
    }).not.toThrow();

    expect(result).toEqual([good1, good2]);
  });

  it('returns an empty, non-throwing array when every row is malformed', () => {
    const rows = [{ id: 'bad-1', count: null }, { id: 'bad-2' }];
    expect(() => mapRows(rows, TestSchema, 'test.list')).not.toThrow();
    expect(mapRows(rows, TestSchema, 'test.list')).toEqual([]);
  });

  it('returns an empty array for an empty input without touching the schema', () => {
    expect(mapRows([], TestSchema, 'test.list')).toEqual([]);
  });

  it('logs a diagnosable skip event with the row id and the parser error', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const bad = { id: 'bad-row-id', count: 'nope' };

    mapRows([bad], TestSchema, 'test.list');

    expect(warn).toHaveBeenCalledWith(
      'test.list_row_skipped',
      expect.objectContaining({ rowId: 'bad-row-id', error: expect.stringContaining('count') })
    );
    warn.mockRestore();
  });

  it('logs a degraded summary only when at least one row was skipped', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    mapRows([{ id: 'ok', count: 1 }], TestSchema, 'test.clean_list');
    expect(warn).not.toHaveBeenCalledWith('test.clean_list_degraded', expect.anything());

    mapRows(
      [
        { id: 'ok', count: 1 },
        { id: 'bad', count: 'x' },
      ],
      TestSchema,
      'test.dirty_list'
    );
    expect(warn).toHaveBeenCalledWith(
      'test.dirty_list_degraded',
      expect.objectContaining({ fetched: 2, returned: 1, skipped: 1 })
    );
    warn.mockRestore();
  });

  it('uses a custom idKey for the skip-log row identifier when the row has no `id` column', () => {
    const MissionSchema = v.object({ mission_id: v.string(), registered_at: v.number() });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const bad = { mission_id: 'mission-42', registered_at: 'not-a-number' };

    const result = mapRows([bad], MissionSchema, 'orchestrator.missions_list', 'mission_id');

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'orchestrator.missions_list_row_skipped',
      expect.objectContaining({ rowId: 'mission-42' })
    );
    warn.mockRestore();
  });

  it('reports rowId null when the row has neither `id` nor the given idKey populated as a string', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    mapRows([{ id: 123, count: 'bad' }], TestSchema, 'test.numeric_id');
    expect(warn).toHaveBeenCalledWith(
      'test.numeric_id_row_skipped',
      expect.objectContaining({ rowId: null })
    );
    warn.mockRestore();
  });

  // DISCRIMINATING CHECK: this is the exact class of bug rule 50 exists to
  // prevent. A naive "validate every row with a throwing parser, no per-row
  // isolation" implementation — the shape you'd get from `rows.map(r =>
  // parseRow(schema, r, context))` — throws and loses ALL rows the moment one
  // is malformed. `mapRows` must not regress to that behavior.
  it('is proven discriminating: a naive throwing per-row map loses everything; mapRows does not', () => {
    const good1 = { id: 'good-1', count: 1 };
    const bad = { id: 'bad-1', count: 'nope' };
    const good2 = { id: 'good-2', count: 2 };
    const rows = [good1, bad, good2];

    // The "pre-fix-equivalent" pattern this module replaces at every call site.
    expect(() => rows.map((r) => parseRow(TestSchema, r, 'test.naive'))).toThrow(
      /Row validation failed \(test\.naive\)/
    );

    // The actual fix tolerates the same input.
    expect(mapRows(rows, TestSchema, 'test.list')).toEqual([good1, good2]);
  });
});

// =============================================================================
// parseRowOrNull — single-row fault isolation
// =============================================================================

describe('parseRowOrNull', () => {
  const TestSchema = v.object({ id: v.string(), value: v.number() });

  it('returns the parsed row on the happy path', () => {
    const row = { id: 'x', value: 5 };
    expect(parseRowOrNull(row, TestSchema, 'test.single')).toEqual(row);
  });

  it('returns null for an undefined row (not found) without throwing', () => {
    expect(() => parseRowOrNull(undefined, TestSchema, 'test.single')).not.toThrow();
    expect(parseRowOrNull(undefined, TestSchema, 'test.single')).toBeNull();
  });

  it('returns null for a malformed row instead of throwing', () => {
    const bad = { id: 'bad', value: 'not-a-number' };
    let result: unknown;
    expect(() => {
      result = parseRowOrNull(bad, TestSchema, 'test.single');
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('logs a diagnosable skip event for a malformed row', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    parseRowOrNull({ id: 'row-9', value: 'x' }, TestSchema, 'test.single');
    expect(warn).toHaveBeenCalledWith(
      'test.single_row_skipped',
      expect.objectContaining({ rowId: 'row-9', error: expect.stringContaining('value') })
    );
    warn.mockRestore();
  });

  it('does not log anything for a missing (undefined) row', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    parseRowOrNull(undefined, TestSchema, 'test.single');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('uses a custom idKey for the skip-log row identifier', () => {
    const MissionSchema = v.object({ mission_id: v.string(), registered_at: v.number() });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // mission_id is a valid string, but registered_at is malformed — the row
    // as a whole fails validation, and the skip log must report the mission_id
    // (not `id`, which this row doesn't have) as the best-effort identifier.
    parseRowOrNull(
      { mission_id: 'mission-7', registered_at: 'not-a-number' },
      MissionSchema,
      'orchestrator.resolve',
      'mission_id'
    );
    expect(warn).toHaveBeenCalledWith(
      'orchestrator.resolve_row_skipped',
      expect.objectContaining({
        rowId: 'mission-7',
        error: expect.stringContaining('registered_at'),
      })
    );
    warn.mockRestore();
  });

  // DISCRIMINATING CHECK: a bare `as SessionStateRow | undefined` (the pre-fix
  // pattern in reconciliation.ts) never validates at all — a malformed value
  // silently flows through with the wrong runtime type. parseRowOrNull must
  // reject it and degrade to null instead.
  it('is proven discriminating: a blind cast would silently accept a wrong-typed field; parseRowOrNull rejects it', () => {
    const row = { id: 'sess-1', value: 'not-a-number' };

    // The pre-fix pattern: `row as { id: string; value: number }` performs NO
    // runtime check — TypeScript happily "believes" `value` is a number.
    const blindlyCast = row as unknown as { id: string; value: number };
    expect(typeof blindlyCast.value).toBe('string'); // the lie: TS says number, runtime says string

    // The fix: parseRowOrNull actually validates and rejects it.
    expect(parseRowOrNull(row, TestSchema, 'test.single')).toBeNull();
  });
});

// =============================================================================
// Shared ProjectAgent + SamSession row schemas
// =============================================================================

describe('ConversationSummaryRowSchema', () => {
  it('validates a SamSession row (with `type`)', () => {
    const row = { id: 'c1', title: 'Hello', type: 'human', created_at: 'a', updated_at: 'b' };
    expect(v.safeParse(ConversationSummaryRowSchema, row).success).toBe(true);
  });

  it('validates a ProjectAgent row (no `type` column at all)', () => {
    const row = { id: 'c1', title: null, created_at: 'a', updated_at: 'b' };
    const result = v.safeParse(ConversationSummaryRowSchema, row);
    expect(result.success).toBe(true);
  });

  it('rejects a row with the wrong type for `id`', () => {
    const row = { id: 123, title: 'x', created_at: 'a', updated_at: 'b' };
    expect(v.safeParse(ConversationSummaryRowSchema, row).success).toBe(false);
  });

  it('rejects a row missing created_at', () => {
    const row = { id: 'c1', title: 'x', updated_at: 'b' };
    expect(v.safeParse(ConversationSummaryRowSchema, row).success).toBe(false);
  });
});

describe('MessageRowSchema', () => {
  const validRow = {
    id: 'm1',
    conversation_id: 'c1',
    role: 'user',
    content: 'hi',
    tool_calls_json: null,
    tool_call_id: null,
    sequence: 1,
    created_at: 'now',
  };

  it('validates a well-formed row', () => {
    expect(v.safeParse(MessageRowSchema, validRow).success).toBe(true);
  });

  it('rejects a non-numeric sequence', () => {
    expect(v.safeParse(MessageRowSchema, { ...validRow, sequence: 'not-a-number' }).success).toBe(
      false
    );
  });

  it('rejects a null role (NOT NULL in both DOs schema)', () => {
    expect(v.safeParse(MessageRowSchema, { ...validRow, role: null }).success).toBe(false);
  });

  it('accepts null tool_calls_json / tool_call_id', () => {
    expect(v.safeParse(MessageRowSchema, validRow).success).toBe(true);
  });
});

describe('RateLimitRowSchema', () => {
  it('validates a well-formed row', () => {
    expect(v.safeParse(RateLimitRowSchema, { window_start: 1000, request_count: 3 }).success).toBe(
      true
    );
  });

  it('rejects a non-numeric window_start', () => {
    expect(
      v.safeParse(RateLimitRowSchema, { window_start: 'bogus', request_count: 3 }).success
    ).toBe(false);
  });
});

describe('RowidRowSchema', () => {
  it('validates a numeric rowid', () => {
    expect(v.safeParse(RowidRowSchema, { rowid: 42 }).success).toBe(true);
  });

  it('rejects a non-numeric rowid', () => {
    expect(v.safeParse(RowidRowSchema, { rowid: 'forty-two' }).success).toBe(false);
  });
});
