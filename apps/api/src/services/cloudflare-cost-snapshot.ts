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
 * I/O per run (rule 47): 3 settings reads (cached per isolate), 1 D1 read of the stored rows
 * from the first month's 1st through the window's end, 1 GraphQL request bounded by `performance.externalReadTimeoutMs`, 1 D1 batch writing every
 * row plus the sync status. Callers isolate it (rule 53): the daily cron and the superadmin refresh
 * route catch and log; this function itself records failures and never throws for them.
 */
import {
  INSIGHTS_CLOUDFLARE_COST_SETTINGS,
  type InsightsCloudflareCostSettingName,
} from '@simple-agent-manager/operations';
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
/** Used only if the `performance.externalReadTimeoutMs` setting resolves to an unusable value. */
const DEFAULT_EXTERNAL_READ_TIMEOUT_MS = 15_000;

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

const SETTING_DEFAULTS = Object.fromEntries(
  INSIGHTS_CLOUDFLARE_COST_SETTINGS.map((setting) => [setting.name, setting.defaultValue])
) as Record<InsightsCloudflareCostSettingName, number>;

async function positiveSetting(
  env: Env,
  name: Parameters<typeof resolveAdminSetting>[1],
  fallback: number
) {
  const value = Number(await resolveAdminSetting(env, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Usage already stored from the first month's 1st through the window's end. Days before the
 * window set how much of the monthly allowance is used; days inside it stand in for any day this
 * fetch returned nothing for.
 */
async function readStoredUsage(
  env: Env,
  firstDay: string,
  lastDay: string
): Promise<Map<string, Map<CloudflareCostMetricKey, number>>> {
  const prefix = new Map<string, Map<CloudflareCostMetricKey, number>>();
  const result = await env.DATABASE.prepare(
    `SELECT day, product_line, usage_quantity FROM installation_cost_daily
      WHERE source = ? AND day >= ? AND day <= ?`
  )
    .bind(CLOUDFLARE_COST_SOURCE, monthStart(firstDay), lastDay)
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
 * One row per fetched day with data per product line, each costed against its calendar month:
 * the month's earlier days (fetched, else stored, else zero when never collected) consume the
 * monthly allowance first.
 */
export function buildDailyCostRows(
  fetched: CloudflareDailyUsage[],
  prefix: Map<string, Map<CloudflareCostMetricKey, number>>
): DailyCostRow[] {
  const pricing = createCloudflarePricing();
  // A day with no usage at all is a day Cloudflare returned nothing for: storage alone (D1, R2,
  // KV) is never zero on a live account. Writing it would replace good stored usage with zeros
  // after a partial analytics outage, so it is left unwritten and counts as missing on the card.
  const withData = fetched.filter((entry) =>
    CLOUDFLARE_COST_METRIC_KEYS.some((key) => entry.metrics[key] !== 0)
  );
  const fetchedByDay = new Map(withData.map((entry) => [entry.date, entry]));
  const months = [...new Set(withData.map((entry) => entry.date.slice(0, 7)))];
  const rows: DailyCostRow[] = [];
  for (const month of months) {
    const monthDays = withData.filter((entry) => entry.date.startsWith(month));
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
  // A failed attempt leaves the last success, the window it stored and its row count in place
  // (rule 73).
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
       rows_written = CASE WHEN excluded.status = 'ok'
         THEN excluded.rows_written ELSE installation_cost_sync.rows_written END`
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
      const backfillDays = await positiveSetting(
        env,
        'insights.cloudflareCostBackfillDays',
        SETTING_DEFAULTS['insights.cloudflareCostBackfillDays']
      );
      const queryLimit = await positiveSetting(
        env,
        'insights.cloudflareCostQueryLimit',
        SETTING_DEFAULTS['insights.cloudflareCostQueryLimit']
      );
      const timeoutMs = await positiveSetting(
        env,
        'performance.externalReadTimeoutMs',
        DEFAULT_EXTERNAL_READ_TIMEOUT_MS
      );
      const { firstDay, lastDay } = cloudflareCostWindow(nowMs, backfillDays);
      const prefix = await readStoredUsage(env, firstDay, lastDay);
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
      if (!response.ok)
        throw cloudflareCostHttpError(response.status, await response.json().catch(() => null));
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

/** When the last snapshot attempt started, for the refresh route's minimum interval. */
export async function lastCloudflareCostAttemptAt(env: Env): Promise<number | null> {
  const row = await env.DATABASE.prepare(
    `SELECT last_attempt_at FROM installation_cost_sync WHERE source = ?`
  )
    .bind(CLOUDFLARE_COST_SOURCE)
    .first<{ last_attempt_at: unknown }>();
  return typeof row?.last_attempt_at === 'number' ? row.last_attempt_at : null;
}
