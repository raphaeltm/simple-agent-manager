import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import triggersMigration from '../../../src/db/migrations/0036_triggers.sql?raw';
import githubMigration from '../../../src/db/migrations/0057_github_trigger_configs.sql?raw';
import recoveryMigration from '../../../src/db/migrations/0195_github_trigger_recovery.sql?raw';

describe('GitHub trigger recovery additive migration', () => {
  it.each([false, true])(
    'applies to fresh or populated legacy trigger tables (populated=%s)',
    (populated) => {
      const db = new Database(':memory:');
      db.exec(
        'PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE agent_profiles(id TEXT PRIMARY KEY); CREATE TABLE tasks(id TEXT PRIMARY KEY);'
      );
      db.exec(triggersMigration);
      db.exec(githubMigration);
      if (populated) {
        db.exec(
          "INSERT INTO projects VALUES('p'); INSERT INTO users VALUES('u'); INSERT INTO triggers(id,project_id,user_id,name,source_type,prompt_template) VALUES('t','p','u','legacy','github','legacy prompt'); INSERT INTO trigger_executions(id,trigger_id,project_id,status,task_id) VALUES('e','t','p','running','task'); INSERT INTO tasks(id,trigger_execution_id) VALUES('task','e'); INSERT INTO github_webhook_deliveries(id,event_type,decision) VALUES('old','issues','error');"
        );
      }
      db.exec(recoveryMigration);
      if (populated) {
        expect(
          db
            .prepare(
              'SELECT id,task_id,github_delivery_id,submission_recorded_at FROM trigger_executions'
            )
            .get()
        ).toEqual({
          id: 'e',
          task_id: 'task',
          github_delivery_id: null,
          submission_recorded_at: null,
        });
        expect(db.prepare('SELECT id,trigger_execution_id FROM tasks').get()).toEqual({
          id: 'task',
          trigger_execution_id: 'e',
        });
        db.prepare(
          "UPDATE trigger_executions SET github_delivery_id='delivery' WHERE id='e'"
        ).run();
        expect(() =>
          db
            .prepare(
              "INSERT INTO trigger_executions(id,trigger_id,project_id,status,github_delivery_id) VALUES('other','t','p','queued','delivery')"
            )
            .run()
        ).toThrow(/UNIQUE/);
      }
      for (const state of ['pending', 'processing', 'completed', 'exhausted'])
        db.prepare(
          'INSERT INTO github_trigger_inbox(id,event_type,state,available_at,created_at,expires_at) VALUES(?,?,?,?,?,?)'
        ).run(state, 'issues', state, 'now', 'now', 'later');
      expect(db.prepare('SELECT COUNT(*) AS n FROM github_trigger_inbox').get()).toEqual({ n: 4 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.close();
    }
  );
});
