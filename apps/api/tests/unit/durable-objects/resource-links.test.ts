import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../../src/durable-objects/migrations';
import {
  getLinkSnapshot,
  listLinksForTargets,
  recordLink,
} from '../../../src/durable-objects/project-data/links';
import { createSqlStorage } from './sql-storage-test-utils';

const limits = {
  touchIntervalMs: 300000,
  weakPerTarget: 2,
  weakCleanupBatchSize: 100,
  projectCap: 100,
  storageHighWaterBytes: 1000000,
};
function setup() {
  const db = new Database(':memory:');
  const sql = createSqlStorage(db);
  sql.exec(`CREATE TABLE chat_sessions(id TEXT PRIMARY KEY,topic TEXT,status TEXT,
    updated_at INTEGER,task_id TEXT)`);
  sql.exec(`CREATE TABLE chat_session_ideas(session_id TEXT,task_id TEXT,context TEXT,
    created_at INTEGER,PRIMARY KEY(session_id,task_id))`);
  sql.exec(`INSERT INTO chat_sessions VALUES ('s1','Topic','active',1000,'task1')`);
  const migration = MIGRATIONS.find((m) => m.name === '067-resource-links')!;
  return { db, sql, migration };
}

describe('resource links real SQLite', () => {
  it('backfills legacy links with relation mapping and can rerun', () => {
    const { db, sql, migration } = setup();
    try {
      sql.exec(`INSERT INTO chat_session_ideas VALUES
        ('s1','idea1','Executed from idea detail page',10),('s1','idea2','Discussion',20)`);
      migration.run(sql);
      migration.run(sql);
      const rows = db
        .prepare('SELECT relation,context FROM resource_links ORDER BY first_at')
        .all() as Array<{ relation: string; context: string }>;
      expect(rows).toEqual([
        { relation: 'works_on', context: 'Executed from idea detail page' },
        { relation: 'linked', context: 'Discussion' },
      ]);
      expect(db.prepare('SELECT link_count FROM resource_link_meta WHERE id=1').get()).toEqual({
        link_count: 2,
      });
    } finally {
      db.close();
    }
  });
  it('throttles repeat weak touches and bounds weak links while keeping strong links', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const cleanupPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM resource_links WHERE target_kind=?
          AND target_id=? AND origin='auto' AND relation IN (?,?,?)
          ORDER BY last_at DESC,id DESC LIMIT ? OFFSET ?`
        )
        .all('idea', 'idea1', 'read', 'viewed', 'discusses', 100, 100);
      expect(JSON.stringify(cleanupPlan)).toContain('idx_resource_links_weak_target');
      const weak = (sourceId: string) => ({
        sourceKind: 'session' as const,
        sourceId,
        targetKind: 'idea' as const,
        targetId: 'idea1',
        relation: 'read' as const,
        origin: 'auto' as const,
        context: null,
      });
      recordLink(sql, weak('s1'), limits, 0, 1000);
      recordLink(sql, weak('s1'), limits, 0, 1001);
      expect(db.prepare('SELECT hit_count FROM resource_links').get()).toMatchObject({
        hit_count: 1,
      });
      sql.exec(`INSERT INTO chat_sessions VALUES ('s2',null,'active',1000,null),
        ('s3',null,'active',1000,null)`);
      recordLink(sql, weak('s2'), limits, 0, 1002);
      recordLink(sql, weak('s3'), limits, 0, 1003);
      expect(db.prepare(`SELECT source_id FROM resource_links ORDER BY last_at`).all()).toEqual([
        { source_id: 's2' },
        { source_id: 's3' },
      ]);
      expect(db.prepare('SELECT link_count FROM resource_link_meta WHERE id=1').get()).toEqual({
        link_count: 2,
      });
      recordLink(
        sql,
        { ...weak('s1'), relation: 'works_on', origin: 'explicit' },
        limits,
        1000001,
        1004
      );
      expect(
        getLinkSnapshot(sql, 'idea', 'idea1').links.some((l) => l.relation === 'works_on')
      ).toBe(true);
    } finally {
      db.close();
    }
  });
  it('bounds snapshot rows while preserving exact unique totals', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const insertSession = db.prepare(`INSERT INTO chat_sessions
        (id,topic,status,updated_at,task_id) VALUES (?,NULL,'active',1000,NULL)`);
      const insertLink = db.prepare(`INSERT INTO resource_links
        (id,source_kind,source_id,target_kind,target_id,relation,origin,first_at,last_at,hit_count)
        VALUES (?,'session',?,'idea','idea1','works_on','explicit',1000,1000,1)`);
      const write = db.transaction(() => {
        for (let n = 0; n < 1200; n++) {
          const id = `session-${n}`;
          insertSession.run(id);
          insertLink.run(`link-${n}`, id);
        }
      });
      write();
      const snapshot = getLinkSnapshot(sql, 'idea', 'idea1', 20);
      expect(snapshot.links).toHaveLength(20);
      expect(snapshot.sessions).toHaveLength(20);
      expect(snapshot.totals.sessions).toBe(1200);
      const batch = listLinksForTargets(sql, 'idea', ['idea1'], 5, 100);
      expect(batch).toHaveLength(5);
      expect(batch.every((link) => link.targetId === 'idea1')).toBe(true);
      const wide = getLinkSnapshot(sql, 'idea', 'idea1', 150);
      expect(wide.sessions).toHaveLength(150);
    } finally {
      db.close();
    }
  });
  it('batches more than 100 target IDs with one JSON parameter', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const insert = db.prepare(`INSERT INTO resource_links
        (id,source_kind,source_id,target_kind,target_id,relation,origin,first_at,last_at,hit_count)
        VALUES (?,'session','s1','idea',?,'works_on','explicit',1,1,1)`);
      const ids = Array.from({ length: 120 }, (_, index) => `idea-${index}`);
      for (const id of ids) insert.run(id, id);
      const rows = listLinksForTargets(sql, 'idea', ids, 1, 120);
      expect(rows).toHaveLength(120);
      expect(new Set(rows.map((row) => row.targetId)).size).toBe(120);
    } finally {
      db.close();
    }
  });
  it('uses the maintained count to reject new weak links at the project cap', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const weak = (targetId: string) => ({
        sourceKind: 'session' as const,
        sourceId: 's1',
        targetKind: 'idea' as const,
        targetId,
        relation: 'read' as const,
        origin: 'auto' as const,
        context: null,
      });
      const capped = { ...limits, projectCap: 1 };
      expect(recordLink(sql, weak('idea1'), capped, 0, 1)).toBe('written');
      expect(recordLink(sql, weak('idea2'), capped, 0, 2)).toBe('skipped_cap');
      expect(db.prepare('SELECT link_count FROM resource_link_meta WHERE id=1').get()).toEqual({
        link_count: 1,
      });
    } finally {
      db.close();
    }
  });
  it('trims a lowered weak target cap on the next new insert when excess fits the batch', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const insert = db.prepare(`INSERT INTO resource_links
        (id,source_kind,source_id,target_kind,target_id,relation,origin,first_at,last_at,hit_count)
        VALUES (?,'session',?,'idea','idea1','read','auto',1,1,1)`);
      for (let index = 0; index < 3; index++) insert.run(`existing-${index}`, `reader-${index}`);
      const input = {
        sourceKind: 'session' as const,
        sourceId: 's1',
        targetKind: 'idea' as const,
        targetId: 'idea1',
        relation: 'read' as const,
        origin: 'auto' as const,
        context: null,
      };
      recordLink(sql, input, { ...limits, weakPerTarget: 2 }, 0, 2);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM resource_links
        WHERE target_kind='idea' AND target_id='idea1'`
          )
          .get()
      ).toEqual({ count: 2 });
      expect(db.prepare('SELECT link_count FROM resource_link_meta WHERE id=1').get()).toEqual({
        link_count: 2,
      });
    } finally {
      db.close();
    }
  });
  it('retains older strong work and its assets ahead of newer weak reads', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const write = db.transaction(() => {
        db.prepare(
          `INSERT INTO resource_links(id,source_kind,source_id,target_kind,target_id,
          relation,origin,first_at,last_at,hit_count) VALUES
          ('work','session','s1','idea','idea1','works_on','explicit',1,1,1),
          ('asset','session','s1','file','file1','uploaded','auto',1,1,1)`
        ).run();
        const insertSession = db.prepare(`INSERT INTO chat_sessions
          (id,topic,status,updated_at,task_id) VALUES (?,NULL,'active',1000,NULL)`);
        const insertRead = db.prepare(`INSERT INTO resource_links
          (id,source_kind,source_id,target_kind,target_id,relation,origin,first_at,last_at,hit_count)
          VALUES (?,'session',?,'idea','idea1','read','auto',1000,1000,1)`);
        for (let n = 0; n < 100; n++) {
          const id = `reader-${n}`;
          insertSession.run(id);
          insertRead.run(id, id);
        }
      });
      write();
      const snapshot = getLinkSnapshot(sql, 'idea', 'idea1', 5);
      expect(
        snapshot.links.some((link) => link.sourceId === 's1' && link.relation === 'works_on')
      ).toBe(true);
      expect(snapshot.links.some((link) => link.targetId === 'file1')).toBe(true);
      expect(snapshot.totals.sessions).toBe(101);
    } finally {
      db.close();
    }
  });
  it('converges toward a lowered weak cap in bounded write batches without deleting strong links', () => {
    const { db, sql, migration } = setup();
    try {
      migration.run(sql);
      const insert = db.prepare(`INSERT INTO resource_links
        (id,source_kind,source_id,target_kind,target_id,relation,origin,first_at,last_at,hit_count)
        VALUES (?,'session',?,'idea','idea1','read','auto',1,1,1)`);
      for (let n = 0; n < 10; n++) insert.run(`weak-${n}`, `reader-${n}`);
      recordLink(
        sql,
        {
          sourceKind: 'session',
          sourceId: 's1',
          targetKind: 'idea',
          targetId: 'idea1',
          relation: 'works_on',
          origin: 'explicit',
          context: null,
        },
        limits,
        0,
        2
      );
      sql.exec(`INSERT INTO chat_sessions VALUES ('s2',null,'active',1000,null),
        ('s3',null,'active',1000,null)`);
      const lowered = { ...limits, weakPerTarget: 2, weakCleanupBatchSize: 4 };
      const weak = {
        sourceKind: 'session' as const,
        sourceId: 's1',
        targetKind: 'idea' as const,
        targetId: 'idea1',
        relation: 'read' as const,
        origin: 'auto' as const,
        context: null,
      };
      const weakCount = () =>
        Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS count FROM resource_links
        WHERE origin='auto'`
              )
              .get() as { count: number }
          ).count
        );
      recordLink(sql, weak, lowered, 0, 3);
      expect(weakCount()).toBe(7);
      recordLink(sql, weak, lowered, 0, 4);
      expect(weakCount()).toBe(7);
      recordLink(sql, { ...weak, sourceId: 's2' }, lowered, 0, 5);
      expect(weakCount()).toBe(4);
      recordLink(sql, { ...weak, sourceId: 's3' }, lowered, 0, 6);
      expect(weakCount()).toBe(2);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM resource_links
        WHERE relation='works_on'`
          )
          .get()
      ).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});
