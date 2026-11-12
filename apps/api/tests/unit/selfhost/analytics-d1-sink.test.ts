/**
 * Self-host analytics on D1 (ANALYTICS_SINK="d1"), end to end on a real SQLite engine:
 * the request middleware and `/api/t` write through the real routes into the real
 * observability migration chain, then every admin analytics route reads it back through the
 * real Analytics Engine SQL (translated). `fetch` is stubbed only to prove nothing calls
 * Cloudflare. Auth and rate limiting are bypassed; they are not what is under test.
 */
import { readdirSync, readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { analyticsMiddleware } from '../../../src/middleware/analytics';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAnalyticsRoutes } from '../../../src/routes/admin-analytics';
import { analyticsIngestRoutes } from '../../../src/routes/analytics-ingest';
import { runObservabilityPurge } from '../../../src/scheduled/observability-purge';
import { translateAnalyticsSql } from '../../../src/services/analytics-d1-sink';
import { resolvePlatformCapabilities } from '../../../src/services/platform-capabilities';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimit: () => 500,
}));

const MIGRATIONS = new URL('../../../src/db/migrations/observability/', import.meta.url);

let settingsDb: Database.Database;
let obsDb: Database.Database;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;
let pending: Promise<unknown>[];

function applyObservabilityMigrations(db: Database.Database) {
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
}

const ctx = () =>
  ({
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  }) as unknown as ExecutionContext;

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.onError(handleAppError);
  a.use('*', analyticsMiddleware());
  a.use('*', async (c, next) => {
    // The real auth middleware sets this; the analytics middleware reads it after the handler.
    c.set('auth' as never, { user: { id: c.req.header('x-test-user') ?? '' } } as never);
    await next();
  });
  a.get('/api/projects/:projectId', (c) => c.json({ ok: true }));
  a.route('/api/t', analyticsIngestRoutes);
  a.route('/api/admin/analytics', adminAnalyticsRoutes);
  return a;
}

async function call(path: string, init: RequestInit = {}) {
  const res = await app().request(path, init, env, ctx());
  await Promise.all(pending.splice(0));
  return res;
}

beforeEach(() => {
  const created = createAdminSettingsEnv();
  settingsDb = created.sqlite;
  obsDb = new Database(':memory:');
  applyObservabilityMigrations(obsDb);
  // A box: no Analytics Engine binding, no Cloudflare account, no generated dataset name.
  env = {
    ...created.env,
    OBSERVABILITY_DATABASE: createSqliteD1(obsDb),
    ANALYTICS_SINK: 'd1',
    ANALYTICS: undefined,
    ANALYTICS_DATASET: undefined,
  } as unknown as Env;
  pending = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  settingsDb.close();
  obsDb.close();
});

const rows = () =>
  obsDb.prepare('SELECT * FROM analytics_events ORDER BY id').all() as Array<
    Record<string, string | number>
  >;

describe('D1 analytics sink (self-host)', () => {
  it('advertises analyticsIngest and analyticsQuery only when the sink is switched on', () => {
    expect(resolvePlatformCapabilities(env)).toMatchObject({
      analyticsIngest: true,
      analyticsQuery: true,
      cloudflareAccountApi: false,
    });
    expect(resolvePlatformCapabilities({ ...env, ANALYTICS_SINK: undefined } as Env)).toMatchObject(
      { analyticsIngest: false, analyticsQuery: false }
    );
  });

  it('records API requests and /api/t events, then every admin analytics route reads them back', async () => {
    await call('/api/projects/proj-1', { headers: { 'x-test-user': 'user-a' } });
    await call('/api/projects/proj-2', { headers: { 'x-test-user': 'user-b' } });
    const ingest = await call('/api/t', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://app.box.example',
        'x-test-user': 'user-a',
      },
      body: JSON.stringify({
        events: [
          {
            event: 'page_view',
            page: '/projects/p1?token=sekret-123',
            referrer: 'https://mail.example/inbox#access_token=sekret-456',
          },
        ],
      }),
    });
    expect(ingest.status).toBe(204);

    const stored = rows();
    // One row per project GET from the middleware, plus the page_view from /api/t.
    expect(stored.filter((r) => r.blob1 === 'page_view')).toHaveLength(1);
    expect(stored.map((r) => r.index1)).toEqual(expect.arrayContaining(['user-a', 'user-b']));
    // No query string or fragment survives into a stored row.
    expect(JSON.stringify(stored)).not.toContain('sekret');
    const pageView = stored.find((r) => r.blob1 === 'page_view')!;
    expect(pageView.blob3).toBe('/projects/p1');
    expect(pageView.blob4).toBe('https://mail.example/inbox');

    const dau = await call('/api/admin/analytics/dau');
    expect(dau.status, await dau.clone().text()).toBe(200);
    const dauBody = (await dau.json()) as { dau: Array<{ unique_users: number }> };
    expect(dauBody.dau).toHaveLength(1);
    expect(dauBody.dau[0]!.unique_users).toBe(2);

    const events = await call('/api/admin/analytics/events?period=24h');
    expect(events.status).toBe(200);
    const eventBody = JSON.stringify(await events.json());
    expect(eventBody).toContain('page_view');

    for (const route of ['funnel', 'feature-adoption', 'geo', 'retention', 'website-traffic']) {
      const res = await call(`/api/admin/analytics/${route}`);
      expect(res.status, route).toBe(200);
    }
    const traffic = await (await call('/api/admin/analytics/website-traffic')).json();
    expect(JSON.stringify(traffic)).toContain('app.box.example');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('without the switch, a box keeps answering FEATURE_UNAVAILABLE and writes nothing', async () => {
    env = { ...env, ANALYTICS_SINK: undefined } as Env;
    await call('/api/projects/proj-1', { headers: { 'x-test-user': 'user-a' } });
    expect(rows()).toHaveLength(0);
    const res = await call('/api/admin/analytics/dau');
    expect(res.status).toBe(404);
  });

  it('the observability purge bounds the table by age and by row cap', async () => {
    const insert = obsDb.prepare(
      "INSERT INTO analytics_events (timestamp, index1, blob1) VALUES (datetime('now', ?), 'u', 'e')"
    );
    insert.run('-200 days');
    insert.run('-100 days');
    for (let i = 0; i < 5; i += 1) insert.run(`-${i} hours`);

    await runObservabilityPurge({ ...env, ANALYTICS_D1_MAX_ROWS: '3' } as Env);

    const left = rows();
    expect(left).toHaveLength(3);
    // Both rows past the 90-day default are gone by age; the cap then keeps the newest three
    // by insertion (ids 5..7 of 7).
    expect(left.map((r) => r.id)).toEqual([5, 6, 7]);
  });

  it('refuses Analytics Engine SQL it cannot translate instead of returning wrong numbers', () => {
    expect(() => translateAnalyticsSql('SELECT quantileWeighted(0.5)(double1) FROM ds')).toThrow(
      /cannot translate/
    );
    expect(
      translateAnalyticsSql(
        "SELECT toDate(timestamp) AS d, count() FROM sam_ds WHERE timestamp >= NOW() - INTERVAL '7' DAY"
      )
    ).toBe(
      "SELECT date(timestamp) AS d, count(*) FROM analytics_events WHERE timestamp >= datetime('now', '-7 days')"
    );
  });
});
