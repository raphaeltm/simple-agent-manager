/**
 * Self-host analytics on D1 (selfhost/analytics, installed by the self-host entry and switched on
 * with ANALYTICS_SINK="d1"), end to end on a real SQLite engine: the request middleware and
 * `/api/t` write through the real routes into the shared observability migration chain plus the
 * self-host projection, then every admin analytics route reads it back through the real
 * Analytics Engine SQL (translated). `fetch` is stubbed only to prove nothing calls Cloudflare.
 * Auth and rate limiting are bypassed; they are not what is under test.
 *
 * The Cloudflare side of the same seam (nothing installed: Analytics Engine writes, the SQL API,
 * no D1 call, no analytics table) is pinned at the end of this file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { analyticsMiddleware } from '../../../src/middleware/analytics';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAnalyticsRoutes } from '../../../src/routes/admin-analytics';
import { analyticsIngestRoutes } from '../../../src/routes/analytics-ingest';
import { runObservabilityPurge } from '../../../src/scheduled/observability-purge';
import { installAnalyticsD1Sink } from '../../../src/selfhost/analytics';
import { translateAnalyticsSql } from '../../../src/selfhost/analytics/d1-sink';
import { ANALYTICS_D1_MAX_ROWS_SETTING } from '../../../src/selfhost/analytics/settings';
import { SELFHOST_OBSERVABILITY_MIGRATIONS } from '../../../src/selfhost/observability-migrations';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { resetInstalledAdminSettingDefinitionsForTests } from '../../../src/services/admin-settings-registry';
import { resetLocalAnalyticsSinkExtensionForTests } from '../../../src/services/analytics-sink';
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
const API_SRC = new URL('../../../src/', import.meta.url);

let settingsDb: Database.Database;
let obsDb: Database.Database;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;
let pending: Promise<unknown>[];

/** The shared chain wrangler.toml applies on Cloudflare (the observability migrations_dir). */
function sharedObservabilityMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** What the self-host packager applies: the shared chain, then the self-host projection. */
function applyObservabilityMigrations(db: Database.Database, selfHost = true) {
  for (const file of sharedObservabilityMigrationFiles()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  if (!selfHost) return;
  for (const file of SELFHOST_OBSERVABILITY_MIGRATIONS) {
    db.exec(readFileSync(fileURLToPath(new URL(file, API_SRC)), 'utf8'));
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
  // What the self-host entry does once before any request.
  installAnalyticsD1Sink();
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
  resetLocalAnalyticsSinkExtensionForTests();
  resetInstalledAdminSettingDefinitionsForTests();
  settingsDb.close();
  obsDb.close();
});

const rows = () =>
  obsDb.prepare('SELECT * FROM analytics_events ORDER BY id').all() as Array<
    Record<string, string | number>
  >;

describe('D1 analytics sink (self-host)', () => {
  it('advertises analyticsQuery only when the sink is switched on', () => {
    expect(resolvePlatformCapabilities(env)).toMatchObject({
      analyticsQuery: true,
      workersObservability: false,
    });
    expect(resolvePlatformCapabilities({ ...env, ANALYTICS_SINK: undefined } as Env)).toMatchObject(
      { analyticsQuery: false }
    );
  });

  it('records API requests and /api/t events, then every admin analytics route reads them back', async () => {
    await call('/api/projects/proj-1', {
      headers: { 'x-test-user': 'user-a', referer: 'https://app.box.example/invite/sekret-abc' },
    });
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
            referrer: 'https://mail.example/invite/sekret-789?x=1#access_token=sekret-456',
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
    expect(pageView.blob4).toBe('https://mail.example');

    const dau = await call('/api/admin/analytics/dau');
    expect(dau.status, await dau.clone().text()).toBe(200);
    const dauBody = (await dau.json()) as { dau: Array<{ unique_users: number }> };
    expect(dauBody.dau).toHaveLength(1);
    expect(dauBody.dau[0]!.unique_users).toBe(2);

    const events = await call('/api/admin/analytics/events?period=24h');
    expect(events.status).toBe(200);
    const eventBody = JSON.stringify(await events.json());
    expect(eventBody).toContain('page_view');

    // Funnel, geo and retention were retired on main (Insights H2, #2822).
    for (const route of ['feature-adoption', 'website-traffic']) {
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

    await updateAdminSettings(env, {
      changes: [{ name: ANALYTICS_D1_MAX_ROWS_SETTING, value: 3 }],
      actorUserId: 'admin-1',
    });
    await runObservabilityPurge(env);

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

describe('Cloudflare (the shared Worker installs no local sink)', () => {
  let writeDataPoint: ReturnType<typeof vi.fn>;
  let observabilityPrepare: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The Cloudflare entry never imports selfhost/: undo the install the outer hook performed.
    resetLocalAnalyticsSinkExtensionForTests();
    resetInstalledAdminSettingDefinitionsForTests();
    writeDataPoint = vi.fn();
    observabilityPrepare = vi.fn(() => {
      throw new Error('Cloudflare analytics must not touch OBSERVABILITY_DATABASE');
    });
    // Production's shape (2026-11-18 script settings): Analytics Engine binding, generated dataset,
    // Cloudflare account API, no ANALYTICS_SINK. Even a stray ANALYTICS_SINK="d1" does nothing
    // without the self-host install.
    env = {
      ...env,
      ANALYTICS: { writeDataPoint },
      ANALYTICS_DATASET: 'sam_analytics',
      ANALYTICS_SINK: 'd1',
      CF_ACCOUNT_ID: 'account-1',
      CF_API_TOKEN: 'token-1',
      OBSERVABILITY_DATABASE: { prepare: observabilityPrepare, batch: observabilityPrepare },
    } as unknown as Env;
  });

  it('writes requests and /api/t events to Analytics Engine, never to D1', async () => {
    await call('/api/projects/proj-1', { headers: { 'x-test-user': 'user-a' } });
    const ingest = await call('/api/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://app.example.com' },
      body: JSON.stringify({ events: [{ event: 'page_view', page: '/projects/p1' }] }),
    });

    expect(ingest.status).toBe(204);
    // The project GET (middleware), the page_view (/api/t), and the middleware's own row for the
    // /api/t request: every one reached Analytics Engine.
    const written = writeDataPoint.mock.calls.map(
      ([point]) => point as { indexes: string[]; blobs: string[] }
    );
    expect(written.map((point) => point.blobs[0])).toContain('page_view');
    expect(
      written.some((point) => point.indexes[0] === 'user-a' && point.blobs[1] === 'proj-1')
    ).toBe(true);
    expect(observabilityPrepare).not.toHaveBeenCalled();
  });

  it('queries the Analytics Engine SQL API for admin analytics, with the generated dataset', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ date: '2026-11-18', unique_users: '3' }] }), {
        status: 200,
      })
    );

    const res = await call('/api/admin/analytics/dau');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql'
    );
    expect(String(init.body)).toContain('FROM sam_analytics');
    expect(observabilityPrepare).not.toHaveBeenCalled();
  });

  it('runs the observability purge without any analytics statement', async () => {
    const statements: string[] = [];
    const obs = createSqliteD1(obsDb);
    env = {
      ...env,
      OBSERVABILITY_DATABASE: {
        ...obs,
        prepare: (sql: string) => {
          statements.push(sql);
          return obs.prepare(sql);
        },
        batch: obs.batch.bind(obs),
      },
    } as unknown as Env;

    await runObservabilityPurge(env);

    // Liveness: the error purge ran; and nothing touched analytics_events.
    expect(statements.some((sql) => /platform_errors/.test(sql))).toBe(true);
    expect(statements.some((sql) => /analytics_events/.test(sql))).toBe(false);
  });

  it('the shared observability migration chain never creates the analytics table', () => {
    const cloudflareDb = new Database(':memory:');
    try {
      applyObservabilityMigrations(cloudflareDb, false);
      const tables = cloudflareDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      // Liveness: the shared chain did run.
      expect(tables.map((t) => t.name)).toContain('platform_errors');
      expect(tables.map((t) => t.name)).not.toContain('analytics_events');
      expect(sharedObservabilityMigrationFiles().join('\n')).not.toMatch(/analytics/);
    } finally {
      cloudflareDb.close();
    }
  });
});
