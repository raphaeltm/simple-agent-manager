/**
 * Integration test: observability error ingestion pipeline (behavioral).
 *
 * Exercises the REAL ingestion pipeline end-to-end against a real SQLite-backed
 * D1 adapter (better-sqlite3). Only the D1 system boundary is substituted; the
 * Hono routes, the observability service, drizzle query construction, the
 * instrumented logger, and the scheduled purge all run as production code.
 *
 * Covered paths:
 *  1. observability service round-trip: persistError / persistErrorBatch / queryErrors
 *     including source+level coercion, message/stack truncation, batch-size limit,
 *     and fail-silent behavior on a broken database.
 *  2. instrumented logger: error-level entries persist with source 'api'; non-error
 *     entries do not persist; null db is a no-op.
 *  3. client errors route: POST /api/client-errors persists source 'client' with
 *     ISO timestamp round-trip; malformed entries are skipped.
 *  4. VM agent errors route: POST /api/nodes/:id/errors persists source 'vm-agent'
 *     with nodeId+workspaceId; workspace-scoped tokens are rejected (403); tokens
 *     for a different node are rejected (401).
 *  5. scheduled purge: no-op without OBSERVABILITY_DATABASE; count-based deletion
 *     enforces OBSERVABILITY_ERROR_MAX_ROWS; age-based deletion drops expired rows.
 */
import { generateKeyPairSync } from 'node:crypto';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { importPKCS8, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { createInstrumentedLogger } from '../../src/lib/logger';
import { AppError } from '../../src/middleware/error';
import { createRateLimitKey, getCurrentWindowStart } from '../../src/middleware/rate-limit';
import { clientErrorsRoutes } from '../../src/routes/client-errors';
import { nodeLifecycleRoutes } from '../../src/routes/node-lifecycle';
import { runObservabilityPurge } from '../../src/scheduled/observability-purge';
import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';
import {
  persistError,
  persistErrorBatch,
  type PersistErrorInput,
  queryErrors,
} from '../../src/services/observability';
import { diagnosticDedupSchemaSql } from '../helpers/diagnostic-dedup-schema';

const PLATFORM_ERRORS_DDL = `CREATE TABLE platform_errors (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  user_id TEXT,
  node_id TEXT,
  workspace_id TEXT,
  task_id TEXT,
  session_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);`;

/**
 * Build a faithful D1Database adapter over a real better-sqlite3 engine.
 * Mirrors the drizzle d1 session call shape: prepare(sql) -> bind(...).run()/all()/raw().
 */
function createTestD1(sqlite: Database.Database): D1Database {
  const normalize = (params: unknown[]): unknown[] =>
    params.map((p) => (p === undefined ? null : p));

  const makeBound = (sql: string, params: unknown[]) => ({
    async run() {
      const info = sqlite.prepare(sql).run(...normalize(params));
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        results: [],
      };
    },
    async all() {
      const results = sqlite.prepare(sql).all(...normalize(params));
      return { success: true, results, meta: {} };
    },
    async raw() {
      return sqlite
        .prepare(sql)
        .raw()
        .all(...normalize(params));
    },
    async first(col?: string) {
      const row = sqlite.prepare(sql).get(...normalize(params)) as
        | Record<string, unknown>
        | undefined;
      if (col != null) return row ? (row[col] ?? null) : null;
      return row ?? null;
    },
  });

  const makeStmt = (sql: string) => ({
    bind: (...params: unknown[]) => makeBound(sql, params),
    run: () => makeBound(sql, []).run(),
    all: () => makeBound(sql, []).all(),
    raw: () => makeBound(sql, []).raw(),
    first: (col?: string) => makeBound(sql, []).first(col),
  });

  return {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

/** A D1Database whose every prepared statement throws — to exercise fail-silent paths. */
function createBrokenD1(): D1Database {
  const thrower = () => {
    throw new Error('d1 unavailable');
  };
  return {
    prepare: () => ({
      bind: () => ({ run: thrower, all: thrower, raw: thrower, first: thrower }),
      run: thrower,
      all: thrower,
      raw: thrower,
      first: thrower,
    }),
    batch: thrower,
    exec: thrower,
    dump: thrower,
  } as unknown as D1Database;
}

/**
 * Mirror the production global error handler so AppError instances thrown by
 * route auth (verifyNodeCallbackAuth) map to their real status codes rather
 * than a generic 500. See src/index.ts app.onError().
 */
function withErrorHandler(app: Hono): Hono {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
  });
  return app;
}

function countRows(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT count(*) AS n FROM platform_errors').get() as { n: number }).n;
}

/**
 * A stateful in-memory KVNamespace that honours the read-modify-write contract
 * the rate-limit middleware depends on (`get(key, 'json')` then `put(key, json)`).
 * The fail-open fake (get → null) cannot catch a 429 regression; this can.
 */
function createStatefulKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    // Accept the options arg (expirationTtl) the rate-limit middleware passes so
    // the fake faithfully mirrors the real KVNamespace.put(key, value, options)
    // signature rather than silently dropping the third argument.
    async put(key: string, value: string, _options?: { expirationTtl?: number }) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

/**
 * Hand-sign a LEGACY callback token (pre-scoping): `type: 'callback'` with NO
 * `scope` claim. There is no production helper that mints these, but real nodes
 * provisioned before scope-claims existed still present them, and
 * verifyNodeCallbackAuth must accept them when workspace === nodeId.
 */
async function signLegacyNodeCallbackToken(nodeId: string, env: Env): Promise<string> {
  const keyId = `key-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  return new SignJWT({ workspace: nodeId, type: 'callback' })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(`https://api.${env.BASE_DOMAIN}`)
    .setSubject(nodeId)
    .setAudience('workspace-callback')
    .setExpirationTime(new Date(Date.now() + 60_000))
    .setIssuedAt()
    .sign(privateKey);
}

describe('observability error ingestion pipeline (behavioral)', () => {
  let sqlite: Database.Database;
  let obsDb: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(PLATFORM_ERRORS_DDL);
    obsDb = createTestD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  // ===========================================================================
  // observability service round-trip
  // ===========================================================================
  describe('observability service', () => {
    it('persistError writes a row that queryErrors returns with an ISO timestamp', async () => {
      const ts = Date.UTC(2026, 0, 2, 3, 4, 5);
      await persistError(obsDb, {
        source: 'api',
        level: 'error',
        message: 'boom',
        context: { route: '/x' },
        timestamp: ts,
      });

      const { errors, hasMore } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(hasMore).toBe(false);
      expect(errors[0].source).toBe('api');
      expect(errors[0].level).toBe('error');
      expect(errors[0].message).toBe('boom');
      expect(errors[0].timestamp).toBe(new Date(ts).toISOString());
      expect(errors[0].context).toEqual({ route: '/x' });
    });

    it('coerces an unknown source to "api" and an unknown level to "error"', async () => {
      await persistError(obsDb, {
        source: 'totally-made-up' as PersistErrorInput['source'],
        level: 'verbose' as PersistErrorInput['level'],
        message: 'coerced',
        timestamp: Date.now(),
      });

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('api');
      expect(errors[0].level).toBe('error');
    });

    it('truncates message and stack to their configured limits with a "..." suffix', async () => {
      const longMessage = 'm'.repeat(5000);
      const longStack = 's'.repeat(8000);
      await persistError(obsDb, {
        source: 'api',
        level: 'error',
        message: longMessage,
        stack: longStack,
        timestamp: Date.now(),
      });

      const row = sqlite.prepare('SELECT message, stack FROM platform_errors LIMIT 1').get() as {
        message: string;
        stack: string;
      };
      expect(row.message.endsWith('...')).toBe(true);
      expect(row.message.length).toBe(2048 + 3);
      expect(row.stack.endsWith('...')).toBe(true);
      expect(row.stack.length).toBe(4096 + 3);
    });

    it('honors configured message, stack, and user-agent persistence limits', async () => {
      await persistError(
        obsDb,
        {
          source: 'api',
          message: 'm'.repeat(20),
          stack: 's'.repeat(20),
          userAgent: 'u'.repeat(20),
        },
        {
          OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH: '7',
          OBSERVABILITY_ERROR_STACK_MAX_LENGTH: '8',
          OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH: '9',
        } as Env
      );

      const row = sqlite
        .prepare('SELECT message, stack, user_agent FROM platform_errors LIMIT 1')
        .get() as { message: string; stack: string; user_agent: string };
      expect(row).toEqual({
        message: `${'m'.repeat(7)}...`,
        stack: `${'s'.repeat(8)}...`,
        user_agent: `${'u'.repeat(9)}...`,
      });
    });

    it('persistErrorBatch writes every input', async () => {
      const inputs: PersistErrorInput[] = Array.from({ length: 5 }, (_, i) => ({
        source: 'client',
        level: 'error',
        message: `batch-${i}`,
        timestamp: Date.now(),
      }));
      await persistErrorBatch(obsDb, inputs);
      expect(countRows(sqlite)).toBe(5);
    });

    it('persistErrorBatch respects OBSERVABILITY_ERROR_BATCH_SIZE', async () => {
      const inputs: PersistErrorInput[] = Array.from({ length: 10 }, (_, i) => ({
        source: 'client',
        level: 'error',
        message: `limited-${i}`,
        timestamp: Date.now(),
      }));
      await persistErrorBatch(obsDb, inputs, {
        OBSERVABILITY_ERROR_BATCH_SIZE: '3',
      } as unknown as Env);
      expect(countRows(sqlite)).toBe(3);
    });

    it('persistErrorBatch forwards configured field limits to each insert', async () => {
      await persistErrorBatch(
        obsDb,
        [{ source: 'client', message: 'abcdefgh', stack: '12345678', userAgent: 'ABCDEFGH' }],
        {
          OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH: '3',
          OBSERVABILITY_ERROR_STACK_MAX_LENGTH: '4',
          OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH: '5',
        } as Env
      );

      const row = sqlite
        .prepare('SELECT message, stack, user_agent FROM platform_errors LIMIT 1')
        .get() as { message: string; stack: string; user_agent: string };
      expect(row).toEqual({
        message: 'abc...',
        stack: '1234...',
        user_agent: 'ABCDE...',
      });
    });

    it('is fail-silent when the database throws', async () => {
      await expect(
        persistError(createBrokenD1(), {
          source: 'api',
          level: 'error',
          message: 'will-fail',
          timestamp: Date.now(),
        })
      ).resolves.toBeUndefined();
    });

    it('queryErrors filters by source', async () => {
      await persistErrorBatch(obsDb, [
        { source: 'client', level: 'error', message: 'c', timestamp: Date.now() },
        { source: 'vm-agent', level: 'error', message: 'v', timestamp: Date.now() },
        { source: 'api', level: 'error', message: 'a', timestamp: Date.now() },
      ]);

      const { errors } = await queryErrors(obsDb, { source: 'vm-agent' });
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('vm-agent');
      expect(errors[0].message).toBe('v');
    });

    it('queryErrors filters by level', async () => {
      await persistErrorBatch(obsDb, [
        { source: 'api', level: 'error', message: 'an-error', timestamp: Date.now() },
        { source: 'api', level: 'warn', message: 'a-warning', timestamp: Date.now() },
        { source: 'api', level: 'info', message: 'an-info', timestamp: Date.now() },
      ]);

      const { errors } = await queryErrors(obsDb, { level: 'warn' });
      expect(errors).toHaveLength(1);
      expect(errors[0].level).toBe('warn');
      expect(errors[0].message).toBe('a-warning');
    });

    it('queryErrors paginates newest-first with a cursor over hasMore', async () => {
      // Seed 3 rows with strictly increasing timestamps so ordering is deterministic.
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      await persistErrorBatch(obsDb, [
        { source: 'api', level: 'error', message: 'oldest', timestamp: base + 1 },
        { source: 'api', level: 'error', message: 'middle', timestamp: base + 2 },
        { source: 'api', level: 'error', message: 'newest', timestamp: base + 3 },
      ]);

      // Page 1: limit 2 -> newest two, hasMore true, cursor present.
      const page1 = await queryErrors(obsDb, { limit: 2 });
      expect(page1.errors.map((e) => e.message)).toEqual(['newest', 'middle']);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBeTruthy();

      // total ignores the page limit: all three matching rows are counted.
      expect(page1.total).toBe(3);

      // Page 2: feed cursor -> remaining oldest row, hasMore false, cursor null.
      const page2 = await queryErrors(obsDb, { limit: 2, cursor: page1.cursor ?? undefined });
      expect(page2.errors.map((e) => e.message)).toEqual(['oldest']);
      expect(page2.hasMore).toBe(false);
      expect(page2.cursor).toBeNull();

      // total on a cursor page reflects the full match set (cursor condition is
      // excluded from the count), not just the rows on this page.
      expect(page2.total).toBe(3);
    });

    it('queryErrors filters by search across message and context (OR LIKE)', async () => {
      await persistErrorBatch(obsDb, [
        { source: 'api', level: 'error', message: 'needle in the message', timestamp: Date.now() },
        {
          source: 'api',
          level: 'error',
          message: 'plain message',
          context: { detail: 'needle hidden in context' },
          timestamp: Date.now(),
        },
        { source: 'api', level: 'error', message: 'unrelated', timestamp: Date.now() },
      ]);

      const { errors, total } = await queryErrors(obsDb, { search: 'needle' });
      // Matches the message-hit AND the context-hit, but not the unrelated row.
      expect(errors).toHaveLength(2);
      expect(total).toBe(2);
      expect(errors.map((e) => e.message).sort((a, b) => a.localeCompare(b))).toEqual([
        'needle in the message',
        'plain message',
      ]);
    });

    it('queryErrors filters by startTime and endTime (inclusive bounds)', async () => {
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      await persistErrorBatch(obsDb, [
        { source: 'api', level: 'error', message: 'before-window', timestamp: base + 100 },
        { source: 'api', level: 'error', message: 'in-window', timestamp: base + 200 },
        { source: 'api', level: 'error', message: 'after-window', timestamp: base + 300 },
      ]);

      // startTime is gte, endTime is lte — the boundaries themselves are included.
      const { errors, total } = await queryErrors(obsDb, {
        startTime: base + 200,
        endTime: base + 200,
      });
      expect(errors).toHaveLength(1);
      expect(total).toBe(1);
      expect(errors[0].message).toBe('in-window');

      // A wider window that spans only the first two rows.
      const widened = await queryErrors(obsDb, { startTime: base + 100, endTime: base + 200 });
      expect(widened.errors.map((e) => e.message).sort((a, b) => a.localeCompare(b))).toEqual([
        'before-window',
        'in-window',
      ]);
      expect(widened.total).toBe(2);
    });
  });

  // ===========================================================================
  // instrumented logger
  // ===========================================================================
  describe('instrumented logger', () => {
    it('persists error-level entries with source "api" and context', async () => {
      const pending: Promise<unknown>[] = [];
      const log = createInstrumentedLogger(obsDb, (p) => {
        pending.push(p);
      });

      log.error('logger_failure', { reason: 'kaboom' });
      await Promise.all(pending);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('api');
      expect(errors[0].level).toBe('error');
      expect(errors[0].message).toBe('logger_failure');
      expect(errors[0].context).toEqual({ reason: 'kaboom' });
    });

    it('does not persist non-error log levels', async () => {
      const pending: Promise<unknown>[] = [];
      const log = createInstrumentedLogger(obsDb, (p) => {
        pending.push(p);
      });

      log.info('just_info');
      log.warn('just_warn');
      log.debug('just_debug');
      await Promise.all(pending);

      expect(countRows(sqlite)).toBe(0);
    });

    it('is a no-op when db is null', async () => {
      const pending: Promise<unknown>[] = [];
      const log = createInstrumentedLogger(null, (p) => {
        pending.push(p);
      });

      log.error('orphaned');
      await Promise.all(pending);

      expect(pending).toHaveLength(0);
      expect(countRows(sqlite)).toBe(0);
    });
  });

  // ===========================================================================
  // client errors route
  // ===========================================================================
  describe('client errors route → D1', () => {
    const fakeKV = {
      get: async () => null,
      put: async () => {},
    } as unknown as KVNamespace;

    function buildClientApp() {
      const app = new Hono();
      app.route('/api/client-errors', clientErrorsRoutes);
      return withErrorHandler(app);
    }

    it('persists submitted client errors with source "client" and round-trips the ISO timestamp', async () => {
      const pending: Promise<unknown>[] = [];
      const app = buildClientApp();
      const isoTs = '2026-01-02T03:04:05.000Z';

      const res = await app.request(
        '/api/client-errors',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            errors: [
              {
                message: 'render crashed',
                source: 'app.tsx',
                level: 'error',
                timestamp: isoTs,
                stack: 'Error: render crashed\n  at App',
              },
            ],
          }),
        },
        { KV: fakeKV, OBSERVABILITY_DATABASE: obsDb } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(204);
      // The route must hand the persistence off to waitUntil, not block the response.
      expect(pending).toHaveLength(1);
      await Promise.all(pending);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('client');
      expect(errors[0].message).toBe('render crashed');
      expect(errors[0].timestamp).toBe(isoTs);
    });

    it('skips malformed entries (missing message/source) but persists valid ones', async () => {
      const pending: Promise<unknown>[] = [];
      const app = buildClientApp();

      const res = await app.request(
        '/api/client-errors',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            errors: [
              { source: 'no-message.tsx', level: 'error', timestamp: Date.now() },
              { message: 'no source', level: 'error', timestamp: Date.now() },
              {
                message: 'valid one',
                source: 'ok.tsx',
                level: 'warn',
                timestamp: Date.now(),
              },
            ],
          }),
        },
        { KV: fakeKV, OBSERVABILITY_DATABASE: obsDb } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(204);
      await Promise.all(pending);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('valid one');
      expect(errors[0].level).toBe('warn');
    });

    it('rejects a batch larger than the configured maximum with 400 and persists nothing', async () => {
      const pending: Promise<unknown>[] = [];
      const app = buildClientApp();
      const oversized = Array.from({ length: 30 }, (_, i) => ({
        message: `err-${i}`,
        source: 'app.tsx',
        level: 'error',
        timestamp: Date.now(),
      }));

      const res = await app.request(
        '/api/client-errors',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ errors: oversized }),
        },
        { KV: fakeKV, OBSERVABILITY_DATABASE: obsDb } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(400);
      await Promise.all(pending);
      expect(countRows(sqlite)).toBe(0);
    });

    it('rejects a request whose Content-Length exceeds the configured maximum with 400', async () => {
      const pending: Promise<unknown>[] = [];
      const app = buildClientApp();

      const res = await app.request(
        '/api/client-errors',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Body itself is small & valid, but the declared size blows the cap.
            'Content-Length': '500',
          },
          body: JSON.stringify({
            errors: [{ message: 'tiny', source: 'app.tsx', level: 'error', timestamp: Date.now() }],
          }),
        },
        // Cap the body at 10 bytes so the 500-byte Content-Length trips the guard.
        {
          KV: fakeKV,
          OBSERVABILITY_DATABASE: obsDb,
          MAX_CLIENT_ERROR_BODY_BYTES: '10',
        } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(400);
      await Promise.all(pending);
      expect(countRows(sqlite)).toBe(0);
    });

    it('returns 204 and persists nothing for an empty error batch', async () => {
      const pending: Promise<unknown>[] = [];
      const app = buildClientApp();

      const res = await app.request(
        '/api/client-errors',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ errors: [] }),
        },
        { KV: fakeKV, OBSERVABILITY_DATABASE: obsDb } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(204);
      await Promise.all(pending);
      expect(countRows(sqlite)).toBe(0);
    });

    it('enforces the per-IP rate limit, returning 429 on the over-limit request', async () => {
      const kv = createStatefulKV();
      const app = buildClientApp();
      const env = {
        KV: kv,
        OBSERVABILITY_DATABASE: obsDb,
        RATE_LIMIT_CLIENT_ERRORS: '1',
      } as unknown as Env;

      const send = async () => {
        const pending: Promise<unknown>[] = [];
        const res = await app.request(
          '/api/client-errors',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '203.0.113.7',
            },
            body: JSON.stringify({
              errors: [{ message: 'rl', source: 'app.tsx', level: 'error', timestamp: Date.now() }],
            }),
          },
          env,
          { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
        );
        await Promise.all(pending);
        return res;
      };

      const first = await send();
      expect(first.status).toBe(204);

      const second = await send();
      expect(second.status).toBe(429);

      // Only the allowed request persisted.
      expect(countRows(sqlite)).toBe(1);
    });

    it('starts a fresh counter when the rate-limit window rolls over', async () => {
      const kv = createStatefulKV();
      const app = buildClientApp();
      const ip = '203.0.113.11';
      const windowSeconds = 3600; // DEFAULT_WINDOW_SECONDS used by the client-errors limiter
      const env = {
        KV: kv,
        OBSERVABILITY_DATABASE: obsDb,
        RATE_LIMIT_CLIENT_ERRORS: '1',
      } as unknown as Env;

      // Seed a PRIOR window's bucket already at/over the limit. Because the KV
      // key embeds the window start, the current window must NOT inherit this.
      const priorWindow = getCurrentWindowStart(windowSeconds) - windowSeconds;
      await kv.put(
        createRateLimitKey('client-errors', ip, priorWindow),
        JSON.stringify({ count: 5, windowStart: priorWindow })
      );

      const send = async () => {
        const pending: Promise<unknown>[] = [];
        const res = await app.request(
          '/api/client-errors',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
            body: JSON.stringify({
              errors: [
                { message: 'rollover', source: 'app.tsx', level: 'error', timestamp: Date.now() },
              ],
            }),
          },
          env,
          { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
        );
        await Promise.all(pending);
        return res;
      };

      // First request in the CURRENT window is allowed despite the exhausted
      // prior window — proving the counter reset on rollover.
      expect((await send()).status).toBe(204);
      // The current window then enforces its own limit independently.
      expect((await send()).status).toBe(429);
    });
  });

  // ===========================================================================
  // VM agent errors route
  // ===========================================================================
  describe('VM agent errors route → D1', () => {
    const NODE_ID = 'node-obs-1';
    let authEnv: Env;
    let mainSqlite: Database.Database;
    let mainDb: D1Database;

    beforeEach(() => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      mainSqlite = new Database(':memory:');
      mainSqlite.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          node_id TEXT,
          project_id TEXT,
          chat_session_id TEXT
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT,
          project_id TEXT,
          chat_session_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE TABLE diagnostic_incidents (
          id TEXT PRIMARY KEY NOT NULL,
          platform_error_id TEXT NOT NULL UNIQUE,
          node_id TEXT NOT NULL,
          workspace_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'available', 'failed', 'expired')),
          artifact_count INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          manifest_json TEXT,
          preview_json TEXT,
          failure_reason TEXT,
          expires_at TEXT NOT NULL,
          delete_after TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      mainSqlite.exec(diagnosticDedupSchemaSql);
      mainDb = createTestD1(mainSqlite);
      authEnv = {
        BASE_DOMAIN: 'test.example.com',
        JWT_PUBLIC_KEY: publicKey,
        JWT_PRIVATE_KEY: privateKey,
        DATABASE: mainDb,
        OBSERVABILITY_DATABASE: obsDb,
      } as unknown as Env;
    });

    afterEach(() => {
      mainSqlite.close();
    });

    function buildNodeApp() {
      const app = new Hono();
      app.route('/api/nodes', nodeLifecycleRoutes);
      return withErrorHandler(app);
    }

    async function postNodeErrors(token: string) {
      const pending: Promise<unknown>[] = [];
      const app = buildNodeApp();
      const res = await app.request(
        `/api/nodes/${NODE_ID}/errors`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            errors: [
              {
                message: 'vm agent crashed',
                source: 'session_host.go',
                level: 'error',
                workspaceId: 'ws-77',
                timestamp: Date.now(),
              },
            ],
          }),
        },
        authEnv,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );
      await Promise.all(pending);
      return res;
    }

    it('persists vm-agent errors with source "vm-agent", nodeId, and workspaceId for a valid node token', async () => {
      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      const res = await postNodeErrors(token);

      expect(res.status).toBe(204);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('vm-agent');
      expect(errors[0].message).toBe('vm agent crashed');
      expect(errors[0].nodeId).toBe(NODE_ID);
      expect(errors[0].workspaceId).toBe('ws-77');
    });

    it('correlates only authoritative node-workspace-session-task bindings', async () => {
      const incidentTime = Date.UTC(2026, 7, 9, 6, 47, 29);
      const workspaces = [
        ['ws-match', NODE_ID, 'project-1', 'session-match'],
        ['ws-other-node', 'node-other', 'project-1', 'session-other-node'],
        ['ws-session-mismatch', NODE_ID, 'project-1', 'session-workspace'],
        ['ws-future-task', NODE_ID, 'project-1', 'session-future'],
        ['ws-stale-task', NODE_ID, 'project-1', 'session-stale'],
        ['ws-ambiguous', NODE_ID, 'project-1', 'session-ambiguous'],
      ];
      const insertWorkspace = mainSqlite.prepare(
        'INSERT INTO workspaces (id, node_id, project_id, chat_session_id) VALUES (?, ?, ?, ?)'
      );
      for (const workspace of workspaces) insertWorkspace.run(...workspace);

      const insertTask = mainSqlite.prepare(
        `INSERT INTO tasks
           (id, workspace_id, project_id, chat_session_id, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      );
      insertTask.run(
        'task-match',
        'ws-match',
        'project-1',
        'session-match',
        '2026-08-09T06:00:00.000Z',
        '2026-08-09T06:01:00.000Z'
      );
      insertTask.run(
        'task-other-node',
        'ws-other-node',
        'project-1',
        'session-other-node',
        '2026-08-09T06:00:00.000Z',
        '2026-08-09T06:01:00.000Z'
      );
      insertTask.run(
        'task-session-mismatch',
        'ws-session-mismatch',
        'project-1',
        'session-task',
        '2026-08-09T06:00:00.000Z',
        '2026-08-09T06:01:00.000Z'
      );
      insertTask.run(
        'task-future',
        'ws-future-task',
        'project-1',
        'session-future',
        '2026-08-09T07:00:00.000Z',
        '2026-08-09T07:01:00.000Z'
      );
      insertTask.run(
        'task-stale',
        'ws-stale-task',
        'project-1',
        'session-stale',
        '2026-08-09T05:00:00.000Z',
        '2026-08-09T05:01:00.000Z'
      );
      mainSqlite
        .prepare(
          `UPDATE tasks SET completed_at = '2026-08-09T06:30:00.000Z' WHERE id = 'task-stale'`
        )
        .run();
      insertTask.run(
        'task-ambiguous-1',
        'ws-ambiguous',
        'project-1',
        'session-ambiguous',
        '2026-08-09T06:00:00.000Z',
        '2026-08-09T06:01:00.000Z'
      );
      insertTask.run(
        'task-ambiguous-2',
        'ws-ambiguous',
        'project-1',
        'session-ambiguous',
        '2026-08-09T06:00:00.000Z',
        '2026-08-09T06:01:00.000Z'
      );

      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await buildNodeApp().request(
        `/api/nodes/${NODE_ID}/errors`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            errors: [...workspaces.map(([workspaceId]) => workspaceId), 'ws-missing'].map(
              (workspaceId) => ({
                message: `failure-${workspaceId}`,
                source: 'session_host.go',
                level: 'error',
                workspaceId,
                timestamp: new Date(incidentTime).toISOString(),
              })
            ),
          }),
        },
        authEnv
      );

      expect(res.status).toBe(204);
      const rows = sqlite
        .prepare(
          `SELECT workspace_id, task_id, session_id
             FROM platform_errors
            ORDER BY workspace_id`
        )
        .all();
      expect(rows).toEqual([
        { workspace_id: 'ws-ambiguous', task_id: null, session_id: null },
        { workspace_id: 'ws-future-task', task_id: null, session_id: null },
        { workspace_id: 'ws-match', task_id: 'task-match', session_id: 'session-match' },
        { workspace_id: 'ws-missing', task_id: null, session_id: null },
        { workspace_id: 'ws-other-node', task_id: null, session_id: null },
        { workspace_id: 'ws-session-mismatch', task_id: null, session_id: null },
        { workspace_id: 'ws-stale-task', task_id: null, session_id: null },
      ]);
      const rejectionByWorkspace = Object.fromEntries(
        warnSpy.mock.calls
          .map(([entry]) => JSON.parse(entry as string))
          .filter((entry) => entry.event === 'observability.vm_error_correlation_rejected')
          .map((entry) => [entry.workspaceId, entry.rejectionReason])
      );
      expect(rejectionByWorkspace).toEqual({
        'ws-ambiguous': 'ambiguous_task_binding',
        'ws-future-task': 'outside_task_lifetime',
        'ws-missing': 'workspace_not_found',
        'ws-other-node': 'node_mismatch',
        'ws-session-mismatch': 'canonical_task_missing',
        'ws-stale-task': 'outside_task_lifetime',
      });
      warnSpy.mockRestore();
    });

    it('persists receipt time but rejects missing, malformed, and non-finite producer timestamps', async () => {
      mainSqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, project_id, chat_session_id)
           VALUES ('ws-timestamp', ?, 'project-1', 'session-timestamp')`
        )
        .run(NODE_ID);
      mainSqlite
        .prepare(
          `INSERT INTO tasks
             (id, workspace_id, project_id, chat_session_id, created_at, started_at)
           VALUES
             ('task-timestamp', 'ws-timestamp', 'project-1', 'session-timestamp',
              '2026-08-09T06:00:00.000Z', '2026-08-09T06:01:00.000Z')`
        )
        .run();
      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const beforeReceipt = Date.now();

      const res = await buildNodeApp().request(
        `/api/nodes/${NODE_ID}/errors`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            errors: [
              {
                message: 'missing timestamp',
                source: 'session_host.go',
                level: 'warn',
                workspaceId: 'ws-timestamp',
              },
              {
                message: 'malformed timestamp',
                source: 'session_host.go',
                level: 'warn',
                workspaceId: 'ws-timestamp',
                timestamp: 'not-a-timestamp',
              },
              {
                message: 'non-finite timestamp',
                source: 'session_host.go',
                level: 'warn',
                workspaceId: 'ws-timestamp',
                timestamp: 'Infinity',
              },
            ],
          }),
        },
        authEnv
      );
      const afterReceipt = Date.now();

      expect(res.status).toBe(204);
      const rows = sqlite
        .prepare(
          `SELECT task_id, session_id, timestamp
             FROM platform_errors
            ORDER BY message`
        )
        .all() as Array<{ task_id: string | null; session_id: string | null; timestamp: number }>;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.task_id).toBeNull();
        expect(row.session_id).toBeNull();
        expect(row.timestamp).toBeGreaterThanOrEqual(beforeReceipt);
        expect(row.timestamp).toBeLessThanOrEqual(afterReceipt);
      }
      const rejectionLogs = warnSpy.mock.calls
        .map(([entry]) => JSON.parse(entry as string))
        .filter((entry) => entry.event === 'observability.vm_error_correlation_rejected');
      expect(rejectionLogs).toHaveLength(3);
      expect(rejectionLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: NODE_ID,
            workspaceId: 'ws-timestamp',
            rejectionReason: 'invalid_incident_timestamp',
            action: 'persisted_without_task_session_correlation',
          }),
        ])
      );
      warnSpy.mockRestore();
    });

    it('enriches a retried stable incident and rejects a later conflicting rebind', async () => {
      const incidentId = '01KZJMDJT3ET7Z3BZ40TTX81Z5';
      const incidentTimestamp = '2026-08-09T06:47:29.000Z';
      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      const postStableIncident = () =>
        buildNodeApp().request(
          `/api/nodes/${NODE_ID}/errors`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              errors: [
                {
                  incidentId,
                  message: 'ACP prompt force-stopped',
                  source: 'session_host.go',
                  level: 'error',
                  workspaceId: 'ws-retry',
                  timestamp: incidentTimestamp,
                },
              ],
            }),
          },
          authEnv
        );

      expect((await postStableIncident()).status).toBe(204);
      expect(
        sqlite
          .prepare('SELECT task_id, session_id FROM platform_errors WHERE id = ?')
          .get(incidentId)
      ).toEqual({ task_id: null, session_id: null });

      mainSqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, project_id, chat_session_id)
					 VALUES ('ws-retry', ?, 'project-1', 'session-1')`
        )
        .run(NODE_ID);
      mainSqlite
        .prepare(
          `INSERT INTO tasks
					   (id, workspace_id, project_id, chat_session_id, created_at, started_at)
					 VALUES
					   ('task-1', 'ws-retry', 'project-1', 'session-1',
					    '2026-08-09T06:00:00.000Z', '2026-08-09T06:01:00.000Z')`
        )
        .run();

      expect((await postStableIncident()).status).toBe(204);
      expect(
        sqlite
          .prepare('SELECT task_id, session_id FROM platform_errors WHERE id = ?')
          .get(incidentId)
      ).toEqual({ task_id: 'task-1', session_id: 'session-1' });

      mainSqlite
        .prepare(`UPDATE workspaces SET chat_session_id = 'session-2' WHERE id = 'ws-retry'`)
        .run();
      mainSqlite
        .prepare(
          `INSERT INTO tasks
					   (id, workspace_id, project_id, chat_session_id, created_at, started_at)
					 VALUES
					   ('task-2', 'ws-retry', 'project-1', 'session-2',
					    '2026-08-09T06:00:00.000Z', '2026-08-09T06:01:00.000Z')`
        )
        .run();

      expect((await postStableIncident()).status).toBe(500);
      expect(
        sqlite
          .prepare('SELECT task_id, session_id FROM platform_errors WHERE id = ?')
          .get(incidentId)
      ).toEqual({ task_id: 'task-1', session_id: 'session-1' });
    });

    it('persists uncorrelated evidence when the main D1 lookup fails', async () => {
      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      authEnv.DATABASE = createBrokenD1();

      const res = await postNodeErrors(token);

      expect(res.status).toBe(204);
      const row = sqlite
        .prepare(`SELECT workspace_id, task_id, session_id FROM platform_errors`)
        .get();
      expect(row).toEqual({ workspace_id: 'ws-77', task_id: null, session_id: null });
    });

    it('rejects a legacy no-scope callback token even when its workspace matches the node', async () => {
      const legacy = await signLegacyNodeCallbackToken(NODE_ID, authEnv);
      const res = await postNodeErrors(legacy);

      expect(res.status).toBe(403);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(0);
    });

    it('coerces an unrecognized vm-agent level to "error" on the persisted row', async () => {
      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      const pending: Promise<unknown>[] = [];
      const app = buildNodeApp();

      const res = await app.request(
        `/api/nodes/${NODE_ID}/errors`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            errors: [
              {
                message: 'odd level',
                source: 'session_host.go',
                level: 'verbose', // not a recognized level → normalized to 'error'
                timestamp: Date.now(),
              },
            ],
          }),
        },
        authEnv,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(204);
      await Promise.all(pending);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].level).toBe('error');
    });

    it('rejects a batch larger than the VM-agent maximum with 400 and persists nothing', async () => {
      const token = await signNodeCallbackToken(NODE_ID, authEnv);
      const pending: Promise<unknown>[] = [];
      const app = buildNodeApp();
      // DEFAULT_MAX_VM_ERROR_BATCH_SIZE is 10; send 15 to trip the guard.
      const oversized = Array.from({ length: 15 }, (_, i) => ({
        message: `vm-err-${i}`,
        source: 'session_host.go',
        level: 'error',
        timestamp: Date.now(),
      }));

      const res = await app.request(
        `/api/nodes/${NODE_ID}/errors`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ errors: oversized }),
        },
        authEnv,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} }
      );

      expect(res.status).toBe(400);
      await Promise.all(pending);
      expect(countRows(sqlite)).toBe(0);
    });

    it('rejects a workspace-scoped token with 403 and persists nothing', async () => {
      const wsToken = await signCallbackToken('ws-77', authEnv);
      const res = await postNodeErrors(wsToken);

      expect(res.status).toBe(403);
      expect(countRows(sqlite)).toBe(0);
    });

    it('rejects a node token minted for a different node with 401 and persists nothing', async () => {
      const otherToken = await signNodeCallbackToken('some-other-node', authEnv);
      const res = await postNodeErrors(otherToken);

      expect(res.status).toBe(401);
      expect(countRows(sqlite)).toBe(0);
    });
  });

  // ===========================================================================
  // scheduled purge
  // ===========================================================================
  describe('scheduled purge', () => {
    it('is a no-op and returns zero counts when OBSERVABILITY_DATABASE is absent', async () => {
      const result = await runObservabilityPurge({} as unknown as Env);
      expect(result).toEqual({ deletedByAge: 0, deletedByCount: 0 });
    });

    it('enforces OBSERVABILITY_ERROR_MAX_ROWS via count-based deletion', async () => {
      const inputs: PersistErrorInput[] = Array.from({ length: 8 }, (_, i) => ({
        source: 'api',
        level: 'error',
        message: `row-${i}`,
        timestamp: Date.now() + i,
      }));
      await persistErrorBatch(obsDb, inputs, {
        OBSERVABILITY_ERROR_BATCH_SIZE: '100',
      } as unknown as Env);
      expect(countRows(sqlite)).toBe(8);

      const result = await runObservabilityPurge({
        OBSERVABILITY_DATABASE: obsDb,
        OBSERVABILITY_ERROR_MAX_ROWS: '3',
      } as unknown as Env);

      expect(result.deletedByCount).toBe(5);
      expect(countRows(sqlite)).toBe(3);
    });

    it('drops rows older than the retention window via age-based deletion', async () => {
      const now = Date.now();
      const dayMs = 86_400_000;
      // Seed two old rows and one fresh row directly with explicit created_at.
      const insert = sqlite.prepare(
        'INSERT INTO platform_errors (id, source, level, message, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('old-1', 'api', 'error', 'old one', now - 40 * dayMs, now - 40 * dayMs);
      insert.run('old-2', 'api', 'error', 'old two', now - 35 * dayMs, now - 35 * dayMs);
      insert.run('fresh', 'api', 'error', 'fresh', now, now);
      expect(countRows(sqlite)).toBe(3);

      const result = await runObservabilityPurge({
        OBSERVABILITY_DATABASE: obsDb,
        OBSERVABILITY_ERROR_RETENTION_DAYS: '30',
      } as unknown as Env);

      // The expired rows are physically removed (observable side effect). The
      // reported deletedByAge is always 0 because D1 does not return affected
      // row counts for DELETE — the count is intentionally not back-filled.
      expect(result.deletedByAge).toBe(0);
      expect(countRows(sqlite)).toBe(1);
      const remaining = sqlite.prepare('SELECT id FROM platform_errors').all() as { id: string }[];
      expect(remaining.map((r) => r.id)).toEqual(['fresh']);
    });
  });
});
