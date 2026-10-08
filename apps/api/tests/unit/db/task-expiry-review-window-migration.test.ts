import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const directory = join(process.cwd(), 'src/db/migrations');
const filename = '0188_expiry_review_window_backfill.sql';
const projectId = '01M3VR21E3B2G18K084X2ZKCTA';
const cohort = [
  {
    id: '01M3W1QQCPTM787VWRXQZAEGEE',
    taskMode: 'conversation',
    sessionId: '34d5db22-b744-4cc5-aba9-b68a1c993545',
    workspaceId: '01M3W1QVE9H7MWNDBNVKGZFS0A',
    completedAt: '2026-10-08T15:55:58.440Z',
    endedAt: 1791474704653,
    messageCount: 6207,
    transitionId: '01M4E3N038A5SJZVM8BWNPX92D',
    error:
      'Task runtime is no longer live (workspace_deleted); task started 10098 minutes ago. Last step: running (agent active).',
  },
  {
    id: '01M3VY3XJV909HKR9VZ5HEJX5W',
    taskMode: 'task',
    sessionId: 'fcac50e1-c625-4ac5-b527-0d81d225087b',
    workspaceId: '01M3VY3Z1KBWGXM0768VSXX2KR',
    completedAt: '2026-10-08T17:20:56.187Z',
    endedAt: 1791479979576,
    messageCount: 3585,
    transitionId: '01M4E8GJBV4ZWAWEFZW3DB3CAB',
    error:
      'Task runtime is no longer live (workspace_deleted); task started 10215 minutes ago. Last step: awaiting_followup.',
  },
];

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (file >= filename) break;
    db.exec(readFileSync(join(directory, file), 'utf8'));
  }
  db.exec(`INSERT INTO users (id,email,github_id) VALUES ('u','u@example.test','gh');
    INSERT INTO github_installations (id,user_id,installation_id,account_type,account_name)
      VALUES ('i','u','i','User','u');
    INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository,created_by)
      VALUES ('${projectId}','u','p','p','i','org/repo','u');
    BEGIN; PRAGMA defer_foreign_keys = ON;`);
  for (const row of cohort) {
    db.prepare(
      `INSERT INTO tasks
      (id,project_id,user_id,title,status,created_by,task_mode,workspace_id,chat_session_id,
       updated_at,completed_at,error_message,terminal_transition_id)
      VALUES (?,?,'u','Retained conversation','failed','u',?,?,?,?,?,?,?)`
    ).run(
      row.id,
      projectId,
      row.taskMode,
      row.workspaceId,
      row.sessionId,
      row.completedAt,
      row.completedAt,
      row.error,
      row.transitionId
    );
    db.prepare(
      `INSERT INTO workspaces
      (id,user_id,name,repository,branch,status,vm_size,vm_location)
      VALUES (?,'u','w','org/repo','main','deleted','small','nbg1')`
    ).run(row.workspaceId);
    db.prepare(
      `INSERT INTO session_summaries
      (id,project_id,user_id,status,message_count,started_at,updated_at,ended_at)
      VALUES (?,?,'u','stopped',?,1,1,?)`
    ).run(row.sessionId, projectId, row.messageCount, row.endedAt);
    db.prepare(
      `INSERT INTO task_status_events
      (id,task_id,from_status,to_status,actor_type,reason,created_at)
      VALUES (?,?,'in_progress','failed','system',?,?)`
    ).run(`original-${row.id}`, row.id, row.error, row.completedAt);
  }
  // Real unrelated failure and first modern sleeping task, outside the exact cohort.
  db.prepare(
    `INSERT INTO tasks (id,project_id,user_id,title,status,created_by,task_mode,chat_session_id,error_message)
    VALUES ('01M42XKK2P41J0091Q8HQ93YJS',?,'u','Unrelated failure','failed','u','conversation','control-failed','Unrelated failure'),
           ('01M44NMET59G3Q6DM4Y9KHHRHQ',?,'u','Unexpired sleep','sleeping','u','conversation','control-sleeping',NULL)`
  ).run(projectId, projectId);
  for (const session of ['control-failed', 'control-sleeping']) addSnapshot(db, session);
  db.exec('COMMIT');
  return db;
}

function addSnapshot(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `INSERT INTO session_snapshots
    (id,project_id,user_id,chat_session_id,runtime,status,degradation,manifest_r2_key,expires_at,sleeping_at,sleep_status)
    VALUES (?,?,'u',?,'vm','available','none','untouched-artifact','2099-01-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','sleeping')`
  ).run(`snapshot-${sessionId}`, projectId, sessionId);
}

function apply(db: DatabaseSync): void {
  db.exec(readFileSync(join(directory, filename), 'utf8'));
}

function protectedData(db: DatabaseSync) {
  return {
    controls: db
      .prepare("SELECT * FROM tasks WHERE chat_session_id LIKE 'control-%' ORDER BY id")
      .all(),
    snapshots: db.prepare('SELECT * FROM session_snapshots ORDER BY id').all(),
    summaries: db.prepare('SELECT * FROM session_summaries ORDER BY id').all(),
    originalEvents: db
      .prepare("SELECT * FROM task_status_events WHERE id LIKE 'original-%' ORDER BY id")
      .all(),
  };
}

describe('review-window expiry correction migration', () => {
  it('corrects only both observed failures, preserves history and controls, and is idempotent', () => {
    const db = fixture();
    try {
      const before = protectedData(db);
      apply(db);
      for (const row of cohort) {
        expect(
          db
            .prepare(
              'SELECT status,terminal_reason,error_message,completed_at,updated_at,terminal_transition_id FROM tasks WHERE id=?'
            )
            .get(row.id)
        ).toEqual({
          status: 'cancelled',
          terminal_reason: 'snapshot_expired',
          error_message: null,
          completed_at: row.completedAt,
          updated_at: row.completedAt,
          terminal_transition_id: row.transitionId,
        });
        expect(
          db
            .prepare('SELECT from_status,to_status,reason FROM task_status_events WHERE id=?')
            .get(`snapshot-expiry-followup-${row.id}`)
        ).toEqual({
          from_status: 'failed',
          to_status: 'cancelled',
          reason: `snapshot_expired (verified legacy retention correction; prior_error=${row.error})`,
        });
      }
      expect(protectedData(db)).toEqual(before);
      const after = db.prepare('SELECT * FROM task_status_events ORDER BY id').all();
      apply(db);
      expect(db.prepare('SELECT * FROM task_status_events ORDER BY id').all()).toEqual(after);
      expect(protectedData(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.each([
    'updated_at',
    'completed_at',
    'error_message',
    'task_mode',
    'active',
    'snapshot',
    'session',
    'workspace',
  ])('does not correct changed %s evidence', (change) => {
    const db = fixture();
    try {
      for (const row of cohort) {
        if (change === 'task_mode')
          db.prepare('UPDATE tasks SET task_mode=? WHERE id=?').run(
            row.taskMode === 'task' ? 'conversation' : 'task',
            row.id
          );
        else if (change === 'snapshot') addSnapshot(db, row.sessionId);
        else if (change === 'session')
          db.prepare("UPDATE session_summaries SET status='sleeping' WHERE id=?").run(
            row.sessionId
          );
        else if (change === 'workspace')
          db.prepare("UPDATE workspaces SET status='running' WHERE id=?").run(row.workspaceId);
        else if (change === 'active')
          db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(row.id);
        else db.prepare(`UPDATE tasks SET ${change}=? WHERE id=?`).run('changed', row.id);
      }
      const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
      const before = protectedData(db);
      apply(db);
      expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(tasks);
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM task_status_events WHERE id LIKE 'snapshot-expiry-followup-%'"
          )
          .get()
      ).toEqual({ n: 0 });
      expect(protectedData(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});
