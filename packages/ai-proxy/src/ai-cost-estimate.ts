/**
 * Catalog-priced spend estimate that backstops the AI Gateway monthly total. Gateway installs only.
 *
 * With a gateway, the gateway's logs are the spend record. The hourly cron
 * (`runMonthlyCostAggregation`) totals them into KV, so between runs that total trails what was
 * spent by up to an hour, and before the first run it does not exist. This module prices every
 * platform-funded response with the same catalog code the box uses (`priceModelUsageUsd`) and
 * keeps the result in the user's `AiTokenBudgetCounter`, in time buckets, so the cap can count
 * what the gateway total has not seen yet.
 *
 * Gateway authority (rule 74): the spend compared with the cap is
 *   gateway total (as of `asOf`) + estimate for calls since `asOf` − lag margin,
 * or the estimate for the month when there is no gateway total. The two windows do not overlap,
 * so nothing is counted twice except calls inside the lag margin, deliberately (gateway logs can
 * appear a few minutes after the call). Each cron run moves `asOf` forward and the gateway's own
 * figure replaces the estimate for that period, so a catalog price that is wrong for a model only
 * distorts the last ~hour, never the month. The estimate is never shown as spend.
 */
import {
  DEFAULT_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS,
  MAX_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS,
} from '@simple-agent-manager/shared';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

/** Longest TTL the monthly cost cron may give its KV totals (`resolveMonthlyCostCacheTtlSeconds`). */
export const MAX_MONTHLY_COST_CACHE_TTL_SECONDS = 86_400;

/** Storage granularity of the estimate, in ms. Keys are bucket start times, so this can change. */
export const COST_ESTIMATE_BUCKET_MS = 5 * 60_000;

/** Default and largest `aiProxy.costEstimateGatewayLagSeconds` (shared with the settings registry). */
export const DEFAULT_COST_ESTIMATE_GATEWAY_LAG_SECONDS =
  DEFAULT_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS;
export const MAX_COST_ESTIMATE_GATEWAY_LAG_SECONDS = MAX_AI_COST_ESTIMATE_GATEWAY_LAG_SECONDS;

/**
 * How long estimate buckets are kept: the longest a gateway total can stay readable (its KV TTL
 * cap) plus the largest lag margin and one bucket. A total older than this falls back to
 * `max(gateway, month estimate)` in `gatewayMonthlySpendUsd`.
 */
export const COST_ESTIMATE_RETENTION_MS =
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS * 1000 +
  MAX_COST_ESTIMATE_GATEWAY_LAG_SECONDS * 1000 +
  COST_ESTIMATE_BUCKET_MS;

/**
 * One response's cost, written in the same counter transaction as its daily tokens.
 * - `estimate`: a gateway-routed call. The gateway total will include it, so it only fills the
 *   window since the total was read (time buckets).
 * - `direct`: a call that bypassed the gateway (passthrough to the provider's own endpoint). No
 *   gateway total ever includes it, so SAM's price is its spend record for the whole month.
 */
export interface CostEstimateWrite {
  kind: 'estimate' | 'direct';
  costUsd: number;
  /** Start of the time bucket (epoch ms, multiple of `COST_ESTIMATE_BUCKET_MS`). */
  bucketStartMs: number;
  /** UTC month (`YYYY-MM`) the call belongs to. */
  monthKey: string;
  /** Buckets that start before this are deleted in the same transaction. */
  pruneBeforeMs: number;
}

/** What the pre-call gate reads from the counter on a gateway install, in one RPC. */
export interface GatewayAdmissionSnapshot {
  budget: { inputTokens: number; outputTokens: number };
  /** Estimate for the whole UTC month. */
  estimateMonthUsd: number;
  /** Estimate for buckets starting at or after the requested time; 0 when none was requested. */
  estimateSinceUsd: number;
  /** This month's priced spend on calls that bypassed the gateway (`kind: 'direct'`). */
  directMonthUsd: number;
}

/** The gateway's month total for a user as the cron recorded it. */
export interface GatewayMonthlyCost {
  costUsd: number;
  /** When the cron started reading logs (epoch ms); null for a legacy plain-number value. */
  asOfMs: number | null;
  /**
   * The cron's page cap stopped the read before the month's oldest logs, so `costUsd` is known to
   * be low. The month estimate is then a floor (`gatewayMonthlySpendUsd`).
   */
  truncated: boolean;
  /**
   * The part of `costUsd` on logs created before `beforeMs` (`asOf` minus the cron's settle
   * margin, one hour): logs the gateway has finished writing. The next cron run adds only logs from `beforeMs` on, so two
   * reads never count the same log (`runMonthlyCostAggregation`). Absent on legacy values and
   * where no exact base exists yet.
   */
  settled?: { usd: number; beforeMs: number };
}

export function utcMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function utcMonthStartMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function costEstimateBucketStart(ms: number): number {
  return Math.floor(ms / COST_ESTIMATE_BUCKET_MS) * COST_ESTIMATE_BUCKET_MS;
}

/** The write for one priced response, or undefined when it cost nothing. */
export function buildCostEstimateWrite(
  costUsd: number,
  kind: CostEstimateWrite['kind'] = 'estimate',
  now = new Date()
): CostEstimateWrite | undefined {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  const nowMs = now.getTime();
  return {
    kind,
    costUsd,
    bucketStartMs: costEstimateBucketStart(nowMs),
    monthKey: utcMonthKey(now),
    pruneBeforeMs: costEstimateBucketStart(nowMs - COST_ESTIMATE_RETENTION_MS),
  };
}

/** KV value the cron writes: the total and when it was read. */
export function serializeGatewayMonthlyCost(
  costUsd: number,
  asOfMs: number,
  truncated = false,
  settled?: GatewayMonthlyCost['settled']
): string {
  return JSON.stringify({
    costUsd: Number(costUsd.toFixed(6)),
    asOfMs,
    ...(truncated ? { truncated: true } : {}),
    // Kept unrounded: it is a running sum, and rounding it every hour would drift.
    ...(settled ? { settledUsd: settled.usd, settledBeforeMs: settled.beforeMs } : {}),
  });
}

/**
 * Parse a cron-written total. Accepts the `{costUsd, asOfMs}` form and the legacy plain number.
 * Anything else is unreadable (null), which the cap treats as "no gateway total yet".
 */
export function parseGatewayMonthlyCost(raw: string | null): GatewayMonthlyCost | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
    const record = maybeJsonRecord(parsed);
    if (!record) return null;
    const { costUsd, asOfMs, truncated, settledUsd, settledBeforeMs } = record;
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return null;
    if (typeof asOfMs !== 'number' || !Number.isFinite(asOfMs)) return null;
    const settled =
      typeof settledUsd === 'number' &&
      Number.isFinite(settledUsd) &&
      settledUsd >= 0 &&
      typeof settledBeforeMs === 'number' &&
      Number.isFinite(settledBeforeMs)
        ? { usd: settledUsd, beforeMs: settledBeforeMs }
        : undefined;
    return { costUsd, asOfMs, truncated: truncated === true, ...(settled ? { settled } : {}) };
  }
  const legacy = Number(trimmed);
  return trimmed !== '' && Number.isFinite(legacy) && legacy >= 0
    ? { costUsd: legacy, asOfMs: null, truncated: false }
    : null;
}

/**
 * Start of the estimate window that complements a gateway total: its `asOf` minus the lag margin,
 * clipped to the month start. Null when there is no gateway total (the whole month is estimated).
 * A legacy total (no `asOf`, written before this format) is assumed as old as its KV TTL allows,
 * which errs toward counting.
 */
export function estimateWindowStartMs(
  gateway: GatewayMonthlyCost | null,
  lagSeconds: number,
  now: Date,
  legacyMaxAgeSeconds: number
): number | null {
  if (!gateway) return null;
  const asOfMs = gateway.asOfMs ?? now.getTime() - legacyMaxAgeSeconds * 1000;
  return Math.max(utcMonthStartMs(now), asOfMs - lagSeconds * 1000);
}

/** Whether buckets still cover `windowStartMs`; older windows fall back to month figures. */
export function estimateWindowRetained(windowStartMs: number | null, now: Date): boolean {
  return (
    windowStartMs !== null &&
    windowStartMs >= now.getTime() - COST_ESTIMATE_RETENTION_MS + COST_ESTIMATE_BUCKET_MS
  );
}

/**
 * The spend the gateway-path cap compares: gateway total plus the estimate since it, or the month
 * estimate when there is no total. Two cases where the gateway total is known to be incomplete use
 * the month estimate as a floor instead of trusting the window:
 * - a total older than the bucket retention, which cannot be complemented exactly, and
 * - a truncated cron read, which is missing the month's oldest logs.
 * The floor is never added to the gateway total, so nothing is counted twice. Otherwise the floor
 * is deliberately not applied: the catalog overprices some models (measured up to 4x), and a
 * month-long estimate would then refuse users well below their cap.
 */
export function gatewayMonthlySpendUsd(
  gateway: GatewayMonthlyCost | null,
  snapshot: Pick<
    GatewayAdmissionSnapshot,
    'estimateMonthUsd' | 'estimateSinceUsd' | 'directMonthUsd'
  >,
  windowStartMs: number | null,
  now: Date
): number {
  // Calls that bypassed the gateway are in no gateway total, so they always add (no overlap).
  return gatewayRoutedSpendUsd(gateway, snapshot, windowStartMs, now) + snapshot.directMonthUsd;
}

function gatewayRoutedSpendUsd(
  gateway: GatewayMonthlyCost | null,
  snapshot: Pick<GatewayAdmissionSnapshot, 'estimateMonthUsd' | 'estimateSinceUsd'>,
  windowStartMs: number | null,
  now: Date
): number {
  if (!gateway || windowStartMs === null) return snapshot.estimateMonthUsd;
  if (!estimateWindowRetained(windowStartMs, now)) {
    return Math.max(gateway.costUsd, snapshot.estimateMonthUsd);
  }
  const windowed = gateway.costUsd + snapshot.estimateSinceUsd;
  return gateway.truncated ? Math.max(windowed, snapshot.estimateMonthUsd) : windowed;
}

/** Parse the lag-margin setting; out-of-range or unreadable values fall back to the default. */
export function resolveCostEstimateLagSeconds(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COST_ESTIMATE_GATEWAY_LAG_SECONDS
    ? value
    : DEFAULT_COST_ESTIMATE_GATEWAY_LAG_SECONDS;
}
