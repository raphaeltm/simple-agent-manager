import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { listDiagnosisEvents } from '../../../src/services/diagnosis-runner';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const RUN_ID = 'run-1';

function insertEvent(
  sqlite: Database.Database,
  overrides: Partial<{
    id: string;
    run_id: string;
    sequence: number | string;
    step_key: string;
    event_type: string;
    status: string;
    source_name: string | null;
    arguments_preview: string | null;
    evidence_preview: string | null;
    result_count: number | null;
    duration_ms: number | null;
    retry_attempt: number | string;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
  }>
): void {
  const row = {
    id: 'event-1',
    run_id: RUN_ID,
    sequence: 1,
    step_key: 'step-1',
    event_type: 'tool_call',
    status: 'completed',
    source_name: null,
    arguments_preview: null,
    evidence_preview: null,
    result_count: null,
    duration_ms: null,
    retry_attempt: 0,
    error_code: null,
    error_message: null,
    created_at: '2026-08-05T12:00:00.000Z',
    ...overrides,
  };
  sqlite
    .prepare(
      `INSERT INTO debug_diagnosis_run_events
       (id, run_id, sequence, step_key, event_type, status, source_name, arguments_preview,
        evidence_preview, result_count, duration_ms, retry_attempt, error_code, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.run_id,
      row.sequence,
      row.step_key,
      row.event_type,
      row.status,
      row.source_name,
      row.arguments_preview,
      row.evidence_preview,
      row.result_count,
      row.duration_ms,
      row.retry_attempt,
      row.error_code,
      row.error_message,
      row.created_at
    );
}

describe('listDiagnosisEvents', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.debugDiagnosisRunEvents]);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
  });

  it('returns well-formed events in sequence order', async () => {
    insertEvent(sqlite, { id: 'e1', sequence: 1, step_key: 'step-1' });
    insertEvent(sqlite, {
      id: 'e2',
      sequence: 2,
      step_key: 'step-2',
      source_name: 'get_recent_errors',
    });

    const { events, nextCursor } = await listDiagnosisEvents(env, RUN_ID);

    expect(events).toEqual([
      expect.objectContaining({ id: 'e1', runId: RUN_ID, sequence: 1, stepKey: 'step-1' }),
      expect.objectContaining({
        id: 'e2',
        sequence: 2,
        stepKey: 'step-2',
        sourceName: 'get_recent_errors',
      }),
    ]);
    expect(nextCursor).toBeNull();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('skips a row with a mistyped counter and logs it, without corrupting the rest of the page', async () => {
    // Regression: the old mapper coerced every field via bare String()/Number(),
    // so a non-numeric `sequence` silently became NaN. A NaN sequence would
    // then poison nextCursor (`events.at(-1)?.sequence`), stalling pagination
    // for the whole run. The row must be skipped instead.
    insertEvent(sqlite, { id: 'e1', sequence: 1, step_key: 'step-1' });
    sqlite
      .prepare('UPDATE debug_diagnosis_run_events SET sequence = ? WHERE id = ?')
      .run('not-a-number', 'e1');
    insertEvent(sqlite, { id: 'e2', sequence: 2, step_key: 'step-2' });

    const { events, nextCursor } = await listDiagnosisEvents(env, RUN_ID);

    expect(events).toEqual([expect.objectContaining({ id: 'e2', sequence: 2 })]);
    expect(nextCursor).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'diagnosis_runner.event_row_skipped',
      expect.objectContaining({ runId: RUN_ID, rowId: 'e1' })
    );
  });

  it('does not let a skipped row corrupt hasMore/pagination for the remaining good rows', async () => {
    insertEvent(sqlite, { id: 'e1', sequence: 1, step_key: 'step-1' });
    sqlite
      .prepare('UPDATE debug_diagnosis_run_events SET retry_attempt = ? WHERE id = ?')
      .run('oops', 'e1');
    insertEvent(sqlite, { id: 'e2', sequence: 2, step_key: 'step-2' });
    insertEvent(sqlite, { id: 'e3', sequence: 3, step_key: 'step-3' });

    const { events, nextCursor } = await listDiagnosisEvents(env, RUN_ID, 0, 2);

    // pageSize=2: hasMore is computed from the raw (pre-skip) row count, so
    // the third row (sequence 3) is correctly reported as still pending even
    // though only one good row survived slicing to pageSize.
    expect(events).toEqual([expect.objectContaining({ id: 'e2', sequence: 2 })]);
    expect(nextCursor).toBe(2);
  });

  it('respects the cursor and limit for well-formed rows (existing pagination contract)', async () => {
    insertEvent(sqlite, { id: 'e1', sequence: 1, step_key: 'step-1' });
    insertEvent(sqlite, { id: 'e2', sequence: 2, step_key: 'step-2' });
    insertEvent(sqlite, { id: 'e3', sequence: 3, step_key: 'step-3' });

    const { events, nextCursor } = await listDiagnosisEvents(env, RUN_ID, 0, 2);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(nextCursor).toBe(2);

    const page2 = await listDiagnosisEvents(env, RUN_ID, nextCursor ?? 0, 2);
    expect(page2.events.map((e) => e.sequence)).toEqual([3]);
    expect(page2.nextCursor).toBeNull();
  });
});
