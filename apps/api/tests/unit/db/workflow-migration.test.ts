import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

let db: Database.Database;
afterEach(() => db?.close());

function migrate(name: string) {
  db.exec(readFileSync(join(process.cwd(), 'src/db/migrations', name), 'utf8'));
}

function checkpoint(taskId: string, kind: string, overrides: Record<string, string> = {}) {
  return {
    task_id: taskId,
    project_id: 'project',
    user_id: 'owner',
    chat_session_id: `session-${taskId}`,
    initial_message_id: `message-${taskId}`,
    initial_status_event_id: `status-${taskId}`,
    source_kind: kind,
    source_id: 'source',
    source_execution_id: `execution-${taskId}`,
    triggered_by: 'mcp',
    intent_fingerprint: `sha256:${'a'.repeat(64)}`,
    accepted_snapshot_json: '{"prompt":"Preserve accepted intent"}',
    branch_name: `sam/${taskId}`,
    task_title: `Task ${taskId}`,
    checkpoint_state: 'start_confirmed',
    project_data_committed_at: '2026-10-20T01:00:00Z',
    runner_start_attempted_at: '2026-10-20T01:01:00Z',
    runner_started_at: '2026-10-20T01:02:00Z',
    terminal_observed_at: '2026-10-20T01:03:00Z',
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T01:03:00Z',
    ...overrides,
  };
}

function insertCheckpoint(row: ReturnType<typeof checkpoint>) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO task_submission_checkpoints (${columns.join(',')}) VALUES (${columns.map((key) => `@${key}`).join(',')})`
  ).run(row);
}

function setup() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), user_id TEXT REFERENCES users(id), status TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), status TEXT);
    CREATE TABLE task_status_events (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, to_status TEXT);
    INSERT INTO users VALUES ('owner');
    INSERT INTO projects VALUES ('project', 'owner');
    INSERT INTO missions VALUES ('mission', 'project', 'owner', 'active');
  `);
  migrate('0160_task_submission_checkpoints.sql');
  for (const kind of ['trigger', 'schedule', 'standing_watch', 'workflow']) {
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(kind, 'project', 'completed');
    db.prepare('INSERT INTO task_status_events VALUES (?, ?, ?)').run(
      `status-${kind}`,
      kind,
      'completed'
    );
    if (kind !== 'workflow') insertCheckpoint(checkpoint(kind, kind));
  }
}

describe('0200 workflow migration', () => {
  it('preserves populated checkpoints, parent rows, foreign keys and index definitions during upgrade', () => {
    setup();
    const rows = db.prepare('SELECT * FROM task_submission_checkpoints ORDER BY task_id').all();
    const parents = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const statuses = db.prepare('SELECT * FROM task_status_events ORDER BY id').all();
    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_submission_checkpoints' ORDER BY name"
      )
      .all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(task_submission_checkpoints)').all();

    migrate('0200_workflow_steps.sql');

    expect(db.prepare('SELECT * FROM task_submission_checkpoints ORDER BY task_id').all()).toEqual(
      rows
    );
    expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(parents);
    expect(db.prepare('SELECT * FROM task_status_events ORDER BY id').all()).toEqual(statuses);
    expect(
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_submission_checkpoints' ORDER BY name"
        )
        .all()
    ).toEqual(indexes);
    expect(db.prepare('PRAGMA foreign_key_list(task_submission_checkpoints)').all()).toEqual(
      foreignKeys
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT status, workflow_plan_json FROM missions').get()).toEqual({
      status: 'active',
      workflow_plan_json: null,
    });

    insertCheckpoint(checkpoint('workflow', 'workflow'));
    expect(
      db
        .prepare("SELECT source_kind FROM task_submission_checkpoints WHERE task_id = 'workflow'")
        .get()
    ).toEqual({ source_kind: 'workflow' });
    db.prepare("DELETE FROM tasks WHERE id = 'trigger'").run();
    expect(
      db.prepare("SELECT * FROM task_submission_checkpoints WHERE task_id = 'trigger'").get()
    ).toBeUndefined();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('retains uniqueness, source validation and parent identity enforcement after the rebuild', () => {
    setup();
    migrate('0200_workflow_steps.sql');
    for (const overrides of [
      { chat_session_id: 'session-trigger' },
      { initial_message_id: 'message-trigger' },
      { initial_status_event_id: 'status-trigger' },
      { source_kind: 'trigger', source_execution_id: 'execution-trigger' },
    ]) {
      expect(() => insertCheckpoint(checkpoint('workflow', 'workflow', overrides))).toThrow(
        /UNIQUE constraint/
      );
    }
    expect(() => insertCheckpoint(checkpoint('workflow', 'invalid'))).toThrow(/CHECK constraint/);
    expect(() =>
      insertCheckpoint(
        checkpoint('workflow', 'workflow', { initial_status_event_id: 'missing-status' })
      )
    ).toThrow(/FOREIGN KEY constraint/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
