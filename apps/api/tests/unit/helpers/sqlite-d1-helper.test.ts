/**
 * Tests for the shared D1 boundary adapter itself.
 *
 * `createSqliteD1` is used by 20+ test files as the "real SQL engine" that `.claude/rules/28`
 * requires for SQL-predicate guards. Two of its behaviours are load-bearing and were, until
 * now, asserted only in comments:
 *
 *  - `batch()` must return populated `results` for row-returning statements. Reporting
 *    `results: []` unconditionally would turn every batched SELECT into "no rows", so an
 *    ownership guard fed the empty set would reject for the wrong reason and its test would
 *    still be green.
 *  - `createSqliteD1WithBindLimit`'s session must not be an escape hatch from the bind limit
 *    the wrapper exists to enforce.
 *
 * Shared infrastructure whose documented behaviour has no test is exactly the trap
 * `.claude/rules/69` describes, so both get one here.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { D1_MAX_BOUND_PARAMETERS } from '../../../src/lib/d1-limits';
import {
  createMemoryKv,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

interface BatchResult {
  success: boolean;
  results: { id: string; label: string }[];
  meta: { changes: number };
}

describe('createSqliteD1 batch()', () => {
  let sqlite: Database.Database;
  let database: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE widgets ("id" TEXT PRIMARY KEY, "label" TEXT)');
    sqlite.prepare('INSERT INTO widgets (id, label) VALUES (?, ?)').run('w1', 'first');
    sqlite.prepare('INSERT INTO widgets (id, label) VALUES (?, ?)').run('w2', 'second');
    database = createSqliteD1(sqlite);
  });

  it('returns the rows of a batched SELECT, not an empty result set', async () => {
    const [result] = (await database.batch([
      database.prepare('SELECT id, label FROM widgets ORDER BY id'),
    ])) as unknown as BatchResult[];

    expect(result?.results).toEqual([
      { id: 'w1', label: 'first' },
      { id: 'w2', label: 'second' },
    ]);
  });

  it('applies bound parameters to a batched SELECT', async () => {
    const [result] = (await database.batch([
      database.prepare('SELECT id, label FROM widgets WHERE id = ?').bind('w2'),
    ])) as unknown as BatchResult[];

    expect(result?.results).toEqual([{ id: 'w2', label: 'second' }]);
  });

  it('reports changes and no rows for a batched write', async () => {
    const [inserted, deleted] = (await database.batch([
      database.prepare('INSERT INTO widgets (id, label) VALUES (?, ?)').bind('w3', 'third'),
      database.prepare('DELETE FROM widgets WHERE id = ?').bind('w1'),
    ])) as unknown as BatchResult[];

    expect(inserted?.results).toEqual([]);
    expect(inserted?.meta.changes).toBe(1);
    expect(deleted?.results).toEqual([]);
    expect(deleted?.meta.changes).toBe(1);

    // Liveness beside the "no rows" assertions: the writes really did land.
    const remaining = sqlite.prepare('SELECT id FROM widgets ORDER BY id').all();
    expect(remaining).toEqual([{ id: 'w2' }, { id: 'w3' }]);
  });

  it('mixes readers and writers in one batch', async () => {
    const [written, read] = (await database.batch([
      database.prepare('INSERT INTO widgets (id, label) VALUES (?, ?)').bind('w4', 'fourth'),
      database.prepare('SELECT id FROM widgets WHERE id = ?').bind('w4'),
    ])) as unknown as BatchResult[];

    expect(written?.meta.changes).toBe(1);
    expect(read?.results).toEqual([{ id: 'w4' }]);
  });

  it('routes a session through the same engine as the binding', async () => {
    const session = database.withSession('first-primary');

    const row = await session
      .prepare('SELECT label FROM widgets WHERE id = ?')
      .bind('w1')
      .first<{ label: string }>();
    const [batched] = (await session.batch([
      session.prepare('SELECT id FROM widgets ORDER BY id'),
    ])) as unknown as BatchResult[];

    expect(row).toEqual({ label: 'first' });
    expect(batched?.results.map((widget) => widget.id)).toEqual(['w1', 'w2']);
  });
});

describe('createSqliteD1WithBindLimit', () => {
  let sqlite: Database.Database;
  let database: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE widgets ("id" TEXT PRIMARY KEY)');
    database = createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS);
  });

  const overLimit = () => Array.from({ length: D1_MAX_BOUND_PARAMETERS + 1 }, (_, i) => `w${i}`);
  const atLimit = () => Array.from({ length: D1_MAX_BOUND_PARAMETERS }, (_, i) => `w${i}`);
  const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

  it('rejects a statement over the bind limit', () => {
    const ids = overLimit();
    expect(() =>
      database.prepare(`SELECT id FROM widgets WHERE id IN (${placeholders(ids.length)})`).bind(...ids)
    ).toThrow(/bind parameter limit exceeded/i);
  });

  it('accepts a statement exactly at the limit (owner-path control)', () => {
    const ids = atLimit();
    expect(() =>
      database.prepare(`SELECT id FROM widgets WHERE id IN (${placeholders(ids.length)})`).bind(...ids)
    ).not.toThrow();
  });

  it('does NOT let a session bypass the limit it exists to enforce', () => {
    const ids = overLimit();
    const session = database.withSession('first-primary');

    expect(() =>
      session.prepare(`SELECT id FROM widgets WHERE id IN (${placeholders(ids.length)})`).bind(...ids)
    ).toThrow(/bind parameter limit exceeded/i);

    // Control: the same session still accepts a statement at the limit, so the assertion above
    // is the limit firing rather than the session being broken outright.
    expect(() =>
      session
        .prepare(`SELECT id FROM widgets WHERE id IN (${placeholders(atLimit().length)})`)
        .bind(...atLimit())
    ).not.toThrow();
  });
});

describe('createMemoryKv', () => {
  it('round-trips text and JSON', async () => {
    const kv = createMemoryKv();

    await kv.put('plain', 'value');
    await kv.put('structured', JSON.stringify({ enabled: true }));

    expect(await kv.get('plain')).toBe('value');
    expect(await kv.get('structured', 'json')).toEqual({ enabled: true });
    expect(await kv.get('absent')).toBeNull();
  });
});
