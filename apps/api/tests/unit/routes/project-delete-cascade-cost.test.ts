import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/projects/crud';
import { createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const MIGRATION = '0269_task_deletion_foreign_key_indexes.sql';
const DIRECTORY = join(process.cwd(), 'src/db/migrations');
const TASKS = 650;
const OTHER_TASKS = 1_000;
const CHUNKS = 30_000;
const SUMMARIES = 5_000;
const ARCHIVES = [
  'task_submission_checkpoints_pre_workflow',
  'task_submission_checkpoints_pre_email',
];
let sqlite: Database.Database;
afterEach(() => sqlite?.close());

function migrate(includeFix: boolean) {
  for (const name of readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (!includeFix && name === MIGRATION) continue;
    sqlite.exec(readFileSync(join(DIRECTORY, name), 'utf8'));
  }
}

function insert(table: string, row: Record<string, string | number | null>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function seed() {
  sqlite.transaction(() => {
    for (const owner of ['owner', 'other']) {
      insert('users', { id: owner, email: `${owner}@example.test` });
      insert('github_installations', {
        id: owner,
        user_id: owner,
        installation_id: owner,
        account_type: 'User',
        account_name: owner,
      });
      insert('projects', {
        id: owner,
        user_id: owner,
        name: owner,
        normalized_name: owner,
        installation_id: owner,
        repository: `${owner}/repo`,
        created_by: owner,
      });
      insert('project_members', {
        project_id: owner,
        user_id: owner,
        role: 'owner',
        status: 'active',
      });
      insert('workspaces', {
        id: owner,
        user_id: owner,
        project_id: owner,
        name: owner,
        repository: `${owner}/repo`,
        vm_size: 'small',
        vm_location: 'test',
        status: 'running',
      });
    }
    for (let i = 0; i < TASKS + OTHER_TASKS; i++) {
      const owner = i < TASKS ? 'owner' : 'other';
      insert('tasks', {
        id: `task-${i}`,
        project_id: owner,
        user_id: owner,
        title: `Task ${i}`,
        created_by: owner,
        status: 'completed',
      });
      for (let event = 0; event < 4; event++) {
        insert('task_status_events', {
          id: `event-${i}-${event}`,
          task_id: `task-${i}`,
          to_status: 'completed',
          actor_type: 'user',
        });
      }
      // Both retained tables still own real FKs after their original indexes were moved.
      if (i >= TASKS || i < 50) {
        for (const table of [...ARCHIVES, 'task_submission_checkpoints']) {
          insert(table, {
            task_id: `task-${i}`,
            project_id: owner,
            user_id: owner,
            chat_session_id: `session-${i}`,
            initial_message_id: `message-${i}`,
            initial_status_event_id: `event-${i}-0`,
            source_kind: 'trigger',
            source_id: 'trigger',
            source_execution_id: `execution-${i}`,
            triggered_by: 'user',
            intent_fingerprint: `sha256:${'a'.repeat(64)}`,
            accepted_snapshot_json: '{}',
            branch_name: 'main',
            task_title: `Task ${i}`,
          });
        }
      }
    }
    for (let i = 0; i < SUMMARIES; i++) {
      insert('workspace_resource_summaries', {
        id: `summary-${i}`,
        project_id: 'other',
        workspace_id: 'other',
        task_id: i === 0 ? 'task-0' : `task-${TASKS}`,
        source_version: 1,
        started_at: 1,
        ended_at: 2,
        sample_count: 1,
        completeness_json: '{}',
        summary_json: '{}',
        created_at: 1,
        updated_at: 1,
      });
    }
    for (let i = 0; i < CHUNKS; i++) {
      insert('workspace_resource_chunks', {
        id: `chunk-${i}`,
        project_id: 'other',
        workspace_id: 'other',
        summary_id: `summary-${i % SUMMARIES}`,
        task_id: i === 0 ? 'task-0' : `task-${TASKS}`,
        chunk_sequence: i,
        source_version: 1,
        r2_key: `synthetic/${i}`,
        storage_format: 'test',
        compressed_bytes: 1,
        uncompressed_bytes: 1,
        sha256: 'a'.repeat(64),
        started_at: 1,
        ended_at: 2,
        sample_count: 1,
        completeness_json: '{}',
        summary_json: '{}',
        created_at: 1,
        expires_at: 9999999999999,
      });
    }
    insert('task_dependencies', {
      task_id: `task-${TASKS}`,
      depends_on_task_id: 'task-0',
      created_by: 'other',
    });
  })();
}

function setup(includeFix = true) {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys=ON');
  migrate(includeFix);
  seed();
  const prepared: string[] = [];
  const database = createSqliteD1WithBindLimit(sqlite, 100);
  const env = {
    DATABASE: new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (query: string) => {
            prepared.push(query);
            return target.prepare(query);
          };
        return Reflect.get(target, key, receiver);
      },
    }),
    PROJECT_DATA_ARCHIVE_R2: {
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      delete: vi.fn(),
    },
    R2: { list: vi.fn(async () => ({ objects: [], truncated: false })), delete: vi.fn() },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: 'owner',
        email: 'owner@example.test',
        name: 'Owner',
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: 'session', expiresAt: new Date('2099-01-01') },
    });
    await next();
  });
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ message: error.message }, 500)
  );
  app.route('/api/projects', crudRoutes);
  return { app, env, prepared };
}

function count(table: string, where = '1=1') {
  return (sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get() as { n: number })
    .n;
}

function plan(query: string) {
  return (
    sqlite
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(...Array((query.match(/\?/g) ?? []).length).fill(null)) as { detail: string }[]
  ).map((row) => row.detail);
}

// SQLite does not enforce D1's CPU ceiling. Guard the actual issued SQL's FK plans,
// using the shipped migration chain (including retained archives), without ANALYZE.
describe('project deletion cascade work on the shipped schema', { timeout: 30_000 }, () => {
  it('seeks every task/event child instead of scanning unrelated history per parent', async () => {
    const { app, env, prepared } = setup();
    const response = await app.request('/api/projects/owner', { method: 'DELETE' }, env);
    expect(response.status, await response.text()).toBe(200);
    const deletes = prepared.filter((query) =>
      /^delete from "(tasks|task_status_events)"/.test(query)
    );
    expect(deletes.length).toBeGreaterThan(2);
    for (const query of deletes) {
      const details = plan(query);
      expect(
        details.filter((detail) => /^SCAN /.test(detail)),
        details.join('\n')
      ).toEqual([]);
    }
    expect(count('projects', "id='owner'")).toBe(0);
    expect(count('tasks')).toBe(OTHER_TASKS);
    expect(count('task_status_events')).toBe(OTHER_TASKS * 4);
    for (const table of [...ARCHIVES, 'task_submission_checkpoints'])
      expect(count(table)).toBe(OTHER_TASKS);
    expect(count('task_dependencies')).toBe(0);
    expect(sqlite.prepare("SELECT project_id FROM workspaces WHERE id='owner'").get()).toEqual({
      project_id: null,
    });
    expect(count('workspace_resource_chunks')).toBe(CHUNKS);
    expect(count('workspace_resource_summaries')).toBe(SUMMARIES);
    for (const table of ['workspace_resource_chunks', 'workspace_resource_summaries']) {
      expect(count(table, 'task_id IS NULL')).toBe(1);
      expect(count(table, `task_id='task-${TASKS}'`)).toBe(
        table.endsWith('chunks') ? CHUNKS - 1 : SUMMARIES - 1
      );
    }
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The unrelated workspace still supports ordinary reads and writes afterward.
    await env.DATABASE.prepare('UPDATE workspaces SET last_activity_at=? WHERE id=?')
      .bind('now', 'other')
      .run();
    expect(
      await env.DATABASE.prepare('SELECT last_activity_at FROM workspaces WHERE id=?')
        .bind('other')
        .first()
    ).toEqual({ last_activity_at: 'now' });
  });

  it('rejects another project before the mutation batch or storage cleanup', async () => {
    const { app, env, prepared } = setup();
    const response = await app.request('/api/projects/other', { method: 'DELETE' }, env);
    expect(response.status).toBe(404);
    expect(prepared.some((query) => /^delete /i.test(query))).toBe(false);
    expect(count('projects', "id='other'")).toBe(1);
    expect(count('workspace_resource_chunks')).toBe(CHUNKS);
    expect(env.R2.list).not.toHaveBeenCalled();
  });

  it('upgrades populated archives additively and leaves the foreign-key graph unchanged', () => {
    setup(false);
    const before = ARCHIVES.map((table) => ({
      count: count(table),
      fks: sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all(),
    }));
    sqlite.exec(readFileSync(join(DIRECTORY, MIGRATION), 'utf8'));
    expect(
      ARCHIVES.map((table) => ({
        count: count(table),
        fks: sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all(),
      }))
    ).toEqual(before);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const query of [
      'DELETE FROM tasks WHERE project_id=?',
      'DELETE FROM task_status_events WHERE task_id=?',
    ]) {
      const details = plan(query);
      expect(
        details.filter((detail) => /^SCAN /.test(detail)),
        details.join('\n')
      ).toEqual([]);
    }
  });
});
