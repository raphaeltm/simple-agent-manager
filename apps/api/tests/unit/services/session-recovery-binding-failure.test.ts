import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { reconcileSessionRecoveryBindingFailure } from '../../../src/services/session-recovery-binding-failure';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = '2026-10-18T22:00:00.000Z';
const FAILED = '2026-10-18T20:10:00.000Z';
const INPUT = {
  chatSessionId: 'chat',
  userId: 'user',
  taskId: 'task',
  recoveryAttemptId: 'attempt',
  staleBefore: '2026-10-18T21:50:00.000Z',
  now: NOW,
};
let sqlite: Database.Database;

function snapshot() {
  return sqlite
    .prepare(
      'SELECT recovery_attempts, recovery_failed_at, recovery_status, recovery_attempt_id FROM session_snapshots'
    )
    .get();
}

describe('reconcile reported workspace-binding failure', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.tasks,
      schema.workspaces,
      schema.nodes,
      schema.sessionSnapshots,
    ]);
    sqlite.exec(`CREATE UNIQUE INDEX workspace_chat_unique ON workspaces(chat_session_id);
      INSERT INTO tasks (id,project_id,user_id,chat_session_id,status,workspace_id,error_message,updated_at)
      VALUES ('task','project','user','chat','sleeping',NULL,
        'D1_ERROR: UNIQUE constraint failed: workspaces.chat_session_id','${FAILED}');
      INSERT INTO workspaces (id,project_id,user_id,chat_session_id,status,runtime_deletion_confirmed_at)
      VALUES ('original','project','user',NULL,'deleted','confirmed'),
        ('retained','project','user','chat','deleted','confirmed'),
        ('recovery','project','user',NULL,'deleted','confirmed');
      INSERT INTO session_snapshots (id,project_id,user_id,workspace_id,recovery_workspace_id,
        chat_session_id,runtime,sleeping_at,recovery_status,recovery_task_id,recovery_attempt_id,
        recovery_claimed_at,recovery_attempts,recovery_failed_at)
      VALUES ('snapshot','project','user','original','recovery','chat','vm','2026-10-18T19:00:00.000Z',
        'waking','task','attempt','2026-10-18T20:00:00.000Z',3,NULL);`);
  });
  afterEach(() => sqlite.close());

  it('records only the durable failure anchor, without resetting attempts or changing ownership', async () => {
    const database = createSqliteD1(sqlite);
    expect(await reconcileSessionRecoveryBindingFailure(database, INPUT)).toBe(FAILED);
    expect(snapshot()).toEqual({
      recovery_attempts: 3,
      recovery_failed_at: FAILED,
      recovery_status: 'waking',
      recovery_attempt_id: 'attempt',
    });
    expect(sqlite.prepare('SELECT id,chat_session_id FROM workspaces ORDER BY id').all()).toEqual([
      { id: 'original', chat_session_id: null },
      { id: 'recovery', chat_session_id: null },
      { id: 'retained', chat_session_id: 'chat' },
    ]);
    expect(await reconcileSessionRecoveryBindingFailure(database, INPUT)).toBeNull();
  });

  it.each([
    ["UPDATE tasks SET user_id='other'"],
    ["UPDATE tasks SET project_id='other'"],
    ["UPDATE tasks SET chat_session_id='other'"],
    ["UPDATE tasks SET id='other'"],
    ["UPDATE tasks SET status='in_progress'"],
    ["UPDATE tasks SET workspace_id='recovery'"],
    ["UPDATE tasks SET error_message='provider unavailable'"],
    ['UPDATE tasks SET error_message=NULL'],
    ["UPDATE tasks SET updated_at='2026-10-18T19:50:00.000Z'"],
    ["UPDATE tasks SET updated_at='2026-10-18T23:00:00.000Z'"],
    ["UPDATE tasks SET updated_at='invalid'"],
    ["UPDATE session_snapshots SET recovery_attempt_id='new-attempt'"],
    ["UPDATE session_snapshots SET recovery_claimed_at='2026-10-18T21:59:00.000Z'"],
    ["UPDATE session_snapshots SET recovery_status='restored'"],
    ['UPDATE session_snapshots SET sleeping_at=NULL'],
    ["UPDATE session_snapshots SET runtime='cf-container'"],
    ["UPDATE workspaces SET status='running' WHERE id='recovery'"],
    ["UPDATE workspaces SET runtime_deletion_confirmed_at=NULL WHERE id='recovery'"],
    ["UPDATE workspaces SET status='running' WHERE id='retained'"],
    ["UPDATE workspaces SET runtime_deletion_confirmed_at=NULL WHERE id='retained'"],
    ["UPDATE workspaces SET project_id='other' WHERE id='retained'"],
    ["UPDATE workspaces SET user_id='other' WHERE id='retained'"],
    ["UPDATE workspaces SET chat_session_id='other' WHERE id='retained'"],
    ["UPDATE workspaces SET status='running' WHERE id='original'"],
    ["UPDATE workspaces SET runtime_deletion_confirmed_at=NULL WHERE id='original'"],
    ["DELETE FROM workspaces WHERE id='original'"],
    ["DELETE FROM workspaces WHERE id='recovery'"],
  ])('refuses insufficient evidence: %s', async (mutation) => {
    sqlite.exec(mutation);
    expect(await reconcileSessionRecoveryBindingFailure(createSqliteD1(sqlite), INPUT)).toBeNull();
    expect(snapshot()).toMatchObject({ recovery_attempts: 3, recovery_failed_at: null });
  });

  it('normalizes the recorded failure time for the existing lexical cooldown predicate', async () => {
    sqlite.exec("UPDATE tasks SET updated_at='2026-10-18 20:10:00'");
    expect(await reconcileSessionRecoveryBindingFailure(createSqliteD1(sqlite), INPUT)).toBe(
      FAILED
    );
    expect(snapshot()).toMatchObject({ recovery_attempts: 3, recovery_failed_at: FAILED });
  });

  it('preserves an existing failure anchor', async () => {
    sqlite.prepare('UPDATE session_snapshots SET recovery_failed_at=?').run(FAILED);
    expect(await reconcileSessionRecoveryBindingFailure(createSqliteD1(sqlite), INPUT)).toBeNull();
    expect(snapshot()).toMatchObject({ recovery_attempts: 3, recovery_failed_at: FAILED });
  });

  it('rechecks a superseded attempt at the SQL write boundary', async () => {
    const database = createSqliteD1(sqlite);
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      sqlite.exec("UPDATE session_snapshots SET recovery_attempt_id='new-attempt'");
      return prepare(sql);
    };
    expect(await reconcileSessionRecoveryBindingFailure(database, INPUT)).toBeNull();
    expect(snapshot()).toMatchObject({
      recovery_attempts: 3,
      recovery_failed_at: null,
      recovery_attempt_id: 'new-attempt',
    });
  });

  it('concurrent reconciliation reports one clean failure and never replenishes attempts', async () => {
    const database = createSqliteD1(sqlite);
    const results = await Promise.all([
      reconcileSessionRecoveryBindingFailure(database, INPUT),
      reconcileSessionRecoveryBindingFailure(database, INPUT),
    ]);
    expect(results.sort()).toEqual([FAILED, null].sort());
    expect(snapshot()).toMatchObject({ recovery_attempts: 3, recovery_failed_at: FAILED });
  });
});
