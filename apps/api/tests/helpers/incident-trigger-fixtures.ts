import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import type { Env } from '../../src/env';
import { createAgentEmailTables } from './agent-email-tables';
import { createSqliteD1 } from './sqlite-d1';

/** Hand-rolled incident-trigger tables shared by the incident sweep tests. */
export function setup(options: { withTrigger?: boolean } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, max_triggers INTEGER);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, recovery_source_task_id TEXT, superseded_by_task_id TEXT, triggered_by TEXT, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
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
      vm_size_override TEXT, resource_requirements_json TEXT,
      max_concurrent INTEGER NOT NULL DEFAULT 1,
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
      severity TEXT NOT NULL DEFAULT 'error', evidence_refs TEXT NOT NULL, diagnosis_id TEXT, idea_id TEXT, idea_owned_at TEXT, claim_token TEXT,
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
      watching_since INTEGER, watch_reason TEXT, watch_hourly_counts TEXT,
      watch_escalated_at INTEGER, watch_escalation_reason TEXT,
      watch_count_floor INTEGER, watch_counted_ids TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO projects VALUES ('feedback-project', 'owner-1', 'Private Feedback', NULL);
  `);
  sqlite.exec(
    readFileSync(
      new URL('../../src/db/migrations/0194_trigger_auto_pause_reset.sql', import.meta.url),
      'utf8'
    )
  );
  sqlite.exec(
    readFileSync(
      new URL('../../src/db/migrations/0195_github_trigger_recovery.sql', import.meta.url),
      'utf8'
    )
  );
  createAgentEmailTables(sqlite);
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

export function seedIncident(
  sqlite: Database.Database,
  options: Partial<Record<string, unknown>> = {}
) {
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
