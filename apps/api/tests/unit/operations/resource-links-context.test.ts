import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/project-data', () => ({ getResourceLinkSnapshot: snapshot }));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: vi
    .fn()
    .mockResolvedValue([
      { value: 300000 },
      { value: 100 },
      { value: 100 },
      { value: 100000 },
      { value: 1 },
      { value: 500 },
    ]),
}));

import { MIGRATIONS } from '../../../src/durable-objects/migrations';
import { getLinkSnapshot, recordLink } from '../../../src/durable-objects/project-data/links';
import type { Env } from '../../../src/env';
import { getIdeaContext } from '../../../src/operations/link-core';
import { resolveAdminSettingDetailsMany } from '../../../src/services/admin-settings';
import { createSqlStorage } from '../durable-objects/sql-storage-test-utils';

function d1Database(db: Database.Database): D1Database {
  const prepare = (query: string) => ({
    bind: (...args: unknown[]) => ({
      query,
      args,
      first: async () => db.prepare(query).get(...args) ?? null,
    }),
  });
  const client = {
    prepare,
    batch: async (statements: Array<{ query: string; args: unknown[] }>) =>
      statements.map((s) => {
        if (s.args.length > 100) throw new Error('D1 bound-parameter limit exceeded');
        return { success: true, results: db.prepare(s.query).all(...s.args) };
      }),
  };
  return client as unknown as D1Database;
}

describe('idea linked context', () => {
  it('resolves more than 100 linked files without exceeding D1 parameter limits', async () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,
          chat_session_id TEXT,output_pr_url TEXT);
        CREATE TABLE project_files(id TEXT PRIMARY KEY,project_id TEXT,filename TEXT,directory TEXT);
        CREATE TABLE task_pull_request_associations(task_id TEXT,project_id TEXT,pr_url TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,repository TEXT);
        INSERT INTO tasks VALUES ('idea1','p','Feature','draft',NULL,NULL);
        INSERT INTO projects VALUES ('p','o/r');`);
      const ids = Array.from({ length: 120 }, (_, index) => `file-${index}`);
      const insert = db.prepare("INSERT INTO project_files VALUES (? ,'p',?,'/')");
      for (const id of ids) insert.run(id, `${id}.md`);
      snapshot.mockResolvedValueOnce({
        exists: true,
        links: ids.map((id, index) => ({
          sourceKind: 'idea',
          sourceId: 'idea1',
          targetKind: 'file',
          targetId: id,
          relation: 'linked',
          origin: 'explicit',
          context: null,
          firstAt: index,
          lastAt: index,
          hitCount: 1,
        })),
        sessions: [],
        totals: { sessions: 0, strongSessions: 0, ideas: 0, files: 120, prs: 0 },
      });
      vi.mocked(resolveAdminSettingDetailsMany).mockResolvedValueOnce([
        { value: 300000 },
        { value: 100 },
        { value: 100 },
        { value: 100000 },
        { value: 150 },
        { value: 500 },
      ] as never);
      const context = await getIdeaContext({ DATABASE: d1Database(db) } as Env, 'p', 'idea1');
      expect(context.files.items).toHaveLength(120);
      expect(context.files.total).toBe(120);
    } finally {
      db.close();
    }
  });
  it('includes strong session assets, excludes read-only session assets, and discloses caps', async () => {
    const db = new Database(':memory:');
    try {
      const sql = createSqlStorage(db);
      db.exec(`CREATE TABLE chat_sessions(id TEXT PRIMARY KEY,topic TEXT,status TEXT,
        updated_at INTEGER,task_id TEXT);
        CREATE TABLE chat_session_ideas(session_id TEXT,task_id TEXT,context TEXT,created_at INTEGER);
        CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,
          chat_session_id TEXT,output_pr_url TEXT);
        CREATE TABLE project_files(id TEXT PRIMARY KEY,project_id TEXT,filename TEXT,directory TEXT);
        CREATE TABLE task_pull_request_associations(task_id TEXT,project_id TEXT,pr_url TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,repository TEXT);
        INSERT INTO chat_sessions VALUES ('s1','Work','active',100,'t1'),
          ('s2','Research','active',90,'t2');
        INSERT INTO tasks VALUES
          ('idea1','p','Feature','draft',NULL,NULL),('idea2','p','Related','draft',NULL,NULL),
          ('t1','p','Task 1','in_progress','s1','https://github.com/o/r/pull/1'),
          ('t2','p','Task 2','in_progress','s2','https://github.com/o/r/pull/2');
        INSERT INTO project_files VALUES
          ('f1','p','one.md','/'),('f2','p','two.md','/'),('f3','p','three.md','/');
        INSERT INTO projects VALUES ('p','o/r');`);
      db.exec(`INSERT INTO task_pull_request_associations VALUES
        ('t1','p','https://github.com/O/R/pull/1/'),
        ('t1','p','https://github.com/other/repo/pull/99');`);
      MIGRATIONS.find((m) => m.name === '067-resource-links')?.run(sql);
      const limits = {
        touchIntervalMs: 0,
        weakPerTarget: 100,
        weakCleanupBatchSize: 100,
        projectCap: 1000,
        storageHighWaterBytes: 1000000,
      };
      const add = (
        sourceKind: 'session' | 'idea',
        sourceId: string,
        targetKind: 'idea' | 'file',
        targetId: string,
        relation: 'works_on' | 'read' | 'uploaded' | 'linked' | 'related',
        at: number
      ) =>
        recordLink(
          sql,
          {
            sourceKind,
            sourceId,
            targetKind,
            targetId,
            relation,
            origin: 'explicit',
            context: null,
          },
          limits,
          0,
          at
        );
      add('session', 's1', 'idea', 'idea1', 'works_on', 10);
      add('session', 's2', 'idea', 'idea1', 'read', 9);
      add('session', 's1', 'file', 'f1', 'uploaded', 8);
      add('session', 's2', 'file', 'f2', 'uploaded', 7);
      add('idea', 'idea1', 'file', 'f3', 'linked', 6);
      add('idea', 'idea1', 'idea', 'idea2', 'related', 5);
      recordLink(
        sql,
        {
          sourceKind: 'idea',
          sourceId: 'idea1',
          targetKind: 'pr',
          targetId: 'https://github.com/o/r/pull/1',
          relation: 'linked',
          origin: 'explicit',
          context: null,
        },
        limits,
        0,
        4
      );
      snapshot.mockImplementation(
        async (_env: Env, _project: string, kind: 'idea', id: string, cap: number) =>
          getLinkSnapshot(sql, kind, id, cap)
      );
      const context = await getIdeaContext({ DATABASE: d1Database(db) } as Env, 'p', 'idea1');
      expect(context.sessions.total).toBe(2);
      expect(context.sessions.truncated).toBe(true);
      expect(context.files.total).toBe(2);
      expect(context.files.items.map((f) => f.fileId)).toEqual(['f1']);
      expect(context.pullRequests.items.map((pr) => pr.number)).toEqual([1]);
      expect(context.pullRequests.items[0]?.url).toBe('https://github.com/o/r/pull/1');
      expect(context.pullRequests.total).toBe(1);
      expect(context.pullRequests.totalIsLowerBound).toBe(false);
      expect(context.relatedIdeas.items.map((i) => i.ideaId)).toEqual(['idea2']);
      sql.exec(`INSERT INTO chat_sessions VALUES ('s3','Older work','active',80,'t3')`);
      db.exec(`INSERT INTO tasks VALUES
        ('t3','p','Task 3','in_progress','s3','https://github.com/o/r/pull/3')`);
      add('session', 's3', 'idea', 'idea1', 'works_on', 1);
      const incomplete = await getIdeaContext({ DATABASE: d1Database(db) } as Env, 'p', 'idea1');
      expect(incomplete.pullRequests.totalIsLowerBound).toBe(true);
      expect(incomplete.pullRequests.truncated).toBe(true);
      expect(incomplete.pullRequests.total).toBe(1);
    } finally {
      db.close();
    }
  });
});
