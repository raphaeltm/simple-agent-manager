import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runIncidentTriggerSweep } from '../../../src/scheduled/incident-triggers';
import { claimIncident, resolveIncident } from '../../../src/services/platform-feedback-incidents';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const IMPLEMENTATION_TASK_ID = '01M0YGSPRC0E17FPQMZYW012R8';

function setup(options: { withTrigger?: boolean } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE triggers (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT, status TEXT NOT NULL, source_type TEXT NOT NULL,
      cron_expression TEXT, cron_timezone TEXT, skip_if_running INTEGER NOT NULL DEFAULT 1,
      prompt_template TEXT NOT NULL, agent_profile_id TEXT, skill_id TEXT, task_mode TEXT,
      vm_size_override TEXT, max_concurrent INTEGER NOT NULL DEFAULT 1,
      last_triggered_at TEXT, trigger_count INTEGER NOT NULL DEFAULT 0,
      next_execution_sequence INTEGER NOT NULL DEFAULT 1, next_fire_at TEXT,
      credential_blocked_reason TEXT, credential_blocked_at TEXT, credential_blocked_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE trigger_executions (
      id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, project_id TEXT NOT NULL,
      status TEXT NOT NULL, skip_reason TEXT, event_type TEXT, scheduled_at TEXT,
      started_at TEXT, completed_at TEXT, sequence_number INTEGER NOT NULL,
      rendered_prompt TEXT, task_id TEXT, error_message TEXT, created_at TEXT NOT NULL);
    CREATE TABLE platform_feedback_triages (
      signature TEXT PRIMARY KEY, source TEXT NOT NULL, summary TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, occurrence_count INTEGER NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error', evidence_refs TEXT NOT NULL, diagnosis_id TEXT, idea_id TEXT, claim_token TEXT,
      claim_expires_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_reason TEXT, last_failed_at INTEGER, rejected_at INTEGER,
      budget_deferred_until INTEGER, budget_deferred_reason TEXT,
      budget_defer_count INTEGER NOT NULL DEFAULT 0, last_budget_deferred_at INTEGER,
      queue_state TEXT NOT NULL DEFAULT 'resolved', queued_at INTEGER,
      dispatch_lease_token TEXT, dispatch_lease_expires_at INTEGER,
      dispatched_trigger_id TEXT, dispatched_execution_id TEXT, dispatched_task_id TEXT,
      dispatched_at INTEGER, dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      incident_claim_token TEXT, incident_claim_expires_at INTEGER,
      incident_claimed_by_task_id TEXT, incident_claimed_at INTEGER,
      resolved_at INTEGER, resolved_by_task_id TEXT, resolution_note TEXT,
      resolution_references TEXT, expired_at INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO projects VALUES ('feedback-project', 'owner-1', 'Private Feedback');
  `);
  if (options.withTrigger !== false) {
    sqlite.exec(`
    INSERT INTO triggers (
      id, project_id, user_id, name, description, status, source_type, cron_expression,
      cron_timezone, skip_if_running, prompt_template, agent_profile_id, skill_id, task_mode,
      vm_size_override, max_concurrent, last_triggered_at, trigger_count,
      next_execution_sequence, next_fire_at, created_at, updated_at
    ) VALUES (
      'trigger-1', 'feedback-project', 'owner-1', 'Incident backlog', NULL, 'active',
      'incident', NULL, NULL, 1,
      'Investigate private incidents: {{incident.backlogSummary}}',
      NULL, NULL, 'task', NULL, 1, NULL, 0, 1, NULL, '2026-08-21T00:00:00.000Z',
      '2026-08-21T00:00:00.000Z'
    );
  `);
  }
  const env = {
    DATABASE: createSqliteD1(sqlite),
    PLATFORM_FEEDBACK_PROJECT_ID: 'feedback-project',
    PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS: '1000',
    PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS: '2',
    TRIGGER_AUTO_PAUSE_AFTER_FAILURES: '2',
  } as Env;
  return { sqlite, env };
}

function seedIncident(
  sqlite: Database.Database,
  signature: string,
  occurrenceCount = 1,
  state = 'pending'
) {
  sqlite
    .prepare(
      `INSERT INTO platform_feedback_triages
        (signature, source, summary, first_seen_at, last_seen_at, occurrence_count, evidence_refs,
         queue_state, queued_at)
       VALUES (?, 'api', 'Recurring api platform error', 1000, 2000, ?, ?, ?, 1000)`
    )
    .run(
      signature,
      occurrenceCount,
      JSON.stringify([{ errorId: signature, timestamp: 1000 }]),
      state
    );
}

describe('incident trigger sweep', () => {
  it('auto-creates one private incident trigger, dispatches once, and supports resolution', async () => {
    const { sqlite, env } = setup({ withTrigger: false });
    seedIncident(sqlite, 'incident-a', 1);
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-auto-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const first = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });
    const second = await runIncidentTriggerSweep(env, { now: () => 5001, submitter });

    expect(first).toMatchObject({
      enabled: true,
      autoTriggerCreated: 1,
      checked: 1,
      fired: 1,
      pendingIncidents: 1,
    });
    expect(second).toMatchObject({ autoTriggerCreated: 0, fired: 0, pendingIncidents: 0 });
    expect(submitter).toHaveBeenCalledTimes(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM triggers WHERE source_type = 'incident'").get()
    ).toEqual({ count: 1 });
    const trigger = sqlite
      .prepare("SELECT prompt_template FROM triggers WHERE source_type = 'incident'")
      .get() as { prompt_template: string };
    expect(trigger.prompt_template).toContain('triage-only run');
    expect(trigger.prompt_template).toContain('never implement code');
    expect(trigger.prompt_template).toContain('merged code, an open PR, an active dispatched task');
    expect(trigger.prompt_template).toContain('Execute this task using the /do skill.');
    expect(trigger.prompt_template).toContain('dispatchedTaskId');
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM trigger_executions WHERE task_id = ?')
        .get('task-from-auto-trigger')
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT queue_state, dispatched_task_id, dispatch_attempts
           FROM platform_feedback_triages WHERE signature = 'incident-a'`
        )
        .get()
    ).toEqual({
      queue_state: 'dispatched',
      dispatched_task_id: 'task-from-auto-trigger',
      dispatch_attempts: 1,
    });

    const claim = await claimIncident(env, 'incident-a', 'task-from-auto-trigger', 5002);
    expect(claim).toEqual({ claimToken: expect.any(String), leaseExpiresAt: expect.any(Number) });
    await expect(
      resolveIncident(
        env,
        'incident-a',
        claim?.claimToken ?? '',
        'resolved',
        'task-from-auto-trigger',
        'fixed by private incident task',
        {
          now: 5003,
          resolutionReferences: { dispatchedTaskId: IMPLEMENTATION_TASK_ID },
        }
      )
    ).resolves.toBe(true);
    expect(
      sqlite.prepare('SELECT queue_state, resolved_by_task_id FROM platform_feedback_triages').get()
    ).toEqual({
      queue_state: 'resolved',
      resolved_by_task_id: 'task-from-auto-trigger',
    });
  });

  it('dispatches one agent for a grouped backlog summary instead of one per occurrence', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, 'incident-a', 5);
    seedIncident(sqlite, 'incident-b', 2);
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ enabled: true, checked: 1, fired: 1, pendingIncidents: 2 });
    expect(submitter).toHaveBeenCalledTimes(1);
    const submission = submitter.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submission.triggeredBy).toBe('incident');
    expect(String(submission.renderedPrompt)).toContain(
      'Pending grouped incidents in this dispatch window: 2'
    );
    expect(String(submission.renderedPrompt)).toContain('Total grouped occurrences represented: 7');
    expect(String(submission.renderedPrompt)).toContain('incident-a');
    expect(String(submission.renderedPrompt)).toContain('incident-b');
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM platform_feedback_triages
           WHERE queue_state = 'dispatched' AND dispatched_task_id = 'task-from-trigger'`
        )
        .get()
    ).toEqual({ count: 2 });
    expect(sqlite.prepare('SELECT status, task_id FROM trigger_executions').get()).toEqual({
      status: 'running',
      task_id: 'task-from-trigger',
    });
  });

  it('does not lease incidents when the incident trigger is already running', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, 'incident-a');
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, event_type, scheduled_at, sequence_number, created_at)
         VALUES ('running-exec', 'trigger-1', 'feedback-project', 'running', 'incident_backlog',
           '2026-08-21T00:00:00.000Z', 1, '2026-08-21T00:00:00.000Z')`
      )
      .run();
    const submitter = vi.fn();

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 0, skipped: 1, pendingIncidents: 1 });
    expect(submitter).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare('SELECT queue_state, dispatched_execution_id FROM platform_feedback_triages')
        .get()
    ).toEqual({ queue_state: 'pending', dispatched_execution_id: null });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM trigger_executions WHERE status = 'skipped'")
        .get()
    ).toEqual({ count: 1 });
  });

  it('releases incident dispatch leases when task submission fails', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, 'incident-a');
    const submitter = vi.fn(async () => {
      throw new Error('canary submission failure');
    });

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 0, failed: 1 });
    expect(
      sqlite
        .prepare(
          'SELECT queue_state, dispatched_execution_id, dispatch_lease_expires_at FROM platform_feedback_triages'
        )
        .get()
    ).toEqual({
      queue_state: 'pending',
      dispatched_execution_id: null,
      dispatch_lease_expires_at: null,
    });
    expect(sqlite.prepare('SELECT status, error_message FROM trigger_executions').get()).toEqual({
      status: 'failed',
      error_message: 'canary submission failure',
    });
  });

  it('surfaces auto-paused incident triggers while leaving incidents pending', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, 'incident-a');
    const insert = sqlite.prepare(
      `INSERT INTO trigger_executions
        (id, trigger_id, project_id, status, event_type, scheduled_at, completed_at, sequence_number, created_at)
       VALUES (?, 'trigger-1', 'feedback-project', 'failed', 'incident_backlog',
        '2026-08-21T00:00:00.000Z', '2026-08-21T00:01:00.000Z', ?, ?)`
    );
    insert.run('failed-2', 2, '2026-08-21T00:02:00.000Z');
    insert.run('failed-1', 1, '2026-08-21T00:01:00.000Z');
    const submitter = vi.fn();

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 0, skipped: 1, pendingIncidents: 1 });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status, next_fire_at FROM triggers').get()).toEqual({
      status: 'paused',
      next_fire_at: null,
    });
    expect(sqlite.prepare('SELECT queue_state FROM platform_feedback_triages').get()).toEqual({
      queue_state: 'pending',
    });
  });
});
