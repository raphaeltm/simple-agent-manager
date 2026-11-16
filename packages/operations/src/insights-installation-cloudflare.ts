/**
 * The Cloudflare card on Admin Health & cost (Insights slice CF): the stored daily snapshot
 * (`installation_cost_daily`, written by apps/api `runCloudflareCostSnapshot`) for the month of
 * the latest stored day, projected with the same shared analysis `pnpm quality:cloudflare-cost`
 * uses (rule 76.4: spent so far plus the recent daily rate, not the running average).
 *
 * One round trip: a D1 batch reading the sync status and every row from the earlier of the latest
 * stored day's month start and the start of the daily series. At most ~62 days × 19 lines.
 * A malformed row is skipped and logged rather than failing the card (`.claude/rules/50`).
 */
import {
  CLOUDFLARE_COST_METRIC_KEYS,
  type CloudflareCostMetricKey,
  cloudflareDaysInMonth,
  createCloudflarePricing,
  type InstallationCloudflareCost,
  type InstallationCloudflareCostStatus,
  type InstallationCloudflareProductLine,
  isCloudflareCostMetricKey,
  projectCloudflareMetric,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import type { OperationContext } from './types';

const DAY_MS = 86_400_000;
const SOURCE = 'cloudflare';
const SYNC_STATUSES: readonly InstallationCloudflareCostStatus[] = [
  'not_configured',
  'permission_denied',
  'error',
  'ok',
];

interface CostRow {
  day: string;
  key: CloudflareCostMetricKey;
  usage: number;
  costUsd: number;
}

interface SyncRow {
  status: InstallationCloudflareCostStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoTime(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/** `YYYY-MM-DD` that names a real UTC calendar day (`2026-11-99` does not). */
function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function parseCostRow(raw: Record<string, unknown>): CostRow | null {
  const { day, product_line: key, usage_quantity: usage, estimated_cost_usd: cost } = raw;
  if (typeof day !== 'string' || !isCalendarDay(day)) return null;
  if (!isCloudflareCostMetricKey(key)) return null;
  if (typeof usage !== 'number' || !Number.isFinite(usage)) return null;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  return { day, key, usage, costUsd: cost };
}

function parseSync(raw: Record<string, unknown> | undefined): SyncRow | null {
  if (!raw) return null;
  const status = SYNC_STATUSES.find((value) => value === raw.status);
  if (!status) return null;
  return {
    status,
    lastAttemptAt: isoTime(raw.last_attempt_at),
    lastSuccessAt: isoTime(raw.last_success_at),
    error: typeof raw.error_message === 'string' ? raw.error_message : null,
  };
}

/** Month summary and daily series from the stored rows. Pure: tested with fixed rows. */
export function summarizeCloudflareCost(
  rows: CostRow[],
  sync: SyncRow | null,
  options: { seriesDays: number; topLines: number; projectionDays: number }
): InstallationCloudflareCost {
  const base = {
    status: sync?.status ?? 'never_run',
    lastAttemptAt: sync?.lastAttemptAt ?? null,
    lastSuccessAt: sync?.lastSuccessAt ?? null,
    error: sync?.error ?? null,
  } as const;
  const throughDay = rows.reduce<string | null>(
    (latest, row) => (latest === null || row.day > latest ? row.day : latest),
    null
  );
  if (!throughDay) {
    return {
      ...base,
      month: null,
      throughDay: null,
      monthComplete: false,
      missingDays: 0,
      monthToDateUsd: 0,
      projectedUsd: 0,
      productLines: [],
      otherProductLines: { count: 0, monthToDateUsd: 0, projectedUsd: 0 },
      daily: [],
    };
  }

  const month = throughDay.slice(0, 7);
  const elapsed = Number(throughDay.slice(8, 10));
  const daysInMonth = cloudflareDaysInMonth(throughDay);
  const monthComplete = elapsed === daysInMonth;
  const monthDays = Array.from(
    { length: elapsed },
    (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`
  );
  const byKeyDay = new Map<string, CostRow>();
  for (const row of rows) byKeyDay.set(`${row.key}|${row.day}`, row);
  const storedDays = new Set(rows.map((row) => row.day));
  const pricing = createCloudflarePricing();

  const lines: InstallationCloudflareProductLine[] = CLOUDFLARE_COST_METRIC_KEYS.map((key) => {
    const metric = pricing.metrics[key];
    const values = monthDays.map((day) => byKeyDay.get(`${key}|${day}`)?.usage ?? 0);
    const monthToDateUsd = monthDays.reduce(
      (total, day) => total + (byKeyDay.get(`${key}|${day}`)?.costUsd ?? 0),
      0
    );
    const projection = projectCloudflareMetric(values, throughDay, metric, options.projectionDays);
    return {
      key,
      product: metric.product,
      label: metric.label,
      unit: metric.unit,
      monthToDateUsage: projection.monthToDateUsage,
      monthToDateUsd,
      // A finished month has nothing left to project.
      projectedUsd: monthComplete
        ? monthToDateUsd
        : Math.max(projection.projectedCostUsd, monthToDateUsd),
    };
  });
  const ranked = [...lines].sort(
    (a, b) =>
      b.projectedUsd - a.projectedUsd ||
      b.monthToDateUsd - a.monthToDateUsd ||
      a.key.localeCompare(b.key)
  );
  const top = ranked.slice(0, Math.max(1, Math.floor(options.topLines)));
  const rest = ranked.slice(top.length);

  const seriesStart = Date.parse(`${throughDay}T00:00:00Z`) - (options.seriesDays - 1) * DAY_MS;
  const daily = Array.from({ length: options.seriesDays }, (_, index) => {
    const day = isoDay(seriesStart + index * DAY_MS);
    const dayRows = rows.filter((row) => row.day === day);
    return {
      day,
      costUsd: dayRows.length ? dayRows.reduce((total, row) => total + row.costUsd, 0) : null,
    };
  });

  return {
    ...base,
    month,
    throughDay,
    monthComplete,
    missingDays: monthDays.filter((day) => !storedDays.has(day)).length,
    monthToDateUsd: lines.reduce((total, line) => total + line.monthToDateUsd, 0),
    projectedUsd: lines.reduce((total, line) => total + line.projectedUsd, 0),
    productLines: top,
    otherProductLines: {
      count: rest.length,
      monthToDateUsd: rest.reduce((total, line) => total + line.monthToDateUsd, 0),
      projectedUsd: rest.reduce((total, line) => total + line.projectedUsd, 0),
    },
    daily,
  };
}

export async function readCloudflareCost(
  ctx: OperationContext,
  options: { seriesDays: number; topLines: number; projectionDays: number }
): Promise<InstallationCloudflareCost> {
  // The window is anchored on the latest stored day, not on today, so a snapshot that stopped
  // updating still shows its whole month and series. Only well-formed days can be the anchor.
  const [rowsResult, syncResult] = await ctx.env.DATABASE.batch<Record<string, unknown>>([
    ctx.env.DATABASE.prepare(
      `WITH latest AS (
         SELECT MAX(day) AS d FROM installation_cost_daily WHERE source = ? AND date(day) = day
       )
       SELECT day, product_line, usage_quantity, estimated_cost_usd
         FROM installation_cost_daily, latest
        WHERE source = ? AND latest.d IS NOT NULL AND day <= latest.d
          AND day >= MIN(date(latest.d, 'start of month'), date(latest.d, ?))`
    ).bind(SOURCE, SOURCE, `-${Math.max(0, Math.floor(options.seriesDays) - 1)} days`),
    ctx.env.DATABASE.prepare(
      `SELECT status, last_attempt_at, last_success_at, error_message
         FROM installation_cost_sync WHERE source = ?`
    ).bind(SOURCE),
  ]);
  const rows: CostRow[] = [];
  for (const raw of rowsResult?.results ?? []) {
    const row = parseCostRow(raw);
    if (row) rows.push(row);
    else
      log.warn('insights_installation.cloudflare_row_skipped', {
        day: String(raw.day),
        productLine: String(raw.product_line),
        action: 'skipped',
      });
  }
  return summarizeCloudflareCost(rows, parseSync(syncResult?.results?.[0]), options);
}
