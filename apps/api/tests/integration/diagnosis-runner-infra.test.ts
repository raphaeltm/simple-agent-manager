import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import {
  cancelDiagnosisRunner,
  listDiagnosisEvents,
  reconcileDiagnosisRuns,
  startDiagnosisRunner,
} from '../../src/services/diagnosis-runner';

vi.mock('../../src/services/debug-agent', () => ({
  resolveDebugAgentConfig: () => ({
    staleHeartbeatMs: 60_000,
    hardDeadlineMs: 300_000,
  }),
}));

type BoundStatement = {
  sql: string;
  values: unknown[];
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

type FakeDatabase = D1Database & {
  statements: BoundStatement[];
};

function createStatement(sql: string, rows: unknown[]): BoundStatement & D1PreparedStatement {
  const statement = {
    sql,
    values: [] as unknown[],
    bind: vi.fn((...values: unknown[]) => {
      statement.values = values;
      return statement;
    }),
    all: vi.fn(async () => ({ results: rows, success: true, meta: {} })),
    run: vi.fn(async () => ({ success: true, meta: {} })),
    first: vi.fn(),
    raw: vi.fn(),
  } as unknown as BoundStatement & D1PreparedStatement;
  return statement;
}

function createDatabase(rowsBySql: Array<{ match: string; rows: unknown[] }> = []): FakeDatabase {
  const statements: BoundStatement[] = [];
  return {
    statements,
    prepare: vi.fn((sql: string) => {
      const rows = rowsBySql.find(entry => sql.includes(entry.match))?.rows ?? [];
      const statement = createStatement(sql, rows);
      statements.push(statement);
      return statement;
    }),
  } as unknown as FakeDatabase;
}

function createRunnerEnv(overrides: Partial<Env> = {}) {
  const runner = {
    start: vi.fn(async () => undefined),
    ensureStarted: vi.fn(async () => true),
    cancel: vi.fn(async () => undefined),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => runner),
  };
  const env = {
    DATABASE: createDatabase(),
    DIAGNOSIS_RUNNER: namespace,
    ...overrides,
  } as unknown as Env;
  return { env, namespace, runner };
}

describe('DiagnosisRunner service integration contract', () => {
  it('starts and cancels the per-run durable object by stable run id', async () => {
    const { env, namespace, runner } = createRunnerEnv();

    await startDiagnosisRunner(env, 'run-123');
    await cancelDiagnosisRunner(env, 'run-123');

    expect(namespace.idFromName).toHaveBeenCalledWith('run-123');
    expect(namespace.get).toHaveBeenCalledWith('id:run-123');
    expect(runner.start).toHaveBeenCalledWith('run-123');
    expect(runner.cancel).toHaveBeenCalledWith('run-123');
  });

  it('treats an existing durable start as successful when ensureStarted confirms state', async () => {
    const { env, runner } = createRunnerEnv();
    runner.start.mockRejectedValueOnce(new Error('already starting'));
    runner.ensureStarted.mockResolvedValueOnce(true);

    await expect(startDiagnosisRunner(env, 'run-existing')).resolves.toBeUndefined();

    expect(runner.ensureStarted).toHaveBeenCalledTimes(1);
  });

  it('rethrows durable start failures when the runner cannot confirm existing state', async () => {
    const { env, runner } = createRunnerEnv();
    runner.start.mockRejectedValueOnce(new Error('storage unavailable'));
    runner.ensureStarted.mockResolvedValueOnce(false);

    await expect(startDiagnosisRunner(env, 'run-failed')).rejects.toThrow('storage unavailable');
  });

  it('lists diagnosis events with a monotonic cursor and bounded limit', async () => {
    const database = createDatabase([
      {
        match: 'FROM debug_diagnosis_run_events',
        rows: [
          {
            id: 'event-1',
            run_id: 'run-events',
            sequence: 7,
            step_key: 'model:1',
            event_type: 'model_turn',
            status: 'completed',
            source_name: null,
            arguments_preview: null,
            evidence_preview: 'safe preview',
            result_count: 2,
            duration_ms: 123,
            retry_attempt: 0,
            error_code: null,
            error_message: null,
            created_at: '2026-08-05T00:00:00.000Z',
          },
        ],
      },
    ]);
    const { env } = createRunnerEnv({ DATABASE: database });

    const result = await listDiagnosisEvents(env, 'run-events', 3, 999);

    expect(result.nextCursor).toBe(7);
    expect(result.events[0]).toMatchObject({
      id: 'event-1',
      runId: 'run-events',
      sequence: 7,
      stepKey: 'model:1',
      evidencePreview: 'safe preview',
      resultCount: 2,
      durationMs: 123,
    });
    expect(database.statements[0].values).toEqual(['run-events', 3, 200]);
  });

  it('reconciles stale runs by terminalizing expired rows and restarting live rows', async () => {
    const now = Date.now();
    const database = createDatabase([
      {
        match: 'FROM debug_diagnosis_runs',
        rows: [
          {
            id: 'expired-run',
            deadline_at: new Date(now - 1_000).toISOString(),
            created_at: new Date(now - 600_000).toISOString(),
          },
          {
            id: 'live-run',
            deadline_at: new Date(now + 60_000).toISOString(),
            created_at: new Date(now - 60_000).toISOString(),
          },
        ],
      },
    ]);
    const { env, runner } = createRunnerEnv({ DATABASE: database });

    const result = await reconcileDiagnosisRuns(env);

    expect(result).toEqual({ restarted: 1, terminalized: 1 });
    expect(runner.start).toHaveBeenCalledWith('live-run');
    const updateStatement = database.statements.find(statement => statement.sql.includes("SET status='failed'"));
    expect(updateStatement?.values.at(-1)).toBe('expired-run');
    const selectStatement = database.statements[0];
    expect(selectStatement.sql).toContain("status IN ('queued','running')");
    expect(selectStatement.sql).toContain('LIMIT 50');
  });
});
