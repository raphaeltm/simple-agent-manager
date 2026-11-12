/**
 * A real SQLite-backed D1 that runs a hook once, right after the first read of a
 * chosen table resolves. Tests use it to land a concurrent write at the exact
 * read-then-write midpoint of a handler (rule 62: own the ordering of an ordering bug).
 */
import type Database from 'better-sqlite3';

import { createSqliteD1 } from './sqlite-d1';

export interface RacingD1 {
  d1: D1Database;
  /** Arm the hook: it runs once, after the next completed read of the table. */
  afterNextRead(hook: () => void): void;
  /** True once the armed hook has run, so a test can prove the race was injected. */
  readonly fired: boolean;
}

export function createRacingD1(sqlite: Database.Database, table: string): RacingD1 {
  const base = createSqliteD1(sqlite) as D1Database & {
    prepare(sql: string): D1PreparedStatement;
  };
  const prepare = base.prepare.bind(base);
  let pending: (() => void) | null = null;
  let fired = false;
  const readsTable = (sql: string) =>
    /^\s*select/i.test(sql) && new RegExp(`from\\s+"?${table}"?\\b`, 'i').test(sql);

  const after = <T>(sql: string, promise: Promise<T>): Promise<T> =>
    promise.then((result) => {
      if (pending && readsTable(sql)) {
        const hook = pending;
        pending = null;
        fired = true;
        hook();
      }
      return result;
    });
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      ...statement,
      bind: (...params: unknown[]) => wrap(sql, statement.bind(...params)),
      all: () => after(sql, statement.all()),
      raw: (...args: unknown[]) =>
        after(sql, (statement.raw as (...a: unknown[]) => Promise<unknown>)(...args)),
      first: (...args: unknown[]) =>
        after(sql, (statement.first as (...a: unknown[]) => Promise<unknown>)(...args)),
      run: () => after(sql, statement.run()),
    }) as D1PreparedStatement;

  return {
    d1: { ...base, prepare: (sql: string) => wrap(sql, prepare(sql)) } as D1Database,
    afterNextRead(hook) {
      pending = hook;
      fired = false;
    },
    get fired() {
      return fired;
    },
  };
}
