import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { runCronTriggerSweep } from '../../../src/scheduled/cron-triggers';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('../../../src/services/trigger-submit', () => ({ submitTriggeredTask: submit }));
vi.mock('../../../src/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const DUE = '2026-10-01T00:00:00.000Z';
let sqlite: Database.Database;
let env: Env;
let advanceAttempts: string[];
let failAdvance: boolean;
let failProjectRead: boolean;

async function seed(id: string) {
  await drizzle(env.DATABASE).insert(schema.triggers).values({
    id, projectId: 'project-test', userId: 'user-test', name: id, status: 'active',
    sourceType: 'cron', cronExpression: '0 * * * *', cronTimezone: 'UTC',
    promptTemplate: 'run {{trigger.name}}', skipIfRunning: false, maxConcurrent: 5,
    nextExecutionSequence: 1, nextFireAt: DUE, triggerCount: 0,
    createdAt: DUE, updatedAt: DUE,
  });
}

function executions() {
  return sqlite.prepare('SELECT * FROM trigger_executions ORDER BY trigger_id, sequence_number').all() as Record<string, unknown>[];
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.projects, schema.triggers, schema.triggerExecutions,
    schema.tasks, schema.githubTriggerInbox, schema.triggerEmailMessages]);
  sqlite.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run('project-test', 'Test');
  const database = createSqliteD1(sqlite);
  const prepare = database.prepare.bind(database);
  advanceAttempts = [];
  failAdvance = true;
  failProjectRead = false;
  database.prepare = ((sql: string) => {
    if (failProjectRead && sql.startsWith('select "name"')) throw new Error('project read unavailable');
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
    sqlite.prepare('INSERT INTO tasks(id,project_id,status,trigger_execution_id,chat_session_id) VALUES (?,?,?,?,?)')
      .run(taskId, input.projectId, 'running', input.triggerExecutionId, `chat_${taskId}`);
    return { taskId, sessionId: `chat_${taskId}`, branchName: 'sam/test' };
  });
});
afterEach(() => sqlite.close());

describe('cron advancement recovery through real admission', () => {
  it('continues to later due triggers when accepted admission is followed by a failed write', async () => {
    await seed('a');
    await seed('b');
    await expect(runCronTriggerSweep(env)).resolves.toMatchObject({ checked: 2, failed: 1, fired: 1 });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(executions()).toHaveLength(2);
    expect(advanceAttempts).toEqual(['a', 'b']);
    expect(sqlite.prepare('SELECT next_fire_at FROM triggers WHERE id=?').get('a')).toEqual({ next_fire_at: DUE });
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
    expect(executions()).toEqual([accepted && expect.objectContaining({ id: accepted.id, status: 'completed' })]);
    expect(sqlite.prepare('SELECT next_fire_at FROM triggers WHERE id=?').get('a')).not.toEqual({ next_fire_at: DUE });
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
    expect(log.error).toHaveBeenCalledWith('cron_sweep.advancement_failed', expect.objectContaining({ databaseFailureCategory: 'busy' }));
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('params:');
  });
});
