/**
 * Policy inject mode (DO migration 080) against a real SQLite engine.
 *
 * Deploying inject modes must not change what any session receives, so every policy that
 * exists before the migration, and every policy created without a mode, must be pinned.
 * An update that does not mention the mode must leave it alone (rule 73).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, runMigrations } from '../../src/do/migrations';
import {
  createPolicy,
  getActivePolicies,
  getPolicy,
  listPolicies,
  updatePolicy,
} from '../../src/do/policies';
import { parsePolicyRow } from '../../src/do/row-schemas';
import { createSqlStorage } from '../fixtures/sql-storage';

const ENV = {} as Parameters<typeof createPolicy>[1];

function migratedDb() {
  const db = new Database(':memory:');
  const sql = createSqlStorage(db);
  runMigrations(sql);
  return { db, sql };
}

describe('policy inject mode migration', () => {
  it('reads every policy that existed before migration 080 as pinned', () => {
    const db = new Database(':memory:');
    try {
      const sql = createSqlStorage(db);
      sql.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      for (const migration of MIGRATIONS) {
        if (migration.name === '080-policy-inject-mode') break;
        migration.run(sql);
        sql.exec('INSERT INTO migrations VALUES (?, ?)', migration.name, 1);
      }
      sql.exec(`INSERT INTO project_policies (id, category, title, content, source, source_session_id,
        confidence, active, scope, expires_at, created_at, updated_at)
        VALUES ('old-rule', 'rule', 'Old rule', 'Body', 'explicit', NULL, 0.9, 1, 'always', NULL, 1, 1),
               ('old-pref', 'preference', 'Old pref', 'Body', 'explicit', NULL, 0.9, 1, 'always', NULL, 2, 2)`);
      const before = db.prepare('SELECT * FROM project_policies ORDER BY id').all();

      runMigrations(sql);
      runMigrations(sql); // idempotent

      const after = db.prepare('SELECT * FROM project_policies ORDER BY id').all();
      expect(after).toEqual(
        before.map((row) => ({ ...(row as Record<string, unknown>), inject_mode: 'pinned' }))
      );
      // Injection order is category ASC, so the preference sorts first.
      expect(getActivePolicies(sql, ENV).map((p) => [p.id, p.injectMode])).toEqual([
        ['old-pref', 'pinned'],
        ['old-rule', 'pinned'],
      ]);
    } finally {
      db.close();
    }
  });
});

describe('policy inject mode writes', () => {
  it('creates pinned by default and on_demand when asked', () => {
    const { db, sql } = migratedDb();
    try {
      const pinned = createPolicy(sql, ENV, 'rule', 'R', 'C', 'explicit', null, 0.9);
      const onDemand = createPolicy(
        sql,
        ENV,
        'rule',
        'R2',
        'C',
        'explicit',
        null,
        0.9,
        'always',
        null,
        'on_demand'
      );
      expect(getPolicy(sql, pinned.id)?.injectMode).toBe('pinned');
      expect(getPolicy(sql, onDemand.id)?.injectMode).toBe('on_demand');
      expect(
        listPolicies(sql, null, true, 10, 0)
          .policies.map((p) => p.injectMode)
          .sort()
      ).toEqual(['on_demand', 'pinned']);
    } finally {
      db.close();
    }
  });

  it('keeps the mode when an update omits it, and changes it in both directions on purpose', () => {
    const { db, sql } = migratedDb();
    try {
      const { id } = createPolicy(
        sql,
        ENV,
        'preference',
        'P',
        'C',
        'explicit',
        null,
        0.9,
        'always',
        null,
        'on_demand'
      );
      expect(updatePolicy(sql, id, { title: 'Renamed' })).toBe(true);
      // Liveness: the supplied field was applied, so the update was not a no-op.
      expect(getPolicy(sql, id)?.title).toBe('Renamed');
      expect(getPolicy(sql, id)?.injectMode).toBe('on_demand');

      updatePolicy(sql, id, { injectMode: 'pinned' });
      expect(getPolicy(sql, id)?.injectMode).toBe('pinned');
      updatePolicy(sql, id, { content: 'New body' });
      expect(getPolicy(sql, id)?.injectMode).toBe('pinned');
      updatePolicy(sql, id, { injectMode: 'on_demand' });
      expect(getPolicy(sql, id)?.injectMode).toBe('on_demand');
    } finally {
      db.close();
    }
  });

  it('parses a missing or unknown stored value as pinned, never as hidden', () => {
    const base = {
      id: 'x',
      category: 'rule',
      title: 'T',
      content: 'C',
      source: 'explicit',
      source_session_id: null,
      confidence: 1,
      active: 1,
      created_at: 1,
      updated_at: 1,
    };
    expect(parsePolicyRow(base).injectMode).toBe('pinned');
    expect(parsePolicyRow({ ...base, inject_mode: null }).injectMode).toBe('pinned');
    expect(parsePolicyRow({ ...base, inject_mode: 'bogus' }).injectMode).toBe('pinned');
    expect(parsePolicyRow({ ...base, inject_mode: 'on_demand' }).injectMode).toBe('on_demand');
  });
});

describe('policy inject mode DO guard', () => {
  it('refuses an unknown inject mode on create and update without writing', () => {
    const { db, sql } = migratedDb();
    try {
      expect(() =>
        createPolicy(
          sql,
          ENV,
          'rule',
          'R',
          'C',
          'explicit',
          null,
          0.9,
          'always',
          null,
          'sometimes' as never
        )
      ).toThrow('injectMode must be one of');
      expect(listPolicies(sql, null, true, 10, 0).total).toBe(0);
      const { id } = createPolicy(sql, ENV, 'rule', 'R', 'C', 'explicit', null, 0.9);
      expect(() => updatePolicy(sql, id, { injectMode: 'never' as never })).toThrow(
        'injectMode must be one of'
      );
      expect(getPolicy(sql, id)?.injectMode).toBe('pinned');
    } finally {
      db.close();
    }
  });
});
