import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

let db: Database.Database;
afterEach(() => db?.close());

function migrate(name: string) {
  db.exec(readFileSync(join(process.cwd(), 'src/db/migrations', name), 'utf8'));
}

function checkpoint(taskId: string, triggeredBy: string, overrides: Record<string, string> = {}) {
  return {
    task_id: taskId,
    project_id: 'project',
    user_id: 'owner',
    chat_session_id: `session-${taskId}`,
    initial_message_id: `message-${taskId}`,
    initial_status_event_id: `status-${taskId}`,
    source_kind: 'trigger',
    source_id: 'trigger-1',
    source_execution_id: `execution-${taskId}`,
    triggered_by: triggeredBy,
    intent_fingerprint: `sha256:${'b'.repeat(64)}`,
    accepted_snapshot_json: '{"prompt":"Preserve accepted intent"}',
    branch_name: `sam/${taskId}`,
    task_title: `Task ${taskId}`,
    checkpoint_state: 'start_confirmed',
    project_data_committed_at: '2026-10-22T01:00:00Z',
    runner_start_attempted_at: '2026-10-22T01:01:00Z',
    runner_started_at: '2026-10-22T01:02:00Z',
    terminal_observed_at: '2026-10-22T01:03:00Z',
    created_at: '2026-10-22T00:00:00Z',
    updated_at: '2026-10-22T01:03:00Z',
    ...overrides,
  };
}

function insertCheckpoint(row: ReturnType<typeof checkpoint>) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO task_submission_checkpoints (${columns.join(',')}) VALUES (${columns.map((key) => `@${key}`).join(',')})`
  ).run(row);
}

const EXISTING_PROVENANCE = ['user', 'cron', 'webhook', 'github', 'incident', 'mcp'];

/** A populated database at migration 0203: checkpoints written by every existing source. */
function setup() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), user_id TEXT REFERENCES users(id), status TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), status TEXT);
    CREATE TABLE task_status_events (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, to_status TEXT);
    CREATE TABLE triggers (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE);
    INSERT INTO users VALUES ('owner');
    INSERT INTO projects VALUES ('project', 'owner');
    INSERT INTO triggers VALUES ('trigger-1', 'project');
  `);
  migrate('0160_task_submission_checkpoints.sql');
  migrate('0202_workflow_steps.sql');
  for (const source of [...EXISTING_PROVENANCE, 'email']) {
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(source, 'project', 'completed');
    db.prepare('INSERT INTO task_status_events VALUES (?, ?, ?)').run(
      `status-${source}`,
      source,
      'completed'
    );
    if (source !== 'email') insertCheckpoint(checkpoint(source, source));
  }
}

const INDEX_QUERY =
  "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_submission_checkpoints' ORDER BY name";

describe('0204 agent email migration', () => {
  it('preserves populated checkpoints, parents, foreign keys and indexes while widening provenance', () => {
    setup();
    const rows = db.prepare('SELECT * FROM task_submission_checkpoints ORDER BY task_id').all();
    const parents = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const statuses = db.prepare('SELECT * FROM task_status_events ORDER BY id').all();
    const indexes = db.prepare(INDEX_QUERY).all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(task_submission_checkpoints)').all();
    expect(rows).toHaveLength(EXISTING_PROVENANCE.length);
    expect(() => insertCheckpoint(checkpoint('email', 'email'))).toThrow(/CHECK constraint/);

    migrate('0204_agent_email_triggers.sql');

    expect(db.prepare('SELECT * FROM task_submission_checkpoints ORDER BY task_id').all()).toEqual(
      rows
    );
    expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(parents);
    expect(db.prepare('SELECT * FROM task_status_events ORDER BY id').all()).toEqual(statuses);
    expect(db.prepare(INDEX_QUERY).all()).toEqual(indexes);
    expect(db.prepare('PRAGMA foreign_key_list(task_submission_checkpoints)').all()).toEqual(
      foreignKeys
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The previous table survives as an archive with every row.
    expect(
      db.prepare('SELECT count(*) AS n FROM task_submission_checkpoints_pre_email').get()
    ).toEqual({ n: EXISTING_PROVENANCE.length });

    insertCheckpoint(checkpoint('email', 'email'));
    expect(
      db
        .prepare("SELECT triggered_by FROM task_submission_checkpoints WHERE task_id = 'email'")
        .get()
    ).toEqual({ triggered_by: 'email' });
  });

  it('keeps rejecting unknown provenance and duplicate identities after the rebuild', () => {
    setup();
    migrate('0204_agent_email_triggers.sql');

    expect(() => insertCheckpoint(checkpoint('email', 'carrier-pigeon'))).toThrow(
      /CHECK constraint/
    );
    expect(() =>
      insertCheckpoint(checkpoint('email', 'email', { chat_session_id: 'session-cron' }))
    ).toThrow(/UNIQUE constraint/);
    expect(() =>
      insertCheckpoint(checkpoint('email', 'email', { initial_status_event_id: 'missing' }))
    ).toThrow(/FOREIGN KEY constraint/);
  });

  it('creates email trigger tables that dedupe inbound messages and cascade with the trigger', () => {
    setup();
    migrate('0204_agent_email_triggers.sql');

    db.prepare(
      "INSERT INTO trigger_email_configs (trigger_id, address_key, allowed_senders_json) VALUES ('trigger-1', 'k3j2h7m9q2xw4n8p', '[\"a@example.com\"]')"
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO trigger_email_configs (trigger_id, address_key) VALUES ('trigger-1', 'another0key00000')"
        )
        .run()
    ).toThrow(/UNIQUE constraint/);

    const insertMessage = db.prepare(
      `INSERT INTO trigger_email_messages
        (id, trigger_id, project_id, direction, status, message_id, from_address, to_address)
       VALUES (?, 'trigger-1', 'project', ?, ?, ?, 'a@example.com', 'agent+k@mail.example.com')`
    );
    insertMessage.run('in-1', 'inbound', 'accepted', '<m1@example.com>');
    expect(() => insertMessage.run('in-2', 'inbound', 'processing', '<m1@example.com>')).toThrow(
      /UNIQUE constraint/
    );
    // Outbound rows never collide with inbound dedupe and may repeat the same thread ID.
    insertMessage.run('out-1', 'outbound', 'sent', '<m1@example.com>');
    insertMessage.run('out-2', 'outbound', 'failed', null);
    expect(() => insertMessage.run('bad', 'inbound', 'teleported', '<m2@example.com>')).toThrow(
      /CHECK constraint/
    );

    db.prepare("DELETE FROM triggers WHERE id = 'trigger-1'").run();
    expect(db.prepare('SELECT count(*) AS n FROM trigger_email_messages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM trigger_email_configs').get()).toEqual({ n: 0 });
  });
});
