import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { generateEncryptionKey } from '../../src/services/encryption';
import { createSchemaTables, createSqliteD1 } from './sqlite-d1';

/**
 * The pre-migration cold read budget. Shared bulk settings/ciphertext caches may
 * reduce this count but must not increase auth-preamble I/O.
 */
export const QUERIES_PER_RESOLVE = 14;

export interface QueryCounter {
  /** Every executed statement's SQL, in execution order. */
  executed: string[];
  /** Executions that read the platform config tables — the metric under budget. */
  platformConfigReads(): string[];
  reset(): void;
  /**
   * Stall every subsequent statement execution. `disarm()` lets later executions through while
   * keeping already-waiting ones blocked; `release()` unblocks those. Used to interleave a slow
   * in-flight read with a config write.
   */
  stall(): { disarm: () => void; release: () => void };
}

type AnyStatement = Record<string, unknown>;

/** Minimal shape `withRequestScopedD1Bindings` needs from a test env. */
export type D1SessionEnv = { DATABASE: D1Database; OBSERVABILITY_DATABASE?: D1Database };

/**
 * Wraps the shared `createSqliteD1` boundary adapter — a real SQL engine, drift-proof against
 * the drizzle schema — and records every executed statement's SQL. Delegating rather than
 * hand-rolling a shim keeps `.raw()` working for the drizzle-backed signup-approval reads.
 */
export function createCountingD1(sqlite: Database.Database): {
  db: D1Database;
  counter: QueryCounter;
} {
  const inner = createSqliteD1(sqlite) as unknown as AnyStatement;
  const executed: string[] = [];
  let stallGate: Promise<void> | null = null;

  function wrapStatement(sql: string, statement: AnyStatement): AnyStatement {
    const wrapped: AnyStatement = { ...statement };

    for (const method of ['run', 'runSync', 'all', 'first', 'raw'] as const) {
      const original = statement[method];
      if (typeof original !== 'function') continue;
      const invoke = (...args: unknown[]) => {
        executed.push(sql);
        return (original as (...a: unknown[]) => unknown).apply(statement, args);
      };
      // `runSync` must stay synchronous (batch() calls it inside a SQLite transaction).
      wrapped[method] =
        method === 'runSync'
          ? invoke
          : async (...args: unknown[]) => {
              // Capture the gate synchronously at call time so every statement of a single
              // `Promise.all` burst is governed by the same one, then read the CURRENT data and
              // stall only the RETURN. That is what makes the caller's snapshot genuinely stale:
              // it read pre-write values but completes after the write landed.
              const gate = stallGate;
              const result = await invoke(...args);
              if (gate) await gate;
              return result;
            };
    }

    const originalBind = statement.bind;
    if (typeof originalBind === 'function') {
      wrapped.bind = (...params: unknown[]) =>
        wrapStatement(
          sql,
          (originalBind as (...a: unknown[]) => AnyStatement).apply(statement, params)
        );
    }

    return wrapped;
  }

  const prepare = (sql: string) =>
    wrapStatement(sql, (inner.prepare as (s: string) => AnyStatement)(sql));

  const db = {
    ...inner,
    prepare,
    // The Sessions API must route through the SAME counter. Inheriting `createSqliteD1`'s
    // `withSession` via the spread would hand back the inner, UNCOUNTED `prepare`, so a
    // session-wrapped binding would silently report zero queries and every budget assertion
    // below would pass for the wrong reason.
    withSession: () => ({
      prepare,
      batch: inner.batch,
      getBookmark: () => null,
    }),
  } as unknown as D1Database;

  const counter: QueryCounter = {
    executed,
    platformConfigReads: () =>
      executed.filter(
        (sql) =>
          /^\s*SELECT/i.test(sql) &&
          (sql.includes('platform_settings') || sql.includes('platform_credentials'))
      ),
    reset: () => {
      executed.length = 0;
    },
    stall: () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      stallGate = gate;
      return {
        // Stop stalling NEW executions while leaving already-waiting ones blocked.
        disarm: () => {
          if (stallGate === gate) stallGate = null;
        },
        release,
      };
    },
  };

  return { db, counter };
}

export function createSchema(): Database.Database {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users, schema.platformSettings, schema.platformCredentials]);
  sqlite.exec(
    readFileSync(
      new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  return sqlite;
}

export function createEnv(overrides: Partial<Env> = {}): { env: Env; counter: QueryCounter } {
  const { db, counter } = createCountingD1(createSchema());
  const env = {
    DATABASE: db,
    KV: { get: async () => null },
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: generateEncryptionKey(),
    GITHUB_CLIENT_ID: 'env-gh-client',
    GITHUB_CLIENT_SECRET: 'env-gh-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'env-private-key',
    GITHUB_APP_SLUG: 'env-app-slug',
    GITHUB_WEBHOOK_SECRET: 'env-webhook-secret',
    GITLAB_HOST: 'https://gitlab.example.com/',
    GITLAB_CLIENT_ID: 'env-gitlab-client',
    GITLAB_CLIENT_SECRET: 'env-gitlab-secret',
    GOOGLE_CLIENT_ID: 'env-google-infra-client',
    GOOGLE_CLIENT_SECRET: 'env-google-infra-secret',
    GOOGLE_LOGIN_CLIENT_ID: 'env-google-login-client',
    GOOGLE_LOGIN_CLIENT_SECRET: 'env-google-login-secret',
    ...overrides,
  } as Env;
  return { env, counter };
}
