/**
 * The lineage walk behind sam_team_status, planned on real SQLite with the schema's declared
 * indexes and no ANALYZE stats (production D1's condition). On 2026-11-04 production planned
 * it with `SEARCH child USING INDEX idx_tasks_project_user (project_id=?)`, reading every task
 * in the project for each lineage row. Behavior and project scoping are covered by
 * team-status.test.ts; this file pins the plan of the SQL `readTeamTasks` actually sends.
 */
import { readTeamTasks } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { tasks } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createDeclaredIndexes, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-a';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Real SQLite D1 that records each statement's SQL and bindings as the code sends them. */
function recordingD1(sqlite: Database.Database) {
  const d1 = createSqliteD1(sqlite);
  const sent: { sql: string; params: unknown[] }[] = [];
  const database = new Proxy(d1, {
    get(target, key, receiver) {
      if (key !== 'prepare') return Reflect.get(target, key, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(inner, innerKey, innerReceiver) {
            if (innerKey !== 'bind') return Reflect.get(inner, innerKey, innerReceiver);
            return (...params: unknown[]) => {
              sent.push({ sql, params });
              return inner.bind(...params);
            };
          },
        });
      };
    },
  });
  return { database, sent };
}

describe('readTeamTasks lineage query plan', () => {
  it('walks children by parent index and reads tasks by primary key', async () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    createSchemaTables(sqlite, [tasks]);
    createDeclaredIndexes(sqlite, [tasks]);
    const insert = sqlite.prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, parent_task_id, triggered_by,
         dispatch_depth, task_mode, created_at, updated_at)
       VALUES (?, ?, 'user-1', 't', 'completed', ?, 'user', 0, 'task',
         '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`
    );
    // Production-shaped volume: thousands of unrelated tasks in the same project.
    for (let i = 0; i < 2000; i += 1) insert.run(`bulk-${i}`, PROJECT_ID, null);
    insert.run('root', PROJECT_ID, null);
    insert.run('child-1', PROJECT_ID, 'root');
    insert.run('grandchild-1', PROJECT_ID, 'child-1');

    const { database, sent } = recordingD1(sqlite);
    const result = await readTeamTasks(
      { DATABASE: database } as Env,
      PROJECT_ID,
      { kind: 'task', taskId: 'root' },
      { maxTasks: 10, maxDepth: 5 }
    );
    // Liveness: the walk really ran and found the lineage.
    expect(result.rows.map((row) => row.id).sort()).toEqual(['child-1', 'grandchild-1', 'root']);

    const lineage = sent.find((statement) => statement.sql.includes('WITH RECURSIVE lineage'));
    expect(lineage).toBeDefined();
    const plan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${lineage!.sql}`).all(...lineage!.params) as {
        detail: string;
      }[]
    ).map((row) => row.detail);

    expect(plan.some((detail) => detail.includes('idx_tasks_project_user'))).toBe(false);
    expect(
      plan.some((detail) => /SEARCH child USING INDEX idx_tasks_parent_task_id/.test(detail))
    ).toBe(true);
    expect(
      plan.some((detail) => /SEARCH t USING INDEX sqlite_autoindex_tasks_1 \(id=\?\)/.test(detail))
    ).toBe(true);
    expect(plan.some((detail) => /^SCAN t\b/.test(detail))).toBe(false);
  });
});
