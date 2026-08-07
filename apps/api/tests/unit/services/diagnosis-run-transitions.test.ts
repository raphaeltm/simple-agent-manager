import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import migration0103 from '../../../src/db/migrations/0103_debug_diagnosis_runs.sql?raw';
import migration0104 from '../../../src/db/migrations/0104_durable_debug_diagnosis_runs.sql?raw';
import migration0105 from '../../../src/db/migrations/0105_debug_diagnosis_canonical_status.sql?raw';
import {
  completeDiagnosisRunTransition,
  finishDiagnosisRunTransition,
} from '../../../src/services/diagnosis-run-transitions';

class SQLiteD1Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SQLiteD1Statement(
      this.sqlite,
      this.sql,
      values as SQLInputValue[]
    ) as unknown as D1PreparedStatement;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result<unknown>;
  }
}

class SQLiteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    return new SQLiteD1Statement(this.sqlite, sql) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function seedDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE debug_diagnoses (
      id TEXT PRIMARY KEY,
      error_id TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      model TEXT NOT NULL,
      turns INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      daily_tokens_used INTEGER NOT NULL,
      daily_token_limit INTEGER NOT NULL,
      idea_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id) VALUES ('transition-user');
  `);
  sqlite.exec(migration0103);
  sqlite.exec(migration0104);
  sqlite.exec(migration0105);
  const now = '2026-08-05T12:00:00.000Z';
  sqlite.exec(`
    INSERT INTO debug_diagnosis_runs
      (id,status,run_status,start_time,end_time,deadline_at,created_by,created_at,updated_at)
    VALUES
      ('transition-run','running','running','2026-08-05T11:00:00.000Z','2026-08-05T13:00:00.000Z','2026-08-05T14:00:00.000Z','transition-user','${now}','${now}');
  `);
  return { sqlite, db: new SQLiteD1(sqlite) as unknown as D1Database };
}

function completion(now = '2026-08-05T12:01:00.000Z') {
  return {
    runId: 'transition-run',
    diagnosisId: 'transition-diagnosis',
    eventId: 'transition-completed-event',
    errorId: null,
    startTime: '2026-08-05T11:00:00.000Z',
    endTime: '2026-08-05T13:00:00.000Z',
    diagnosis: 'bounded safe diagnosis',
    model: '@cf/test-model',
    turns: 2,
    inputTokens: 20,
    outputTokens: 10,
    dailyTokensUsed: 30,
    dailyTokenLimit: 100,
    createdBy: 'transition-user',
    now,
  };
}

describe('diagnosis terminal compare-and-set transitions', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    ({ sqlite, db } = seedDatabase());
  });

  it('publishes diagnosis, status, and terminal event atomically for the active winner', async () => {
    expect(await completeDiagnosisRunTransition(db, completion())).toBe(true);
    expect(
      sqlite
        .prepare('SELECT status,run_status,diagnosis_id FROM debug_diagnosis_runs WHERE id=?')
        .get('transition-run')
    ).toEqual({
      status: 'succeeded',
      run_status: 'succeeded',
      diagnosis_id: 'transition-diagnosis',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM debug_diagnoses').get()).toEqual({
      count: 1,
    });
    expect(sqlite.prepare('SELECT step_key,status FROM debug_diagnosis_run_events').get()).toEqual({
      step_key: 'completed',
      status: 'succeeded',
    });
  });

  it('rejects late completion after cancellation and emits one idempotent terminal event', async () => {
    sqlite.exec(
      "UPDATE debug_diagnosis_runs SET cancel_requested_at='2026-08-05T12:00:30.000Z' WHERE id='transition-run'"
    );
    expect(await completeDiagnosisRunTransition(db, completion())).toBe(false);
    const finishInput = {
      runId: 'transition-run',
      eventId: 'transition-cancelled-event',
      status: 'cancelled' as const,
      message: 'Diagnosis cancelled by an administrator',
      code: 'CANCELLED',
      now: '2026-08-05T12:01:00.000Z',
    };
    expect(await finishDiagnosisRunTransition(db, finishInput)).toBe(true);
    expect(
      await finishDiagnosisRunTransition(db, { ...finishInput, eventId: 'duplicate-event' })
    ).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM debug_diagnoses').get()).toEqual({
      count: 0,
    });
    expect(
      sqlite.prepare('SELECT status,run_status,diagnosis_id FROM debug_diagnosis_runs').get()
    ).toEqual({ status: 'failed', run_status: 'cancelled', diagnosis_id: null });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM debug_diagnosis_run_events').get()
    ).toEqual({ count: 1 });
  });

  it('rejects a completion whose hard deadline elapsed during external work', async () => {
    expect(await completeDiagnosisRunTransition(db, completion('2026-08-05T14:00:00.000Z'))).toBe(
      false
    );
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM debug_diagnoses').get()).toEqual({
      count: 0,
    });
    expect(
      sqlite.prepare('SELECT run_status,diagnosis_id FROM debug_diagnosis_runs').get()
    ).toEqual({ run_status: 'running', diagnosis_id: null });
  });

  it('preserves an already-requested cancellation against a late failure', async () => {
    sqlite.exec(
      "UPDATE debug_diagnosis_runs SET cancel_requested_at='2026-08-05T12:00:30.000Z' WHERE id='transition-run'"
    );
    expect(
      await finishDiagnosisRunTransition(db, {
        runId: 'transition-run',
        eventId: 'late-failure',
        status: 'failed',
        message: 'provider failed after cancellation',
        code: 'MODEL_FAILED',
        now: '2026-08-05T12:01:00.000Z',
      })
    ).toBe(false);
    expect(
      await finishDiagnosisRunTransition(db, {
        runId: 'transition-run',
        eventId: 'cancel-winner',
        status: 'cancelled',
        message: 'Diagnosis cancelled by an administrator',
        code: 'CANCELLED',
        now: '2026-08-05T12:01:01.000Z',
      })
    ).toBe(true);
    expect(sqlite.prepare('SELECT run_status FROM debug_diagnosis_runs').get()).toEqual({
      run_status: 'cancelled',
    });
  });
});
