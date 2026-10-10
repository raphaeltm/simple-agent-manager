/**
 * A cron trigger whose previous run's task slept through the real VM teardown fires
 * again through the production sweep. Live previous runs still hold the slot.
 */
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { runCronTriggerSweep } from '../../src/scheduled/cron-triggers';
import { runTriggerExecutionCleanup } from '../../src/scheduled/trigger-execution-cleanup';
import { sleepWorkspaceSession } from '../../src/services/session-sleep';
import { createSchemaTables } from '../helpers/sqlite-d1';

const { submitTriggeredTask } = vi.hoisted(() => ({ submitTriggeredTask: vi.fn() }));
vi.mock('../../src/services/trigger-submit', () => ({ submitTriggeredTask }));

const { createSessionSleepFixture, SLEEP_START: START } = await vi.hoisted(
  () => import('../helpers/session-sleep-fixture')
);

const TRIGGER_ID = 'trigger-daily';
// Fires daily at 15:05 UTC; the fixture clock starts at 05:00 UTC.
const CRON = '5 15 * * *';
const NEXT_DAY_FIRE = new Date('2026-08-14T15:05:00.000Z');

type LimitShape = { skipIfRunning: boolean; maxConcurrent: number };

describe('trigger run slots after the previous run sleeps', () => {
  let fixture: ReturnType<typeof createSessionSleepFixture>;
  let sqlite: Database.Database;
  let env: Env;

  afterEach(() => fixture.dispose());

  function setup(previousTaskStatus: string, limits: LimitShape) {
    fixture = createSessionSleepFixture(previousTaskStatus, () => ({
      activity: 'idle',
      activityAt: START.getTime(),
    }));
    ({ sqlite, env } = fixture);
    createSchemaTables(sqlite, [schema.triggers]);
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, status, source_type, cron_expression, cron_timezone,
           skip_if_running, prompt_template, task_mode, max_concurrent, trigger_count,
           next_execution_sequence, next_fire_at, created_at, updated_at)
         VALUES (?, 'project-1', 'user-1', 'Daily blog post', 'active', 'cron', ?, 'UTC',
           ?, 'Write the daily post', 'task', ?, 0, 1, ?, ?, ?)`
      )
      .run(
        TRIGGER_ID,
        CRON,
        limits.skipIfRunning ? 1 : 0,
        limits.maxConcurrent,
        new Date(START.getTime() - 60_000).toISOString(),
        START.toISOString(),
        START.toISOString()
      );
    // The fixture's task-1 on workspace-1/chat-1 is what the first fire submits.
    submitTriggeredTask.mockImplementation(
      async (_env: Env, input: { triggerExecutionId: string }) => {
        const taskId = submitTriggeredTask.mock.calls.length === 1 ? 'task-1' : 'task-next';
        // The real submitter links the task it creates to the reserved execution.
        sqlite
          .prepare(
            `UPDATE tasks SET trigger_id = ?, trigger_execution_id = ?, task_mode = 'task',
             triggered_by = 'cron', chat_session_id = 'chat-1' WHERE id = ?`
          )
          .run(TRIGGER_ID, input.triggerExecutionId, taskId);
        return { taskId, sessionId: `session-${taskId}`, branchName: `sam/${taskId}` };
      }
    );
  }

  function executions() {
    return sqlite
      .prepare(
        `SELECT status, skip_reason AS skipReason, task_id AS taskId
           FROM trigger_executions WHERE trigger_id = ? ORDER BY sequence_number`
      )
      .all(TRIGGER_ID);
  }

  async function sleepPreviousRun() {
    await sleepWorkspaceSession(env, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'previous trigger run went idle',
    });
    expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
      status: 'sleeping',
    });
  }

  async function fireNextDay() {
    vi.setSystemTime(new Date(NEXT_DAY_FIRE.getTime() + 30_000));
    return runCronTriggerSweep(env);
  }

  it.each<LimitShape>([
    { skipIfRunning: true, maxConcurrent: 1 },
    { skipIfRunning: false, maxConcurrent: 1 },
  ])('admits the next cron fire while the previous run sleeps (%o)', async (limits) => {
    setup('in_progress', limits);
    expect(await runCronTriggerSweep(env)).toMatchObject({ fired: 1 });
    expect(executions()).toEqual([{ status: 'running', skipReason: null, taskId: 'task-1' }]);

    await sleepPreviousRun();
    expect(await fireNextDay()).toMatchObject({ checked: 1, fired: 1, skipped: 0 });

    expect(submitTriggeredTask).toHaveBeenCalledTimes(2);
    expect(executions()).toEqual([
      // The sleeping run keeps its execution: a follow-up can still wake it.
      { status: 'running', skipReason: null, taskId: 'task-1' },
      { status: 'running', skipReason: null, taskId: 'task-next' },
    ]);
  });

  it('admits the next fire after the real hard-residence backstop failed the sleeping run', async () => {
    setup('in_progress', { skipIfRunning: true, maxConcurrent: 1 });
    createSchemaTables(sqlite, [schema.webhookDeliveries]);
    await runCronTriggerSweep(env);
    await sleepPreviousRun();

    // Past the 48 h default residence bound, the cleanup cron fails the execution while
    // its sleeping task stays non-terminal.
    vi.setSystemTime(new Date(START.getTime() + 49 * 60 * 60 * 1000));
    await runTriggerExecutionCleanup(env);
    expect(executions()).toEqual([{ status: 'failed', skipReason: null, taskId: 'task-1' }]);

    expect(await runCronTriggerSweep(env)).toMatchObject({ fired: 1, skipped: 0 });
    expect(submitTriggeredTask).toHaveBeenCalledTimes(2);
  });

  it.each(['queued', 'delegated', 'in_progress'])(
    'still skips the next fire while the previous run is %s',
    async (status) => {
      setup(status, { skipIfRunning: true, maxConcurrent: 1 });
      expect(await runCronTriggerSweep(env)).toMatchObject({ fired: 1 });

      expect(await fireNextDay()).toMatchObject({ checked: 1, fired: 0, skipped: 1 });

      expect(submitTriggeredTask).toHaveBeenCalledOnce();
      expect(executions()).toEqual([
        { status: 'running', skipReason: null, taskId: 'task-1' },
        { status: 'skipped', skipReason: 'still_running', taskId: null },
      ]);
    }
  );

  it('still counts a live run against max_concurrent when skip_if_running is off', async () => {
    setup('in_progress', { skipIfRunning: false, maxConcurrent: 1 });
    await runCronTriggerSweep(env);

    expect(await fireNextDay()).toMatchObject({ fired: 0, skipped: 1 });
    expect(executions().at(-1)).toEqual({
      status: 'skipped',
      skipReason: 'concurrent_limit',
      taskId: null,
    });
  });
});
