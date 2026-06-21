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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { createInstrumentedLogger } from '../../src/lib/logger';
import { AppError } from '../../src/middleware/error';
import { createRateLimitKey, getCurrentWindowStart } from '../../src/middleware/rate-limit';
import { clientErrorsRoutes } from '../../src/routes/client-errors';
import { nodeLifecycleRoutes } from '../../src/routes/node-lifecycle';
import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';
import {
  persistError,
  persistErrorBatch,
  queryErrors,
  type PersistErrorInput,
} from '../../src/services/observability';
import { runObservabilityPurge } from '../../src/scheduled/observability-purge';

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
      return sqlite.prepare(sql).raw().all(...normalize(params));
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

      const row = sqlite
        .prepare('SELECT message, stack FROM platform_errors LIMIT 1')
        .get() as { message: string; stack: string };
      expect(row.message.endsWith('...')).toBe(true);
      expect(row.message.length).toBe(2048 + 3);
      expect(row.stack.endsWith('...')).toBe(true);
      expect(row.stack.length).toBe(4096 + 3);
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

    it('is fail-silent when the database throws', async () => {
      await expect(
        persistError(createBrokenD1(), {
          source: 'api',
          level: 'error',
          message: 'will-fail',
          timestamp: Date.now(),
        }),
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
      expect(errors.map((e) => e.message).sort()).toEqual(['needle in the message', 'plain message']);
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
      expect(widened.errors.map((e) => e.message).sort()).toEqual(['before-window', 'in-window']);
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
        { KV: fakeKV, OBSERVABILITY_DATABASE: obsDb, MAX_CLIENT_ERROR_BODY_BYTES: '10' } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
              errors: [
                { message: 'rl', source: 'app.tsx', level: 'error', timestamp: Date.now() },
              ],
            }),
          },
          env,
          { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
        JSON.stringify({ count: 5, windowStart: priorWindow }),
      );

      const send = async () => {
        const pending: Promise<unknown>[] = [];
        const res = await app.request(
          '/api/client-errors',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
            body: JSON.stringify({
              errors: [{ message: 'rollover', source: 'app.tsx', level: 'error', timestamp: Date.now() }],
            }),
          },
          env,
          { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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

    beforeEach(() => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      authEnv = {
        BASE_DOMAIN: 'test.example.com',
        JWT_PUBLIC_KEY: publicKey,
        JWT_PRIVATE_KEY: privateKey,
        OBSERVABILITY_DATABASE: obsDb,
      } as unknown as Env;
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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

    it('accepts a legacy no-scope callback token whose workspace matches the node', async () => {
      const legacy = await signLegacyNodeCallbackToken(NODE_ID, authEnv);
      const res = await postNodeErrors(legacy);

      expect(res.status).toBe(204);

      const { errors } = await queryErrors(obsDb, {});
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('vm-agent');
      expect(errors[0].nodeId).toBe(NODE_ID);
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
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
      await persistErrorBatch(obsDb, inputs, { OBSERVABILITY_ERROR_BATCH_SIZE: '100' } as unknown as Env);
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
        'INSERT INTO platform_errors (id, source, level, message, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)',
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
