import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { isNodePastLifetimeAdmissionCutoff } from '../../../src/services/node-lifetime-admission';
import { cleanupNodeProvenanceSql } from '../../../src/services/node-teardown-provenance';
import { buildProvisionedNodeHoldSqlPredicate } from '../../../src/services/provisioned-node-ownership';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

describe('released provisioned-node history', () => {
  let sqlite: Database.Database;
  afterEach(() => sqlite?.close());

  it('retains indexed cleanup and lifetime provenance without retaining a placement hold', async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    createDeclaredIndexes(sqlite, [schema.tasks]);
    sqlite.exec(`
      INSERT INTO nodes(id, user_id, node_class, runtime, node_role, status, created_at)
        VALUES ('rejected', 'user-1', 'managed', 'vm', 'workspace', 'running', '2000-01-01T00:00:00.000Z');
      UPDATE nodes SET task_provisioned = 1 WHERE id = 'rejected';
      WITH RECURSIVE history(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM history WHERE i < 100000)
      INSERT INTO tasks(id, status) SELECT 'old-' || i, 'completed' FROM history;
      INSERT INTO tasks(id, user_id, project_id, status, auto_provisioned_node_id)
        VALUES ('owner', 'user-1', 'project-1', 'queued', NULL);
    `);
    const database = createSqliteD1(sqlite);
    const hold = buildProvisionedNodeHoldSqlPredicate('n', 'contender');
    const cleanupSql = `SELECT n.id FROM nodes n WHERE ${cleanupNodeProvenanceSql('n', true)}`;
    expect(sqlite.prepare(cleanupSql).all()).toEqual([{ id: 'rejected' }]);
    expect(
      sqlite.prepare(`SELECT n.id FROM nodes n WHERE 1=1 ${hold.sql}`).all(...hold.binds)
    ).toEqual([{ id: 'rejected' }]);
    expect(await isNodePastLifetimeAdmissionCutoff(database, 'rejected', 1000)).toBe(true);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${cleanupSql}`).all() as { detail: string }[];

    expect(plan.map((row) => row.detail).join('\n')).not.toMatch(/SCAN auto_task/);
    const holdPlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN SELECT n.id FROM nodes n WHERE 1=1 ${hold.sql}`)
      .all(...hold.binds) as { detail: string }[];
    expect(holdPlan.map((row) => row.detail).join('\n')).toContain(
      'idx_tasks_auto_provisioned_node'
    );
    sqlite.exec("UPDATE nodes SET task_provisioned = 0 WHERE id = 'rejected'");
    expect(sqlite.prepare(cleanupSql).all()).toEqual([]);
    expect(await isNodePastLifetimeAdmissionCutoff(database, 'rejected', 1000)).toBe(false);
  });
});
