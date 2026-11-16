/**
 * runCloudflareCostSnapshot (Insights slice CF) against a real SQL engine built from the real
 * migration 0256, with the Cloudflare GraphQL endpoint faked at the network boundary using a
 * response in the shape production returns (fixtures/cloudflare-cost/graphql-two-days.json).
 * Settings resolve through the real admin settings resolver, so the defaults decide the window.
 *
 * NOW is 2026-11-16 12:00 UTC: the default 30-day window is 2026-10-17 through 2026-11-15.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OperationContext } from '@simple-agent-manager/operations';
import {
  INSIGHTS_CLOUDFLARE_COST_SETTINGS,
  readCloudflareCost,
} from '@simple-agent-manager/operations';
import { CLOUDFLARE_ANALYTICS_MAX_DAYS } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  buildDailyCostRows,
  cloudflareCostWindow,
  runCloudflareCostSnapshot,
} from '../../../src/services/cloudflare-cost-snapshot';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ACCOUNT_ID = 'acct0123456789abcdef0123456789ab';
const MIGRATION = readFileSync(
  resolve(__dirname, '../../../src/db/migrations/0256_installation_cost_daily.sql'),
  'utf8'
);
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../fixtures/cloudflare-cost/graphql-two-days.json'), 'utf8')
) as Record<string, unknown>;

interface Row {
  day: string;
  product_line: string;
  usage_quantity: number;
  usage_unit: string;
  estimated_cost_usd: number;
  fetched_at: number;
}

describe('runCloudflareCostSnapshot', () => {
  let sqlite: Database.Database;
  let env: Env;
  let fetchMock: ReturnType<typeof vi.fn>;
  let payload: unknown;
  let httpStatus: number;
  let binds: number[];

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // The tables under test come from the real migration, not the drizzle mirror.
    sqlite.exec('DROP TABLE installation_cost_daily; DROP TABLE installation_cost_sync;');
    sqlite.exec(MIGRATION);
    payload = structuredClone(FIXTURE);
    httpStatus = 200;
    // A fresh Response per call: a body can be read only once (`.claude/rules/72`).
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: httpStatus,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    binds = [];
    const db = createSqliteD1(sqlite);
    const prepare = db.prepare.bind(db);
    // D1 rejects a statement with more than 100 bound parameters; better-sqlite3 does not, so
    // the test enforces the production ceiling itself (`.claude/rules/69`).
    db.prepare = (query: string) => {
      const statement = prepare(query);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        binds.push(values.length);
        return bind(...values);
      };
      return statement;
    };
    env = {
      DATABASE: db,
      BASE_DOMAIN: 'example.test',
      CF_API_TOKEN: 'analytics-token',
      CF_ACCOUNT_ID: ACCOUNT_ID,
    } as unknown as Env;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  const rows = (where = '1 = 1'): Row[] =>
    sqlite
      .prepare(`SELECT * FROM installation_cost_daily WHERE ${where} ORDER BY day, product_line`)
      .all() as Row[];
  const row = (day: string, line: string): Row | undefined =>
    rows(`day = '${day}' AND product_line = '${line}'`)[0];
  const sync = () =>
    sqlite.prepare(`SELECT * FROM installation_cost_sync WHERE source = 'cloudflare'`).get() as
      Record<string, unknown> | undefined;

  it('asks Cloudflare for the last 30 complete days in one account-analytics request', async () => {
    await runCloudflareCostSnapshot(env, NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer analytics-token');
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.variables).toMatchObject({
      accountTag: ACCOUNT_ID,
      start: '2026-10-17',
      end: '2026-11-15',
    });
    // Rule 76: billed duration, never invocation wallTime; never the billable-usage endpoint.
    expect(body.query).toContain('durableObjectsPeriodicGroups');
    expect(body.query).not.toContain('wallTime');
    expect(url).not.toContain('billable');
  });

  it('maps the GraphQL response to one row per day per product line', async () => {
    const result = await runCloudflareCostSnapshot(env, NOW);

    // Only the two days Cloudflare returned usage for are written (19 product lines each).
    expect(result).toMatchObject({
      status: 'ok',
      firstDay: '2026-10-17',
      lastDay: '2026-11-15',
      rowsWritten: 2 * 19,
    });
    expect(rows()).toHaveLength(2 * 19);
    // Tail-worker invocations are not request billing; their CPU time is.
    expect(row('2026-11-15', 'workersRequests')?.usage_quantity).toBe(261_618 + 311);
    expect(row('2026-11-14', 'workersRequests')?.usage_quantity).toBe(239_740);
    expect(row('2026-11-15', 'workersCpuMs')?.usage_quantity).toBeCloseTo(
      (224_486_837 + 2_950_138_482 + 113_113_779) / 1000
    );
    expect(row('2026-11-15', 'doDurationGbSeconds')?.usage_quantity).toBeCloseTo(13_010.0247, 3);
    expect(row('2026-11-15', 'doRequests')?.usage_quantity).toBe(329_723);
    expect(row('2026-11-15', 'kvReads')?.usage_quantity).toBe(45_849);
    expect(row('2026-11-15', 'kvStorageGb')?.usage_quantity).toBeCloseTo(756_707 / 1e9);
    expect(row('2026-11-15', 'r2StorageGb')?.usage_quantity).toBeCloseTo(174);
    expect(row('2026-11-15', 'd1RowsRead')?.usage_unit).toBe('rows');
    // A day Cloudflare returned nothing for is not written, so the card counts it as missing.
    expect(row('2026-10-20', 'workersRequests')).toBeUndefined();
    // R2 above its 10 GB allowance costs 1/30 of a month at that level for the day.
    expect(row('2026-11-15', 'r2StorageGb')?.estimated_cost_usd).toBeCloseTo(
      ((174 - 10) * 0.015) / 30,
      6
    );
    // Workers AI over its daily 10k-neuron allowance: 11k neurons at $0.011 per 1k.
    expect(row('2026-11-15', 'workersAiNeurons')?.estimated_cost_usd).toBeCloseTo(0.121, 6);
    expect(row('2026-11-15', 'workersRequests')?.fetched_at).toBe(NOW);
    expect(sync()).toMatchObject({
      status: 'ok',
      last_attempt_at: NOW,
      last_success_at: NOW,
      error_message: null,
      rows_written: 38,
    });
  });

  it("keeps every statement within D1's 100 bound parameters across a full window", async () => {
    // Usage on all 30 days of the default window: 30 × 19 = 570 rows, 41 statements with a
    // remainder, so full chunks and a short last chunk both run.
    const full = structuredClone(FIXTURE) as {
      data: { viewer: { accounts: { d1StorageAdaptiveGroups: unknown[] }[] } };
    };
    full.data.viewer.accounts[0]!.d1StorageAdaptiveGroups = Array.from({ length: 30 }, (_, i) => ({
      dimensions: {
        databaseId: 'd1-database-a',
        date: new Date(Date.UTC(2026, 9, 17 + i)).toISOString().slice(0, 10),
      },
      max: { databaseSizeBytes: 544_700_000 },
    }));
    payload = full;

    const result = await runCloudflareCostSnapshot(env, NOW);

    expect(binds.length).toBeGreaterThan(40);
    expect(Math.max(...binds)).toBeLessThanOrEqual(100);
    expect(result.rowsWritten).toBe(30 * 19);
    expect(rows()).toHaveLength(30 * 19);
  });

  it('is idempotent: a second run upserts the same rows and refreshes their values', async () => {
    await runCloudflareCostSnapshot(env, NOW);
    const first = rows();

    await runCloudflareCostSnapshot(env, NOW + 3_600_000);
    const second = rows();
    expect(second).toHaveLength(first.length);
    expect(second.map(({ fetched_at: _f, ...rest }) => rest)).toEqual(
      first.map(({ fetched_at: _f, ...rest }) => rest)
    );
    expect(second.every((r) => r.fetched_at === NOW + 3_600_000)).toBe(true);

    // Late analytics for a day replace the stored value instead of adding a row.
    const late = structuredClone(FIXTURE) as {
      data: {
        viewer: { accounts: { d1AnalyticsAdaptiveGroups: { sum: { rowsRead: number } }[] }[] };
      };
    };
    late.data.viewer.accounts[0]!.d1AnalyticsAdaptiveGroups[1]!.sum.rowsRead = 140_000_000;
    payload = late;
    await runCloudflareCostSnapshot(env, NOW + 7_200_000);
    expect(rows()).toHaveLength(first.length);
    expect(row('2026-11-15', 'd1RowsRead')?.usage_quantity).toBe(140_000_000);
  });

  it("costs a window's first days against the month's stored earlier days", async () => {
    // October 1-16 already used the whole 50M DO rows-written allowance.
    const insert = sqlite.prepare(
      `INSERT INTO installation_cost_daily VALUES ('cloudflare', ?, 'doRowsWritten', ?, 'rows', 0, 1)`
    );
    for (let day = 1; day <= 16; day++)
      insert.run(`2026-10-${String(day).padStart(2, '0')}`, 50_000_000 / 16);
    const late = structuredClone(FIXTURE) as {
      data: { viewer: { accounts: { durableObjectsPeriodicGroups: unknown[] }[] } };
    };
    late.data.viewer.accounts[0]!.durableObjectsPeriodicGroups.push({
      dimensions: { date: '2026-10-17' },
      sum: { activeTime: 0, duration: 0, rowsRead: 0, rowsWritten: 2_000_000 },
    });
    payload = late;

    await runCloudflareCostSnapshot(env, NOW);

    // 2M rows past the allowance at $1 per million. Without the stored prefix this would be $0.
    expect(row('2026-10-17', 'doRowsWritten')?.estimated_cost_usd).toBeCloseTo(2, 6);
    // November starts a new month: its first 50M rows written are free again.
    expect(row('2026-11-15', 'doRowsWritten')?.estimated_cost_usd).toBe(0);
    // The stored prefix rows are left alone.
    expect(row('2026-10-01', 'doRowsWritten')?.fetched_at).toBe(1);
  });

  it('never overwrites stored usage with a response that has no data for those days', async () => {
    await runCloudflareCostSnapshot(env, NOW);
    const stored = rows();
    expect(stored.length).toBeGreaterThan(0);

    // A 200 with every dataset empty (a partial analytics outage).
    payload = { data: { viewer: { accounts: [{}] } }, errors: null };
    const result = await runCloudflareCostSnapshot(env, NOW + 3_600_000);

    expect(result).toMatchObject({ status: 'ok', rowsWritten: 0 });
    expect(rows()).toEqual(stored);
  });

  it('reads back through the Health & cost card what the snapshot wrote', async () => {
    await runCloudflareCostSnapshot(env, NOW);
    const ctx = { env } as unknown as OperationContext;

    const card = await readCloudflareCost(ctx, NOW, {
      seriesDays: 30,
      topLines: 5,
      projectionDays: 7,
    });

    const novemberCost = rows("day LIKE '2026-11-%'").reduce((t, r) => t + r.estimated_cost_usd, 0);
    expect(card.status).toBe('ok');
    expect(card.throughDay).toBe('2026-11-15');
    expect(card.monthToDateUsd).toBeCloseTo(novemberCost, 9);
    expect(card.missingDays).toBe(13);
    expect(card.productLines.map((line) => line.key)).toContain('r2StorageGb');
    expect(card.daily.at(-1)?.costUsd).toBeGreaterThan(0);
  });

  it.each([
    [
      'a token without Account Analytics: Read',
      200,
      { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    ],
    [
      'the same body on HTTP 403',
      403,
      { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    ],
    [
      'an invalid token (HTTP 400)',
      400,
      { success: false, errors: [{ code: 9106, message: 'Authentication failed (status: 400)' }] },
    ],
    [
      'a token for a different account',
      200,
      {
        data: null,
        errors: [
          {
            message: 'not authorized for that account',
            path: ['viewer', 'accounts', '0', 'd1AnalyticsAdaptiveGroups'],
            extensions: { code: 'authz' },
          },
        ],
      },
    ],
  ])(
    "records permission_denied for %s (Cloudflare's real error shape)",
    async (_name, status, body) => {
      httpStatus = status;
      payload = body;
      const result = await runCloudflareCostSnapshot(env, NOW);
      expect(result.status).toBe('permission_denied');
      expect(sync()).toMatchObject({ status: 'permission_denied' });
    }
  );

  it('records not_configured and makes no request when the token or account is missing', async () => {
    for (const missing of [{ CF_API_TOKEN: '' }, { CF_ACCOUNT_ID: '  ' }]) {
      const result = await runCloudflareCostSnapshot({ ...env, ...missing } as Env, NOW);
      expect(result).toMatchObject({ status: 'not_configured', rowsWritten: 0 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(sync()).toMatchObject({ status: 'not_configured', last_success_at: null });
  });

  it('records permission_denied without touching stored days or the last success', async () => {
    await runCloudflareCostSnapshot(env, NOW);
    const stored = rows();

    payload = { data: null, errors: [{ message: 'Authentication error', code: 10000 }] };
    const denied = await runCloudflareCostSnapshot(env, NOW + 86_400_000);
    expect(denied.status).toBe('permission_denied');

    httpStatus = 403;
    payload = { success: false };
    const forbidden = await runCloudflareCostSnapshot(env, NOW + 2 * 86_400_000);
    expect(forbidden.status).toBe('permission_denied');

    expect(rows()).toEqual(stored);
    expect(sync()).toMatchObject({
      status: 'permission_denied',
      last_attempt_at: NOW + 2 * 86_400_000,
      last_success_at: NOW,
      first_day: '2026-10-17',
      last_day: '2026-11-15',
    });
  });

  it('records other Cloudflare failures as error without the account id', async () => {
    payload = {
      data: null,
      errors: [
        {
          message: `account "${ACCOUNT_ID}" cannot request data older than 4w4d`,
          extensions: { code: 'quota' },
        },
      ],
    };
    const result = await runCloudflareCostSnapshot(env, NOW);

    expect(result.status).toBe('error');
    expect(result.error).toContain('cannot request data older than 4w4d');
    expect(result.error).not.toContain(ACCOUNT_ID);
    expect(String(sync()?.error_message)).not.toContain(ACCOUNT_ID);
    expect(rows()).toEqual([]);
  });

  it('refuses a dataset that reached the row limit instead of storing a partial estimate', async () => {
    const huge = structuredClone(FIXTURE) as {
      data: { viewer: { accounts: { kvStorageAdaptiveGroups: unknown[] }[] } };
    };
    huge.data.viewer.accounts[0]!.kvStorageAdaptiveGroups = Array.from(
      { length: 10_000 },
      (_, i) => ({
        dimensions: { date: '2026-11-15', namespaceId: `ns-${i}` },
        max: { byteCount: 1 },
      })
    );
    payload = huge;
    const result = await runCloudflareCostSnapshot(env, NOW);

    expect(result.status).toBe('error');
    expect(result.error).toContain('refusing a partial cost estimate');
    expect(rows()).toEqual([]);
  });
});

describe('insights.cloudflareCostBackfillDays', () => {
  it("cannot be set past Cloudflare's own analytics limit", () => {
    const backfill = INSIGHTS_CLOUDFLARE_COST_SETTINGS.find(
      (setting) => setting.name === 'insights.cloudflareCostBackfillDays'
    );
    expect(backfill?.range.max).toBe(CLOUDFLARE_ANALYTICS_MAX_DAYS);
  });
});

describe('cloudflareCostWindow', () => {
  it('ends at the last complete UTC day and never reaches back past 31 days', () => {
    expect(cloudflareCostWindow(NOW, 30)).toEqual({
      firstDay: '2026-10-17',
      lastDay: '2026-11-15',
    });
    expect(cloudflareCostWindow(NOW, 1)).toEqual({ firstDay: '2026-11-15', lastDay: '2026-11-15' });
    expect(cloudflareCostWindow(NOW, 400).firstDay).toBe('2026-10-16');
    expect(cloudflareCostWindow(Date.parse('2026-11-01T00:30:00Z'), 2)).toEqual({
      firstDay: '2026-10-30',
      lastDay: '2026-10-31',
    });
  });
});

describe('buildDailyCostRows', () => {
  it('sums each month to the cost of its total usage', () => {
    const day = (date: string, rowsWritten: number) => ({
      date,
      metrics: { doRowsWritten: rowsWritten } as Record<string, number>,
    });
    const fetched = [
      day('2026-11-01', 30_000_000),
      day('2026-11-02', 30_000_000),
      day('2026-11-03', 5_000_000),
    ].map((entry) => ({
      ...entry,
      metrics: Object.fromEntries(
        [
          'workersRequests',
          'workersCpuMs',
          'doRequests',
          'doDurationGbSeconds',
          'doRowsRead',
          'doRowsWritten',
          'doStorageReadUnits',
          'doStorageWriteUnits',
          'd1RowsRead',
          'd1RowsWritten',
          'd1StorageGb',
          'kvReads',
          'kvWrites',
          'kvDeletes',
          'kvLists',
          'kvStorageGb',
          'r2StorageGb',
          'workersAiNeurons',
          'containerMemoryGibSeconds',
        ].map((key) => [key, entry.metrics[key] ?? 0])
      ),
    })) as Parameters<typeof buildDailyCostRows>[0];
    const costs = buildDailyCostRows(fetched, new Map())
      .filter((r) => r.productLine === 'doRowsWritten')
      .map((r) => r.costUsd);

    // 65M rows, 50M free: day 1 is free, day 2 pays 10M, day 3 pays 5M.
    expect(costs[0]).toBe(0);
    expect(costs[1]).toBeCloseTo(10, 6);
    expect(costs[2]).toBeCloseTo(5, 6);
  });
});
