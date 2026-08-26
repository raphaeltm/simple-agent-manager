import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { submitReport } from '../../../src/services/report-issue';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

function setup() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT,
      updated_by TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      task_mode TEXT NOT NULL,
      dispatch_depth INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      output_pr_url TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE TABLE platform_feedback_triages (
      signature TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      occurrence_count INTEGER NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error',
      evidence_refs TEXT NOT NULL,
      diagnosis_id TEXT,
      idea_id TEXT,
      claim_token TEXT,
      claim_expires_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_reason TEXT,
      last_failed_at INTEGER,
      rejected_at INTEGER,
      budget_deferred_until INTEGER,
      budget_deferred_reason TEXT,
      budget_defer_count INTEGER NOT NULL DEFAULT 0,
      last_budget_deferred_at INTEGER,
      queue_state TEXT NOT NULL DEFAULT 'resolved',
      queued_at INTEGER,
      dispatch_lease_token TEXT,
      dispatch_lease_expires_at INTEGER,
      dispatched_trigger_id TEXT,
      dispatched_execution_id TEXT,
      dispatched_task_id TEXT,
      dispatched_at INTEGER,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      incident_claim_token TEXT,
      incident_claim_expires_at INTEGER,
      incident_claimed_by_task_id TEXT,
      incident_claimed_at INTEGER,
      resolved_at INTEGER,
      resolved_by_task_id TEXT,
      resolution_note TEXT,
      resolution_references TEXT,
      expired_at INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (idea_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    INSERT INTO users VALUES ('env-owner'), ('runtime-owner'), ('reporter-1');
    INSERT INTO projects VALUES
      ('env-feedback-project', 'env-owner', 'Environment Feedback'),
      ('runtime-feedback-project', 'runtime-owner', 'Runtime Feedback');
    INSERT INTO platform_settings (key, value, updated_by)
      VALUES ('feedback.projectId', 'runtime-feedback-project', 'superadmin-1');
  `);

  const env = {
    DATABASE: createSqliteD1(sqlite),
    PLATFORM_FEEDBACK_PROJECT_ID: 'env-feedback-project',
  } as Env;

  return { sqlite, env };
}

describe('report issue effective feedback project config', () => {
  it('creates new report Ideas in the runtime-selected feedback project before env fallback', async () => {
    const { sqlite, env } = setup();

    const result = await submitReport(
      env,
      'reporter-1',
      'Runtime feedback route',
      'This should land in the project selected by the admin UI.',
      false
    );

    expect(result).toMatchObject({ status: 'draft', refsAttached: false });
    const idea = sqlite
      .prepare('SELECT project_id, user_id, created_by, status FROM tasks WHERE id = ?')
      .get(result.ideaId) as Record<string, string>;
    expect(idea).toEqual({
      project_id: 'runtime-feedback-project',
      user_id: 'runtime-owner',
      created_by: 'reporter-1',
      status: 'draft',
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'env-feedback-project'")
        .get()
    ).toEqual({
      count: 0,
    });
  });
});
