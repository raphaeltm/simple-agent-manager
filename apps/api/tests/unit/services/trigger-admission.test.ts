import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { tasks, triggerExecutions, type TriggerRow, triggers } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { admitAndSubmitTriggerExecution } from '../../../src/services/trigger-admission';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-admission-1';
const USER_ID = 'user-admission-1';
const BASE_TIME = '2026-08-26T00:00:00.000Z';

function makeTriggerRow(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: 'trigger-admission-1',
    projectId: PROJECT_ID,
    userId: USER_ID,
    name: 'Admission Trigger',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'run',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextExecutionSequence: 2,
    nextFireAt: null,
    credentialBlockedReason: null,
    credentialBlockedAt: null,
    credentialBlockedBy: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

function setup(overrides: Partial<TriggerRow> = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [tasks, triggers, triggerExecutions]);
  const trigger = makeTriggerRow(overrides);
  sqlite
    .prepare(
      `INSERT INTO triggers
        (id, project_id, user_id, name, description, status, source_type,
         cron_expression, cron_timezone, skip_if_running, prompt_template,
         agent_profile_id, skill_id, task_mode, vm_size_override,
         max_concurrent, last_triggered_at, trigger_count,
         next_execution_sequence, next_fire_at, credential_blocked_reason,
         credential_blocked_at, credential_blocked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      trigger.id,
      trigger.projectId,
      trigger.userId,
      trigger.name,
      trigger.description,
      trigger.status,
      trigger.sourceType,
      trigger.cronExpression,
      trigger.cronTimezone,
      trigger.skipIfRunning ? 1 : 0,
      trigger.promptTemplate,
      trigger.agentProfileId,
      trigger.skillId,
      trigger.taskMode,
      trigger.vmSizeOverride,
      trigger.maxConcurrent,
      trigger.lastTriggeredAt,
      trigger.triggerCount,
      trigger.nextExecutionSequence,
      trigger.nextFireAt,
      trigger.credentialBlockedReason,
      trigger.credentialBlockedAt,
      trigger.credentialBlockedBy,
      trigger.createdAt,
      trigger.updatedAt
    );
  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1(sqlite),
      TRIGGER_AUTO_PAUSE_AFTER_FAILURES: '1',
    } as Env,
    trigger,
  };
}

async function admit(env: Env, trigger: TriggerRow, submitter = vi.fn()) {
  return admitAndSubmitTriggerExecution(
    env,
    {
      trigger,
      eventType: 'cron',
      triggeredBy: 'cron',
      renderPrompt: () => 'run',
    },
    submitter
  );
}

describe('admitAndSubmitTriggerExecution', () => {
  it('keeps a failed execution with a live linked task active for admission and auto-pause', async () => {
    const { sqlite, env, trigger } = setup();
    sqlite.prepare("INSERT INTO tasks (id, status) VALUES ('task-live', 'in_progress')").run();
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, task_id, event_type, scheduled_at,
           completed_at, sequence_number, error_message, created_at)
         VALUES ('exec-live-failed', ?, ?, 'failed', 'task-live', 'cron', ?, ?, 1, ?, ?)`
      )
      .run(
        trigger.id,
        trigger.projectId,
        BASE_TIME,
        BASE_TIME,
        'legacy stale cleanup failed a live task',
        BASE_TIME
      );
    const submitter = vi.fn(async () => ({
      taskId: 'should-not-submit',
      sessionId: 'should-not-submit-session',
      branchName: 'sam/should-not-submit',
    }));

    const result = await admit(env, trigger, submitter);

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'still_running' });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM triggers WHERE id = ?').get(trigger.id)).toEqual({
      status: 'active',
    });
  });

  it('allows a failed execution whose linked task is terminal to free the concurrency slot', async () => {
    const { sqlite, env, trigger } = setup();
    env.TRIGGER_AUTO_PAUSE_AFTER_FAILURES = '10';
    sqlite.prepare("INSERT INTO tasks (id, status) VALUES ('task-done', 'completed')").run();
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, task_id, event_type, scheduled_at,
           completed_at, sequence_number, error_message, created_at)
         VALUES ('exec-terminal-failed', ?, ?, 'failed', 'task-done', 'cron', ?, ?, 1, ?, ?)`
      )
      .run(
        trigger.id,
        trigger.projectId,
        BASE_TIME,
        BASE_TIME,
        'old failed execution after terminal task',
        BASE_TIME
      );
    const submitter = vi.fn(async () => ({
      taskId: 'task-new',
      sessionId: 'session-new',
      branchName: 'sam/new-work',
    }));

    const result = await admit(env, trigger, submitter);

    expect(result).toMatchObject({
      outcome: 'submitted',
      taskId: 'task-new',
      sessionId: 'session-new',
      branchName: 'sam/new-work',
    });
    expect(submitter).toHaveBeenCalledTimes(1);
    expect(
      sqlite
        .prepare(
          `SELECT status, task_id AS taskId
           FROM trigger_executions
           WHERE id != 'exec-terminal-failed'`
        )
        .get()
    ).toEqual({ status: 'running', taskId: 'task-new' });
  });
});
