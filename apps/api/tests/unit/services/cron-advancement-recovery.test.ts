import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { runCronTriggerSweep } from '../../../src/scheduled/cron-triggers';
import { TriggerTaskSubmissionPendingError } from '../../../src/services/trigger-submission';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('../../../src/services/trigger-submit', () => ({ submitTriggeredTask: submit }));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DUE = '2026-10-01T00:00:00.000Z';
let sqlite: Database.Database;
let env: Env;
let advanceAttempts: string[];
let failAdvance: boolean;
let failProjectRead: boolean;
let failAdmissionRecording: boolean;

async function seed(id: string) {
  await drizzle(env.DATABASE).insert(schema.triggers).values({
    id,
    projectId: 'project-test',
    userId: 'user-test',
    name: id,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 * * * *',
    cronTimezone: 'UTC',
    promptTemplate: 'run {{trigger.name}}',
    skipIfRunning: false,
    maxConcurrent: 5,
    nextExecutionSequence: 1,
    nextFireAt: DUE,
    triggerCount: 0,
    createdAt: DUE,
    updatedAt: DUE,
  });
}

function executions() {
  return sqlite
    .prepare('SELECT * FROM trigger_executions ORDER BY trigger_id, sequence_number')
    .all() as Record<string, unknown>[];
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.projects,
    schema.triggers,
    schema.triggerExecutions,
    schema.tasks,
    schema.githubTriggerInbox,
    schema.triggerEmailMessages,
  ]);
  sqlite.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run('project-test', 'Test');
  const database = createSqliteD1(sqlite);
  const prepare = database.prepare.bind(database);
  advanceAttempts = [];
  failAdvance = true;
  failProjectRead = false;
  failAdmissionRecording = false;
  database.prepare = ((sql: string) => {
    if (failProjectRead && sql.startsWith('select "name"')) {
      failProjectRead = false;
      throw new Error('project read unavailable');
    }
    if (
      failAdmissionRecording &&
      (sql.startsWith('UPDATE trigger_executions SET rendered_prompt') ||
        sql.startsWith('UPDATE trigger_executions SET status = ?'))
    ) {
      throw new Error('D1_ERROR: transient failure');
    }
    const statement = prepare(sql);
    if (!sql.startsWith('update "triggers" set "next_fire_at"')) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...params: unknown[]) => {
      const bound = bind(...params);
      const run = bound.run.bind(bound);
      bound.run = async () => {
        advanceAttempts.push(String(params[1]));
        if (failAdvance && params.includes('a')) {
          throw new Error('D1_ERROR: database is locked: SQLITE_BUSY');
        }
        return run();
      };
      return bound;
    };
    return statement;
  }) as D1Database['prepare'];
  env = { DATABASE: database } as Env;
  submit.mockImplementation(async (_env, input) => {
    const taskId = input.triggerExecutionId;
    sqlite
      .prepare(
        'INSERT INTO tasks(id,project_id,status,trigger_execution_id,chat_session_id) VALUES (?,?,?,?,?)'
      )
      .run(taskId, input.projectId, 'running', input.triggerExecutionId, `chat_${taskId}`);
    return { taskId, sessionId: `chat_${taskId}`, branchName: 'sam/test' };
  });
});
afterEach(() => sqlite.close());

describe('cron advancement recovery through real admission', () => {
  it('continues to later due triggers when accepted admission is followed by a failed write', async () => {
    await seed('a');
    await seed('b');
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({
      checked: 2,
      failed: 1,
      fired: 1,
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(executions()).toHaveLength(2);
    expect(advanceAttempts).toEqual(['a', 'b']);
    expect(sqlite.prepare('SELECT next_fire_at FROM triggers WHERE id=?').get('a')).toEqual({
      next_fire_at: DUE,
    });
  });

  it('recovers a later sweep without admitting another execution, even after the task completed', async () => {
    await seed('a');
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({ failed: 1 });
    const accepted = executions()[0]!;
    sqlite.prepare("UPDATE tasks SET status='completed'").run();
    sqlite.prepare("UPDATE trigger_executions SET status='completed'").run();
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(executions()).toEqual([
      expect.objectContaining({ id: accepted.id, status: 'completed' }),
    ]);
    expect(sqlite.prepare('SELECT next_fire_at FROM triggers WHERE id=?').get('a')).not.toEqual({
      next_fire_at: DUE,
    });
  });

  it('does not advance from the exception handler or lose an occurrence before admission', async () => {
    await seed('a');
    failProjectRead = true;
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({ failed: 1 });
    expect(advanceAttempts).toEqual([]);
    expect(executions()).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
    failProjectRead = false;
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(executions()).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('bounds retries to one write per occurrence per sweep and emits safe cause categories', async () => {
    await seed('a');
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({ failed: 1 });
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({ failed: 1 });
    expect(advanceAttempts).toEqual(['a', 'a']);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'cron_sweep.advancement_failed',
      expect.objectContaining({ databaseFailureCategory: 'busy' })
    );
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('params:');
  });
  it('keeps the occurrence due when recording the admission error also fails, then resumes its reservation', async () => {
    await seed('a');
    await seed('b');
    failAdmissionRecording = true;
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({ checked: 2, failed: 2 });
    const reserved = executions().map((row) => row.id);
    expect(reserved).toHaveLength(2);
    expect(advanceAttempts).toEqual([]);
    failAdmissionRecording = false;
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(executions().map((row) => row.id)).toEqual(reserved);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('processes later triggers after an admission exception', async () => {
    await seed('a');
    await seed('b');
    failProjectRead = true;
    failAdvance = false;
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({
      checked: 2,
      failed: 1,
      fired: 1,
    });
    expect(executions()).toEqual([expect.objectContaining({ trigger_id: 'b' })]);
    await runCronTriggerSweep(env);
    expect(executions()).toHaveLength(2);
  });

  it('reuses pre-rollout execution records rather than creating another task', async () => {
    await seed('a');
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
      (id,trigger_id,project_id,event_type,scheduled_at,status,sequence_number)
      VALUES (?,?,?,?,?,?,?)`
      )
      .run('legacy-execution', 'a', 'project-test', 'cron', DUE, 'completed', 1);
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(submit).not.toHaveBeenCalled();
    expect(executions()).toHaveLength(1);
  });

  it('records a skipped occurrence once even if advancement fails and its run slot later frees', async () => {
    await seed('a');
    sqlite.prepare('UPDATE triggers SET max_concurrent=1').run();
    sqlite
      .prepare(
        `INSERT INTO trigger_executions (id,trigger_id,project_id,status,sequence_number)
      VALUES ('older', 'a', 'project-test', 'running', 0)`
      )
      .run();
    await runCronTriggerSweep(env);
    expect(executions()).toHaveLength(2);
    sqlite.prepare("UPDATE trigger_executions SET status='completed' WHERE id='older'").run();
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(executions()).toHaveLength(2);
    expect(submit).not.toHaveBeenCalled();
  });

  it('overlapping sweeps converge on one accepted task and one sequence increment', async () => {
    await seed('a');
    failAdvance = false;
    await Promise.all([runCronTriggerSweep(env), runCronTriggerSweep(env)]);
    expect(executions()).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    expect(
      sqlite.prepare('SELECT next_execution_sequence,trigger_count FROM triggers').get()
    ).toEqual({ next_execution_sequence: 2, trigger_count: 1 });
  });

  it('retains a pending task and resumes it using the same execution after a failed advancement', async () => {
    await seed('a');
    const accept = submit.getMockImplementation()!;
    submit.mockImplementationOnce(async (...args) => {
      const result = await accept(...args);
      sqlite.prepare("UPDATE tasks SET status='queued'").run();
      throw new TriggerTaskSubmissionPendingError(result);
    });
    await runCronTriggerSweep(env);
    const reservedId = executions()[0]!.id;
    submit.mockImplementationOnce(async (_env, input) => {
      expect(input.triggerExecutionId).toBe(reservedId);
      sqlite.prepare("UPDATE tasks SET status='running'").run();
      return { taskId: input.triggerExecutionId, sessionId: 'chat-test', branchName: 'sam/test' };
    });
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    expect(executions()).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a schedule edited while admission is in flight', async () => {
    await seed('a');
    const accept = submit.getMockImplementation()!;
    submit.mockImplementationOnce(async (...args) => {
      const result = await accept(...args);
      sqlite.prepare('UPDATE triggers SET next_fire_at=?').run('2030-01-01T00:00:00.000Z');
      return result;
    });
    failAdvance = false;
    await runCronTriggerSweep(env);
    expect(sqlite.prepare('SELECT next_fire_at FROM triggers').get()).toEqual({
      next_fire_at: '2030-01-01T00:00:00.000Z',
    });
  });
});
