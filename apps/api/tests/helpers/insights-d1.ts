/**
 * Shared harnesses for the Insights operation tests:
 * - `countD1RoundTrips` wraps an env's D1 binding so a test can assert a read's round-trip budget
 *   (`.claude/rules/60`): every statement execution and every `batch()` counts as one trip.
 * - `createPlanHarness` builds a real SQLite with production's schema and declared indexes and a
 *   D1 binding that records the SQL an operation issues, so a test can assert the query plan of
 *   exactly that SQL (`.claude/rules/69`, "D1 CPU is a ceiling too").
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createOperationPorts } from '../../src/operation-ports';
import { createAllSchemaTables, createDeclaredIndexes, createSqliteD1 } from './sqlite-d1';

/** Wrap `env.DATABASE`; `trips()` reads the count and `reset()` zeroes it. */
export function countD1RoundTrips(env: Env): { env: Env; trips: () => number; reset: () => void } {
  const real = env.DATABASE;
  let trips = 0;
  const counted =
    (fn: unknown) =>
    async (...args: unknown[]) => {
      trips += 1;
      return (fn as (...x: unknown[]) => unknown)(...args);
    };
  const wrap = <T extends Record<string, unknown>>(statement: T): T => ({
    ...statement,
    all: counted(statement.all),
    first: counted(statement.first),
    run: counted(statement.run),
    raw: counted(statement.raw),
  });
  const wrapped = {
    ...env,
    DATABASE: {
      ...real,
      prepare: (sql: string) => {
        const statement = real.prepare(sql) as unknown as Record<string, unknown>;
        return {
          ...wrap(statement),
          bind: (...params: unknown[]) =>
            wrap((statement.bind as (...p: unknown[]) => Record<string, unknown>)(...params)),
        };
      },
      batch: async (statements: unknown[]) => {
        trips += 1;
        return (real.batch as (s: unknown[]) => unknown)(statements);
      },
    },
  } as unknown as Env;
  return {
    env: wrapped,
    trips: () => trips,
    reset: () => {
      trips = 0;
    },
  };
}

export interface PlanHarness {
  sqlite: Database.Database;
  /** An operation context whose D1 binding records every SQL string it prepares. */
  ctx: (userId: string) => OperationContext;
  statements: string[];
  /** `EXPLAIN QUERY PLAN` of `query`, with every placeholder bound to null. */
  plan: (query: string) => string[];
}

/** A real SQLite with every table and declared index; seed it through `sqlite`. */
export function createPlanHarness(): PlanHarness {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  createDeclaredIndexes(
    sqlite,
    Object.values(schema).filter((value): value is SQLiteTable => is(value, SQLiteTable))
  );
  const statements: string[] = [];
  const base = createSqliteD1(sqlite);
  const d1 = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => {
          statements.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env = { DATABASE: d1, BASE_DOMAIN: 'example.test' } as unknown as Env;
  return {
    sqlite,
    statements,
    ctx: (userId) => ({
      env,
      ports: createOperationPorts(env),
      requestId: 'plan',
      actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
    }),
    plan: (query) => {
      const placeholders = (query.match(/\?/g) ?? []).length;
      return (
        sqlite
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(...Array.from({ length: placeholders }, () => null)) as { detail: string }[]
      ).map((row) => row.detail);
    },
  };
}
