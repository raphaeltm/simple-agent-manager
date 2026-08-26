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
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
      task_mode TEXT NOT NULL, dispatch_depth INTEGER NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE debug_diagnoses (
      id TEXT PRIMARY KEY, error_id TEXT, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      diagnosis TEXT NOT NULL, model TEXT NOT NULL, turns INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      daily_tokens_used INTEGER NOT NULL, daily_token_limit INTEGER NOT NULL,
      idea_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
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
    CREATE TABLE task_status_events (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, reason TEXT, created_at TEXT NOT NULL);
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
    PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE: '1',
    TRIGGER_AUTO_PAUSE_AFTER_FAILURES: '2',
  } as Env;
  return { sqlite, env };
}

function seedIncident(sqlite: Database.Database, options: Partial<Record<string, unknown>> = {}) {
  const signature = String(options.signature ?? 'incident-a');
  sqlite
    .prepare(
      `INSERT INTO platform_feedback_triages
        (signature, source, summary, first_seen_at, last_seen_at, occurrence_count, evidence_refs,
         severity, diagnosis_id, idea_id, queue_state, queued_at, last_failure_reason,
         budget_deferred_until, resolved_by_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      signature,
      options.source ?? 'api',
      options.summary ?? 'Recurring api platform error',
      options.first_seen_at ?? 1000,
      options.last_seen_at ?? 2000,
      options.occurrence_count ?? 1,
      options.evidence_refs ?? JSON.stringify([{ errorId: signature, timestamp: 1000 }]),
      options.severity ?? 'error',
      options.diagnosis_id ?? null,
      options.idea_id ?? null,
      options.queue_state ?? 'pending',
      options.queued_at ?? 1000,
      options.last_failure_reason ?? null,
      options.budget_deferred_until ?? null,
      options.resolved_by_task_id ?? null
    );
  return signature;
}

function createD1ThatFailsSecondDispatchReservation(sqlite: Database.Database): D1Database {
  const database = createSqliteD1(sqlite) as D1Database & {
    prepare(sql: string): D1PreparedStatement;
  };
  let reservationUpdates = 0;

  return {
    ...database,
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      if (!sql.includes("UPDATE platform_feedback_triages SET queue_state = 'dispatched'")) {
        return statement;
      }

      return {
        ...statement,
        bind: (...params: unknown[]) => {
          const bound = statement.bind(...params);
          return {
            ...bound,
            run: async () => {
              reservationUpdates += 1;
              if (reservationUpdates === 2) {
                throw new Error('canary chunk reservation failure');
              }
              return bound.run();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('incident trigger sweep', () => {
  it('auto-creates one private incident trigger, dispatches once, and supports resolution', async () => {
    const { sqlite, env } = setup({ withTrigger: false });
    seedIncident(sqlite, { signature: 'incident-a', occurrence_count: 1 });
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
      dispatch_attempts: 0,
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
    seedIncident(sqlite, { signature: 'incident-a', occurrence_count: 5 });
    seedIncident(sqlite, { signature: 'incident-b', occurrence_count: 2 });
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

  it('skips pending signatures linked to open tracked work while dispatching an unlinked control', async () => {
    const { sqlite, env } = setup();
    const createdAt = '2026-08-21T00:00:00.000Z';
    const insertTask = sqlite.prepare(
      `INSERT INTO tasks (
        id, project_id, user_id, title, description, status, priority, task_mode,
        dispatch_depth, created_by, created_at, updated_at
      ) VALUES (?, 'feedback-project', 'owner-1', ?, 'tracked work', ?, 0, 'task', 0,
        'owner-1', ?, ?)`
    );
    insertTask.run('idea-linked', 'Linked draft idea', 'draft', createdAt, createdAt);
    insertTask.run('diagnosis-idea', 'Linked diagnosis idea', 'ready', createdAt, createdAt);
    insertTask.run('resolver-task', 'Linked resolver task', 'in_progress', createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO debug_diagnoses (
          id, error_id, start_time, end_time, diagnosis, model, turns, input_tokens,
          output_tokens, daily_tokens_used, daily_token_limit, idea_id, created_by, created_at
        ) VALUES ('diagnosis-linked', NULL, ?, ?, 'diagnosis', 'model', 1, 1, 1, 2, 100,
          'diagnosis-idea', 'owner-1', ?)`
      )
      .run(createdAt, createdAt, createdAt);
    seedIncident(sqlite, {
      signature: 'incident-linked-idea',
      summary: 'Existing draft idea',
      idea_id: 'idea-linked',
    });
    seedIncident(sqlite, {
      signature: 'incident-linked-diagnosis',
      summary: 'Existing diagnosis-linked idea',
      diagnosis_id: 'diagnosis-linked',
    });
    seedIncident(sqlite, {
      signature: 'incident-linked-resolution',
      summary: 'Existing resolver task',
      resolved_by_task_id: 'resolver-task',
    });
    seedIncident(sqlite, { signature: 'incident-unlinked', summary: 'Unlinked control' });
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 1, pendingIncidents: 1 });
    expect(submitter).toHaveBeenCalledTimes(1);
    const prompt = String((submitter.mock.calls[0]?.[1] as Record<string, unknown>).renderedPrompt);
    expect(prompt).toContain('Unlinked control');
    expect(prompt).not.toContain('incident-linked-idea');
    expect(prompt).not.toContain('incident-linked-diagnosis');
    expect(prompt).not.toContain('incident-linked-resolution');
    expect(
      sqlite
        .prepare(
          `SELECT signature, queue_state FROM platform_feedback_triages
           ORDER BY signature`
        )
        .all()
    ).toEqual([
      { signature: 'incident-linked-diagnosis', queue_state: 'pending' },
      { signature: 'incident-linked-idea', queue_state: 'pending' },
      { signature: 'incident-linked-resolution', queue_state: 'pending' },
      { signature: 'incident-unlinked', queue_state: 'dispatched' },
    ]);
  });

  it('applies the severity floor so warnings do not consume VM dispatches', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, {
      signature: 'incident-warn',
      summary: 'Warning-only storage alert',
      severity: 'warn',
    });
    seedIncident(sqlite, {
      signature: 'incident-error',
      summary: 'Error control',
      severity: 'error',
    });
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 1, pendingIncidents: 1 });
    const prompt = String((submitter.mock.calls[0]?.[1] as Record<string, unknown>).renderedPrompt);
    expect(prompt).toContain('incident-error');
    expect(prompt).not.toContain('incident-warn');
    expect(
      sqlite
        .prepare('SELECT queue_state FROM platform_feedback_triages WHERE signature = ?')
        .get('incident-warn')
    ).toEqual({ queue_state: 'pending' });
  });

  it('keeps budget-deferred incidents out of automatic dispatch until retry is due', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, {
      signature: 'incident-budget-deferred',
      summary: 'Budget-deferred error',
      budget_deferred_until: 10_000,
    });
    seedIncident(sqlite, {
      signature: 'incident-ready-control',
      summary: 'Ready error control',
    });
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 1, pendingIncidents: 1 });
    const prompt = String((submitter.mock.calls[0]?.[1] as Record<string, unknown>).renderedPrompt);
    expect(prompt).toContain('Ready error control');
    expect(prompt).not.toContain('Budget-deferred error');
    expect(
      sqlite
        .prepare(
          `SELECT signature, queue_state, dispatched_execution_id
           FROM platform_feedback_triages ORDER BY signature`
        )
        .all()
    ).toEqual([
      {
        signature: 'incident-budget-deferred',
        queue_state: 'pending',
        dispatched_execution_id: null,
      },
      {
        signature: 'incident-ready-control',
        queue_state: 'dispatched',
        dispatched_execution_id: expect.any(String),
      },
    ]);
  });

  it('defers a fresh singleton until the dispatch batch or age gate admits it', async () => {
    const { sqlite, env } = setup();
    env.PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE = '2';
    env.PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS = '10000';
    seedIncident(sqlite, { signature: 'incident-fresh', queued_at: 5000 });
    const submitter = vi.fn();

    const result = await runIncidentTriggerSweep(env, { now: () => 6000, submitter });

    expect(result).toMatchObject({ fired: 0, deferredDispatches: 1, pendingIncidents: 1 });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 0,
    });
  });

  it('admits a fresh batch before the minimum pending age elapses', async () => {
    const { sqlite, env } = setup();
    env.PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE = '2';
    env.PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS = '10000';
    seedIncident(sqlite, { signature: 'incident-batch-a', queued_at: 5000 });
    seedIncident(sqlite, { signature: 'incident-batch-b', queued_at: 5000 });
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => 6000, submitter });

    expect(result).toMatchObject({ fired: 1, deferredDispatches: 0, pendingIncidents: 2 });
    expect(submitter).toHaveBeenCalledTimes(1);
  });

  it('admits an aged singleton even when the minimum batch size is not met', async () => {
    const { sqlite, env } = setup();
    env.PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE = '2';
    env.PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS = '10000';
    seedIncident(sqlite, { signature: 'incident-aged', queued_at: 1000 });
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => 12000, submitter });

    expect(result).toMatchObject({ fired: 1, deferredDispatches: 0, pendingIncidents: 1 });
    expect(submitter).toHaveBeenCalledTimes(1);
  });

  it('rate-limits dispatches per incident trigger window', async () => {
    const { sqlite, env } = setup();
    env.PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS = '60000';
    env.PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW = '1';
    const now = Date.parse('2026-08-26T12:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, event_type, scheduled_at, started_at,
           sequence_number, rendered_prompt, task_id, created_at)
         VALUES ('prior-dispatch', 'trigger-1', 'feedback-project', 'running',
           'incident_backlog', ?, ?, 1, 'prompt', 'prior-task', ?)`
      )
      .run(
        new Date(now - 10_000).toISOString(),
        new Date(now - 10_000).toISOString(),
        new Date(now - 10_000).toISOString()
      );
    seedIncident(sqlite, {
      signature: 'incident-a',
      first_seen_at: now - 120_000,
      last_seen_at: now - 1_000,
      queued_at: now - 120_000,
    });
    const submitter = vi.fn(async () => ({
      taskId: 'task-from-trigger',
      sessionId: 'session-1',
      branchName: 'sam/incident-trigger',
    }));

    const result = await runIncidentTriggerSweep(env, { now: () => now, submitter });

    expect(result).toMatchObject({ fired: 0, rateLimitedDispatches: 1, pendingIncidents: 1 });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 1,
    });

    sqlite
      .prepare(
        "UPDATE trigger_executions SET status = 'completed', completed_at = ?, created_at = ? WHERE id = 'prior-dispatch'"
      )
      .run(new Date(now - 119_000).toISOString(), new Date(now - 120_000).toISOString());
    const outsideWindow = await runIncidentTriggerSweep(env, { now: () => now, submitter });

    expect(outsideWindow).toMatchObject({
      fired: 1,
      rateLimitedDispatches: 0,
      pendingIncidents: 1,
    });
    expect(submitter).toHaveBeenCalledTimes(1);
  });

  it('expires a stale singleton once and leaves the second sweep quiet', async () => {
    const { sqlite, env } = setup();
    env.PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS = '10000';
    seedIncident(sqlite, { signature: 'incident-old-singleton', last_seen_at: 1000 });
    seedIncident(sqlite, {
      signature: 'incident-old-repeat',
      occurrence_count: 2,
      severity: 'warn',
      last_seen_at: 1000,
    });
    const submitter = vi.fn();

    const first = await runIncidentTriggerSweep(env, { now: () => 12000, submitter });
    const second = await runIncidentTriggerSweep(env, { now: () => 12001, submitter });

    expect(first).toMatchObject({ expiredIncidents: 1, fired: 0, pendingIncidents: 0 });
    expect(second).toMatchObject({ expiredIncidents: 0, fired: 0, pendingIncidents: 0 });
    expect(submitter).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          `SELECT signature, queue_state, expired_at FROM platform_feedback_triages
           ORDER BY signature`
        )
        .all()
    ).toEqual([
      { signature: 'incident-old-repeat', queue_state: 'pending', expired_at: null },
      { signature: 'incident-old-singleton', queue_state: 'expired', expired_at: 12000 },
    ]);
  });

  it('expires stale singletons in bounded batches across sweeps', async () => {
    const { sqlite, env } = setup();
    env.PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS = '10000';
    env.PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE = '1';
    seedIncident(sqlite, { signature: 'incident-old-a', last_seen_at: 1000 });
    seedIncident(sqlite, { signature: 'incident-old-b', last_seen_at: 1500 });
    seedIncident(sqlite, {
      signature: 'incident-old-repeat',
      occurrence_count: 2,
      severity: 'warn',
      last_seen_at: 1000,
    });
    const submitter = vi.fn();

    const first = await runIncidentTriggerSweep(env, { now: () => 12000, submitter });
    const second = await runIncidentTriggerSweep(env, { now: () => 12001, submitter });
    const third = await runIncidentTriggerSweep(env, { now: () => 12002, submitter });

    expect(first).toMatchObject({ expiredIncidents: 1, fired: 0, pendingIncidents: 0 });
    expect(second).toMatchObject({ expiredIncidents: 1, fired: 0, pendingIncidents: 0 });
    expect(third).toMatchObject({ expiredIncidents: 0, fired: 0, pendingIncidents: 0 });
    expect(submitter).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          `SELECT signature, queue_state, expired_at FROM platform_feedback_triages
           ORDER BY signature`
        )
        .all()
    ).toEqual([
      { signature: 'incident-old-a', queue_state: 'expired', expired_at: 12000 },
      { signature: 'incident-old-b', queue_state: 'expired', expired_at: 12001 },
      { signature: 'incident-old-repeat', queue_state: 'pending', expired_at: null },
    ]);
  });

  it('does not lease incidents when the incident trigger is already running', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, { signature: 'incident-a' });
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
    seedIncident(sqlite, { signature: 'incident-a' });
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

  it('releases earlier incident dispatch chunks when a later reservation chunk fails', async () => {
    const { sqlite, env } = setup();
    for (let index = 0; index < 95; index++) {
      seedIncident(sqlite, { signature: `incident-chunk-${String(index).padStart(2, '0')}` });
    }
    const chunkFailEnv = {
      ...env,
      DATABASE: createD1ThatFailsSecondDispatchReservation(sqlite),
      PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT: '95',
    } as Env;
    const submitter = vi.fn();

    const result = await runIncidentTriggerSweep(chunkFailEnv, { now: () => 5000, submitter });

    expect(result).toMatchObject({ fired: 0, failed: 1, pendingIncidents: 95 });
    expect(submitter).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          `SELECT queue_state, COUNT(*) AS count
           FROM platform_feedback_triages
           GROUP BY queue_state
           ORDER BY queue_state`
        )
        .all()
    ).toEqual([{ queue_state: 'pending', count: 95 }]);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM platform_feedback_triages
           WHERE dispatched_execution_id IS NOT NULL OR dispatch_lease_expires_at IS NOT NULL`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT status, error_message FROM trigger_executions').get()).toEqual({
      status: 'failed',
      error_message: 'canary chunk reservation failure',
    });
  });

  it('surfaces auto-paused incident triggers while leaving incidents pending', async () => {
    const { sqlite, env } = setup();
    seedIncident(sqlite, { signature: 'incident-a' });
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
