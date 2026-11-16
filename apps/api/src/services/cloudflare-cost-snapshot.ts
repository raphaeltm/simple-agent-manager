/**
 * Daily Cloudflare cost snapshot (Insights slice CF, idea 01M7HTS38KX2G78JD0ESAGMKKH).
 *
 * Fetches the last `insights.cloudflareCostBackfillDays` complete UTC days of billed usage from the
 * Cloudflare GraphQL analytics API (the same request and analysis as `pnpm quality:cloudflare-cost`,
 * `packages/shared/src/cloudflare-cost/`, rule 76) and upserts one `installation_cost_daily` row per
 * day per product line. Re-running is idempotent: every run re-fetches its whole window, so late
 * analytics and gaps up to the window converge.
 *
 * Credential: the Worker's existing `CF_API_TOKEN` + `CF_ACCOUNT_ID`; the token needs
 * Account → Account Analytics → Read (Admin Analytics' Analytics Engine queries need the same).
 * Without them the run records `not_configured` and does nothing else.
 *
 * I/O per run (rule 47): 3 settings reads (cached per isolate), 1 D1 read of the month's earlier
 * rows, 1 GraphQL request bounded by `performance.externalReadTimeoutMs`, 1 D1 batch writing every
 * row plus the sync status. Callers isolate it (rule 53): the daily cron and the superadmin refresh
 * route catch and log; this function itself records failures and never throws for them.
 */
import {
  CLOUDFLARE_ANALYTICS_MAX_DAYS,
  CLOUDFLARE_COST_METRIC_KEYS,
  CLOUDFLARE_GRAPHQL_ENDPOINT,
  cloudflareCostHttpError,
  type CloudflareCostMetricKey,
  cloudflareCostQueryBody,
  CloudflareCostQueryError,
  type CloudflareDailyUsage,
  cloudflareDailyUsage,
  cloudflareDaysInMonth,
  createCloudflarePricing,
  dailyCloudflareMetricCosts,
  type InstallationCloudflareRefreshResponse,
  isCloudflareCostMetricKey,
  parseCloudflareCostResponse,
} from '@simple-agent-manager/shared';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '@simple-agent-manager/worker-core';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings-resolution';
import { fetchWithTimeout } from './fetch-timeout';

export const CLOUDFLARE_COST_SOURCE = 'cloudflare';
const DAY_MS = 86_400_000;
const ERROR_MESSAGE_MAX_LENGTH = 500;
const UPSERT_COLUMNS = 7;

export type CloudflareCostSnapshotResult = InstallationCloudflareRefreshResponse;

interface DailyCostRow {
  day: string;
  productLine: CloudflareCostMetricKey;
  usage: number;
  unit: string;
  costUsd: number;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC day before `nowMs`, and the first day of a window of `days` ending there. */
export function cloudflareCostWindow(
  nowMs: number,
  days: number
): { firstDay: string; lastDay: string } {
  const today = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate()
  );
  const span = Math.min(Math.max(1, Math.floor(days)), CLOUDFLARE_ANALYTICS_MAX_DAYS);
  return { firstDay: isoDay(today - span * DAY_MS), lastDay: isoDay(today - DAY_MS) };
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

async function positiveSetting(
  env: Env,
  name: Parameters<typeof resolveAdminSetting>[1],
  fallback: number
) {
  const value = Number(await resolveAdminSetting(env, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Usage already stored for the month's days before the window (they set the allowance used). */
async function readMonthPrefix(
  env: Env,
  firstDay: string
): Promise<Map<string, Map<CloudflareCostMetricKey, number>>> {
  const prefix = new Map<string, Map<CloudflareCostMetricKey, number>>();
  const start = monthStart(firstDay);
  if (start === firstDay) return prefix;
  const result = await env.DATABASE.prepare(
    `SELECT day, product_line, usage_quantity FROM installation_cost_daily
      WHERE source = ? AND day >= ? AND day < ?`
  )
    .bind(CLOUDFLARE_COST_SOURCE, start, firstDay)
    .all<{ day: unknown; product_line: unknown; usage_quantity: unknown }>();
  for (const row of result.results ?? []) {
    if (typeof row.day !== 'string' || !isCloudflareCostMetricKey(row.product_line)) continue;
    const usage = typeof row.usage_quantity === 'number' ? row.usage_quantity : 0;
    const day = prefix.get(row.day) ?? new Map<CloudflareCostMetricKey, number>();
    day.set(row.product_line, usage);
    prefix.set(row.day, day);
  }
  return prefix;
}

/**
 * One row per fetched day per product line, each costed against its calendar month: the month's
 * earlier days (stored, or zero when never collected) consume the monthly allowance first.
 */
export function buildDailyCostRows(
  fetched: CloudflareDailyUsage[],
  prefix: Map<string, Map<CloudflareCostMetricKey, number>>
): DailyCostRow[] {
  const pricing = createCloudflarePricing();
  const fetchedByDay = new Map(fetched.map((entry) => [entry.date, entry]));
  const months = [...new Set(fetched.map((entry) => entry.date.slice(0, 7)))];
  const rows: DailyCostRow[] = [];
  for (const month of months) {
    const monthDays = fetched.filter((entry) => entry.date.startsWith(month));
    const lastDay = monthDays[monthDays.length - 1]?.date;
    if (!lastDay) continue;
    const dayCount = Number(lastDay.slice(8, 10));
    const days = Array.from(
      { length: dayCount },
      (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`
    );
    const daysInMonth = cloudflareDaysInMonth(lastDay);
    for (const key of CLOUDFLARE_COST_METRIC_KEYS) {
      const metric = pricing.metrics[key];
      const values = days.map(
        (day) => fetchedByDay.get(day)?.metrics[key] ?? prefix.get(day)?.get(key) ?? 0
      );
      const costs = dailyCloudflareMetricCosts(values, metric, daysInMonth);
      days.forEach((day, index) => {
        if (!fetchedByDay.has(day)) return;
        rows.push({
          day,
          productLine: key,
          usage: values[index] ?? 0,
          unit: metric.unit,
          costUsd: costs[index] ?? 0,
        });
      });
    }
  }
  return rows;
}

function syncStatement(
  env: Env,
  result: CloudflareCostSnapshotResult,
  attemptAt: number
): D1PreparedStatement {
  // A failed attempt leaves the last success, and the window it stored, in place (rule 73).
  return env.DATABASE.prepare(
    `INSERT INTO installation_cost_sync
       (source, status, last_attempt_at, last_success_at, error_message, first_day, last_day, rows_written)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       status = excluded.status,
       last_attempt_at = excluded.last_attempt_at,
       last_success_at = COALESCE(excluded.last_success_at, installation_cost_sync.last_success_at),
       error_message = excluded.error_message,
       first_day = COALESCE(excluded.first_day, installation_cost_sync.first_day),
       last_day = COALESCE(excluded.last_day, installation_cost_sync.last_day),
       rows_written = excluded.rows_written`
  ).bind(
    CLOUDFLARE_COST_SOURCE,
    result.status,
    attemptAt,
    result.status === 'ok' ? attemptAt : null,
    result.error,
    result.firstDay,
    result.lastDay,
    result.rowsWritten
  );
}

function upsertStatements(
  env: Env,
  rows: DailyCostRow[],
  fetchedAt: number
): D1PreparedStatement[] {
  const perStatement = Math.floor(D1_MAX_BOUND_PARAMETERS / UPSERT_COLUMNS);
  return chunk(rows, perStatement).map((batch) =>
    env.DATABASE.prepare(
      `INSERT INTO installation_cost_daily
         (source, day, product_line, usage_quantity, usage_unit, estimated_cost_usd, fetched_at)
       VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(source, day, product_line) DO UPDATE SET
         usage_quantity = excluded.usage_quantity,
         usage_unit = excluded.usage_unit,
         estimated_cost_usd = excluded.estimated_cost_usd,
         fetched_at = excluded.fetched_at`
    ).bind(
      ...batch.flatMap((row) => [
        CLOUDFLARE_COST_SOURCE,
        row.day,
        row.productLine,
        row.usage,
        row.unit,
        row.costUsd,
        fetchedAt,
      ])
    )
  );
}

function safeMessage(error: unknown, accountId: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(accountId).join('<account>').slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

export async function runCloudflareCostSnapshot(
  env: Env,
  nowMs: number = Date.now()
): Promise<CloudflareCostSnapshotResult> {
  const token = env.CF_API_TOKEN?.trim() ?? '';
  const accountId = env.CF_ACCOUNT_ID?.trim() ?? '';
  let result: CloudflareCostSnapshotResult;
  let rowStatements: D1PreparedStatement[] = [];
  if (!token || !accountId) {
    result = {
      status: 'not_configured',
      firstDay: null,
      lastDay: null,
      rowsWritten: 0,
      error: null,
    };
  } else {
    try {
      const backfillDays = await positiveSetting(env, 'insights.cloudflareCostBackfillDays', 30);
      const queryLimit = await positiveSetting(env, 'insights.cloudflareCostQueryLimit', 10_000);
      const timeoutMs = await positiveSetting(env, 'performance.externalReadTimeoutMs', 15_000);
      const { firstDay, lastDay } = cloudflareCostWindow(nowMs, backfillDays);
      const prefix = await readMonthPrefix(env, firstDay);
      const response = await fetchWithTimeout(
        CLOUDFLARE_GRAPHQL_ENDPOINT,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: cloudflareCostQueryBody({
            accountId,
            startDate: firstDay,
            endDate: lastDay,
            limit: queryLimit,
          }),
        },
        timeoutMs
      );
      if (!response.ok) throw cloudflareCostHttpError(response.status);
      const fetched = cloudflareDailyUsage(
        parseCloudflareCostResponse(await response.json(), queryLimit),
        firstDay,
        lastDay
      );
      const rows = buildDailyCostRows(fetched, prefix);
      rowStatements = upsertStatements(env, rows, nowMs);
      result = { status: 'ok', firstDay, lastDay, rowsWritten: rows.length, error: null };
    } catch (error) {
      const permission = error instanceof CloudflareCostQueryError && error.kind === 'permission';
      result = {
        status: permission ? 'permission_denied' : 'error',
        firstDay: null,
        lastDay: null,
        rowsWritten: 0,
        error: safeMessage(error, accountId),
      };
      rowStatements = [];
    }
  }

  // Rows and status commit together, so the card never shows a success whose rows are missing.
  await env.DATABASE.batch([...rowStatements, syncStatement(env, result, nowMs)]);
  const event = { ...result, source: CLOUDFLARE_COST_SOURCE };
  if (result.status === 'ok' || result.status === 'not_configured')
    log.info('cloudflare_cost_snapshot.completed', event);
  else
    log.error('cloudflare_cost_snapshot.failed', { ...event, action: 'recorded_for_admin_card' });
  return result;
}
