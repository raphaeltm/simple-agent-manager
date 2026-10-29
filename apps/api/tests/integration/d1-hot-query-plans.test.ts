import { readdirSync, readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { projectDataArchiveCandidateSql } from '../../src/scheduled/project-data-archive-sharding';
import { selectStuckTaskCandidates } from '../../src/scheduled/stuck-tasks';
import { WORKSPACE_UPLOAD_CONTEXT_QUERY } from '../../src/services/workspace-resource-history';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const migrationDirectory = new URL('../../src/db/migrations/', import.meta.url);
const migration = readFileSync(
  new URL('0211_d1_hot_query_indexes.sql', migrationDirectory),
  'utf8'
);
describe('incident hot queries on representative SQLite cardinality', () => {
  let sqlite: Database.Database;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.tasks,
      schema.workspaces,
      schema.sessionSummaries,
      schema.sessionSnapshots,
      schema.projectDataArchiveMigrations,
      schema.projectDataSessionLocations,
      schema.projectDataArchiveCircuitBreakers,
      schema.agentSessions,
      schema.agentProfiles,
      schema.skills,
    ]);
    // Apply the actual pre-existing index definitions, not an unrealistically index-free DB.
    const tables = new Set(
      (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name)
    );
    for (const filename of readdirSync(migrationDirectory).filter(
      (f) => f.endsWith('.sql') && f < '0211'
    )) {
      const sql = readFileSync(new URL(filename, migrationDirectory), 'utf8').replace(
        /--[^\n]*/g,
        ''
      );
      for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX[^;]+;/g)) {
        const table = match[0].match(/\bON\s+(\w+)/i)?.[1];
        if (table && tables.has(table))
          sqlite.exec(
            match[0]
              .replace(/CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ')
              .replace(/IF NOT EXISTS IF NOT EXISTS /, 'IF NOT EXISTS ')
          );
      }
    }
    const task = sqlite.prepare(
      'INSERT INTO tasks(id,project_id,user_id,status,updated_at,chat_session_id,workspace_id) VALUES (?,?,?,?,?,?,?)'
    );
    const session = sqlite.prepare(
      'INSERT INTO session_summaries(id,project_id,status,message_count,ended_at,updated_at) VALUES (?,?,?,?,?,?)'
    );
    const journal = sqlite.prepare(
      'INSERT INTO project_data_archive_migrations(migration_id,project_id,session_id,state,error_code,updated_at) VALUES (?,?,?,?,?,?)'
    );
    const workspace = sqlite.prepare(
      'INSERT INTO workspaces(id,project_id,node_id,status) VALUES (?,?,?,?)'
    );
    sqlite.transaction(() => {
      for (let i = 0; i < 12000; i++) {
        const id = String(i).padStart(5, '0');
        task.run(
          `task-${id}`,
          'project',
          'user',
          i < 11900 ? 'completed' : 'in_progress',
          '2026-10-28T12:00:00.000Z',
          `chat-${id}`,
          `workspace-${id}`
        );
        if (i < 8000) {
          session.run(`session-${id}`, 'project', 'stopped', 10000 - i, 1, i);
          journal.run(
            `journal-${id}`,
            'project',
            `session-${id}`,
            'frozen',
            'precopy_refused',
            200
          );
          workspace.run(`workspace-${id}`, 'project', `node-${id}`, 'running');
        }
      }
    })();
    sqlite.exec('ANALYZE');
  });
  afterEach(() => sqlite.close());
  const plan = (db: Database.Database, sql: string, params: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((r) => r.detail)
      .join('\n');

  it('preserves existing rows and makes active keyset pages seek through equal timestamps and wrap', async () => {
    const before = sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
    sqlite.exec(migration);
    expect(sqlite.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
    let cursor = JSON.stringify({ updatedAt: '2026-10-28T12:00:00.000Z', taskId: 'task-11997' });
    const db = createSqliteD1(sqlite);
    const queries: { sql: string; params: unknown[] }[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      return {
        ...statement,
        bind: (...params: unknown[]) => {
          queries.push({ sql, params });
          return statement.bind(...params);
        },
      } as D1PreparedStatement;
    };
    const env = { DATABASE: db, KV: { get: async () => cursor } } as unknown as Env;
    const result = await selectStuckTaskCandidates(env, 5);
    expect(result.tasks.map((t) => t.id)).toEqual([
      'task-11998',
      'task-11999',
      'task-11900',
      'task-11901',
      'task-11902',
    ]);
    expect(result.wrapped).toBe(true);
    for (const { sql, params } of queries) {
      expect(plan(sqlite, sql, params)).toContain(
        'SEARCH tasks USING INDEX idx_tasks_active_updated_id'
      );
      expect(plan(sqlite, sql, params)).not.toContain('TEMP B-TREE');
    }
    cursor = JSON.stringify(result.nextCursor);
    expect((await selectStuckTaskCandidates(env, 2)).tasks.map((t) => t.id)).toEqual([
      'task-11903',
      'task-11904',
    ]);
  });

  it('probes archive refusals by session while retaining eligibility, ranking and preservation exclusions', () => {
    const sql = projectDataArchiveCandidateSql(true);
    const params = [10000, 100, '2026-10-29', 'precopy_refused', 100, 5];
    expect(plan(sqlite, sql, params)).toContain('TEMP B-TREE');
    sqlite.exec(migration);
    const optimized = plan(sqlite, sql, params);
    expect(optimized).toContain('idx_archive_migrations_session_refusal');
    expect(optimized).toContain('idx_session_summaries_archive_rank');
    expect(optimized).not.toContain('TEMP B-TREE');
    // Existing refusal markers exclude every row. Expiring only selected markers allows work.
    expect(sqlite.prepare(sql).all(...params)).toEqual([]);
    sqlite.exec(
      "UPDATE project_data_archive_migrations SET updated_at=0 WHERE session_id IN ('session-00000','session-00001','session-00002','session-00003','session-00004','session-00005')"
    );
    sqlite.exec(
      "INSERT INTO session_snapshots(id,chat_session_id,status,expires_at) VALUES ('snapshot','session-00000','available','2027-01-01')"
    );
    sqlite.exec(
      "INSERT INTO project_data_session_locations(project_id,session_id,location_state) VALUES ('project','session-00001','archive_shard')"
    );
    expect(sqlite.prepare(sql).all(...params)).toEqual(
      [2, 3, 4, 5].map((i) => ({
        project_id: 'project',
        session_id: `session-0000${i}`,
        message_count: 10000 - i,
      }))
    );
    sqlite.exec(
      "INSERT INTO project_data_archive_circuit_breakers(project_id,state) VALUES ('project','open')"
    );
    expect(sqlite.prepare(sql).all(...params)).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) n FROM session_summaries').get()).toEqual({ n: 8000 });
  });

  it('uses selective indexes for workspace admission and wide task metadata pages', () => {
    const sql =
      'SELECT id FROM workspaces WHERE node_id=? AND project_id=? AND status IN (?,?,?) LIMIT ?';
    const params = ['node-00001', 'project', 'running', 'creating', 'recovering', 1];
    const metadata = `SELECT id,chat_session_id,status FROM tasks WHERE project_id=? AND chat_session_id IN (${Array(89).fill('?').join(',')})`;
    const ids = Array.from({ length: 89 }, (_, i) => `chat-${String(i).padStart(5, '0')}`);
    const expected = sqlite.prepare(metadata).all('project', ...ids);
    sqlite.exec(migration);
    expect(plan(sqlite, sql, params)).toContain(
      'COVERING INDEX idx_workspaces_node_project_status'
    );
    expect(plan(sqlite, metadata, ['project', ...ids])).toContain('idx_tasks_project_chat_session');
    expect(sqlite.prepare(metadata).all('project', ...ids)).toEqual(expected);
    expect(sqlite.prepare(metadata).all('other', ...ids)).toEqual([]);
  });

  it('resolves runtime task identity from the one target workspace instead of scanning all tasks', () => {
    sqlite.exec(migration);
    const sql = WORKSPACE_UPLOAD_CONTEXT_QUERY;
    const params = [
      'workspace-00001',
      'project',
      null,
      null,
      null,
      'chat-00001',
      'chat-00001',
      'chat-00001',
      null,
    ];
    expect(plan(sqlite, sql, params)).toContain('SEARCH t USING INDEX');
    expect(plan(sqlite, sql, params)).not.toContain('SCAN t USING INDEX');
    expect(sqlite.prepare(sql).get(...params)).toMatchObject({
      id: 'workspace-00001',
      project_id: 'project',
      resolved_task_id: 'task-00001',
    });
    expect(sqlite.prepare(sql).get('workspace-00001', 'other', ...params.slice(2))).toBeUndefined();
    const supplied = [
      'workspace-00001',
      'project',
      'task-00002',
      'task-00002',
      'task-00002',
      'chat-00001',
      'chat-00001',
      'chat-00001',
      'task-00002',
    ];
    expect(sqlite.prepare(sql).get(...supplied)).toMatchObject({ resolved_task_id: null });
  });
});
