/**
 * Which previous runs hold a trigger's run slot, decided by the real admission SQL.
 * Every task status needs an expectation here: the slot predicate is a denylist, so a
 * status added later would silently hold the slot until someone classifies it
 * (`packages/shared/.claude/rules/79`).
 */
import { TASK_STATUSES, type TaskStatus } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tasks, triggerExecutions, type TriggerRow, triggers } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { admitAndSubmitTriggerExecution } from '../../../src/services/trigger-admission';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-run-slot';
const TRIGGER_ID = 'trigger-run-slot';
const NOW = '2026-10-10T15:05:00.000Z';

type Slot = 'holds' | 'released';

/**
 * Previous run whose execution the cleanup backstop already failed, so the linked task's
 * status alone decides: running work holds the slot, sleeping or finished work releases it.
 */
const SLOT_BY_TASK_STATUS: Record<TaskStatus, Slot> = {
  draft: 'holds',
  ready: 'holds',
  queued: 'holds',
  delegated: 'holds',
  in_progress: 'holds',
  sleeping: 'released',
  completed: 'released',
  failed: 'released',
  cancelled: 'released',
};

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(skipIfRunning: boolean) {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [tasks, triggers, triggerExecutions]);
  sqlite
    .prepare(
      `INSERT INTO triggers
        (id, project_id, user_id, name, status, source_type, cron_expression, cron_timezone,
         skip_if_running, prompt_template, task_mode, max_concurrent, trigger_count,
         next_execution_sequence, created_at, updated_at)
       VALUES (?, ?, 'user-1', 'Run slot', 'active', 'cron', '5 15 * * *', 'UTC',
         ?, 'run', 'task', 1, 0, 2, ?, ?)`
    )
    .run(TRIGGER_ID, PROJECT_ID, skipIfRunning ? 1 : 0, NOW, NOW);
  const trigger = sqlite.prepare('SELECT * FROM triggers').get() as Record<string, unknown>;
  const row = {
    id: trigger.id,
    projectId: trigger.project_id,
    userId: trigger.user_id,
    name: trigger.name,
    status: trigger.status,
    skipIfRunning,
    maxConcurrent: 1,
    taskMode: 'task',
    promptTemplate: 'run',
  } as unknown as TriggerRow;
  return { sqlite, env: { DATABASE: createSqliteD1(sqlite) } as Env, trigger: row };
}

function previousRun(
  sqlite: Database.Database,
  run: { executionStatus: string; taskId: string | null; taskStatus?: string }
) {
  sqlite
    .prepare(
      `INSERT INTO trigger_executions
        (id, trigger_id, project_id, status, event_type, scheduled_at, sequence_number, task_id, created_at)
       VALUES ('previous', ?, ?, ?, 'cron', ?, 1, ?, ?)`
    )
    .run(TRIGGER_ID, PROJECT_ID, run.executionStatus, NOW, run.taskId, NOW);
  if (run.taskId && run.taskStatus) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, status, trigger_execution_id)
         VALUES (?, ?, 'user-1', ?, 'previous')`
      )
      .run(run.taskId, PROJECT_ID, run.taskStatus);
  }
}

async function nextFire(env: Env, trigger: TriggerRow) {
  const submitter = vi.fn(async () => ({
    taskId: 'next-task',
    sessionId: 'next-session',
    branchName: 'sam/next',
  }));
  const result = await admitAndSubmitTriggerExecution(
    env,
    { trigger, eventType: 'cron', triggeredBy: 'cron', renderPrompt: () => 'run' },
    submitter
  );
  return { result, submitter };
}

describe('trigger run slot by previous-run state', () => {
  describe.each([
    ['skip_if_running', true, 'still_running'],
    ['max_concurrent', false, 'concurrent_limit'],
  ] as const)('%s', (_label, skipIfRunning, skipReason) => {
    it.each(TASK_STATUSES)('a previous run whose task is %s', async (status) => {
      const expected = expectedSlot(status);
      const { sqlite, env, trigger } = setup(skipIfRunning);
      previousRun(sqlite, {
        executionStatus: 'failed',
        taskId: 'previous-task',
        taskStatus: status,
      });

      const { result, submitter } = await nextFire(env, trigger);

      if (expected === 'holds') {
        expect(result).toMatchObject({ outcome: 'skipped', reason: skipReason });
        expect(submitter).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ outcome: 'submitted', taskId: 'next-task' });
        expect(submitter).toHaveBeenCalledOnce();
      }
    });
  });

  it.each([
    ['a reserved execution with no task yet', { executionStatus: 'queued', taskId: null }],
    [
      'a running execution whose task row is missing',
      { executionStatus: 'running', taskId: 'missing-task' },
    ],
    [
      'a running execution whose task finished before the sync',
      { executionStatus: 'running', taskId: 'previous-task', taskStatus: 'completed' },
    ],
    [
      'a running execution whose task is live',
      { executionStatus: 'running', taskId: 'previous-task', taskStatus: 'in_progress' },
    ],
  ])('keeps holding the slot for %s', async (_label, run) => {
    const { sqlite, env, trigger } = setup(true);
    previousRun(sqlite, run);

    const { result, submitter } = await nextFire(env, trigger);

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'still_running' });
    expect(submitter).not.toHaveBeenCalled();
  });

  it('releases the slot for a running execution whose task went to sleep', async () => {
    const { sqlite, env, trigger } = setup(true);
    previousRun(sqlite, {
      executionStatus: 'running',
      taskId: 'previous-task',
      taskStatus: 'sleeping',
    });

    const { result } = await nextFire(env, trigger);

    expect(result).toMatchObject({ outcome: 'submitted', taskId: 'next-task' });
  });
});

function expectedSlot(status: string): Slot {
  const expected = SLOT_BY_TASK_STATUS[status as TaskStatus];
  expect(expected, `classify the new task status "${status}" in SLOT_BY_TASK_STATUS`).toBeDefined();
  return expected;
}
