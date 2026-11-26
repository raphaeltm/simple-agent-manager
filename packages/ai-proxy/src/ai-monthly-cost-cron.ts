/**
 * Hourly cron job: aggregate per-user monthly AI cost from Gateway logs → KV cache.
 *
 * The proxy reads the cached value at request time via `checkMonthlyCostCap()`.
 * This avoids expensive per-request Gateway iteration while giving ~1h staleness.
 */
import {
  AI_MONTHLY_COST_CACHE_KV_PREFIX,
  DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import {
  type GatewayMonthlyCost,
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS,
  parseGatewayMonthlyCost,
  readCostEstimateLagSeconds,
  serializeGatewayMonthlyCost,
  utcMonthKey,
  utcMonthStartMs,
} from './ai-cost-estimate';
import { resolveAiGatewayId } from './ai-gateway-availability';
import {
  type GatewayLogsPorts,
  getGatewayPeriodBounds,
  iterateGatewayLogs,
} from './ai-gateway-logs';
import type { AiProxyEnv } from './env';
import type { AiProxyPorts } from './ports';

const DEFAULT_MONTHLY_COST_AGGREGATION_MAX_PAGES = 200;
const MONTHLY_COST_AGGREGATION_MAX_PAGES_HARD_CAP = 500;
const MIN_MONTHLY_COST_CACHE_TTL_SECONDS = 60;

export { MAX_MONTHLY_COST_CACHE_TTL_SECONDS };

export interface MonthlyCostCronResult {
  enabled: boolean;
  usersUpdated: number;
  totalEntries: number;
  errors: number;
}

export function resolveMonthlyCostCacheTtlSeconds(raw: string | undefined): number {
  const fallback = DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_MONTHLY_COST_CACHE_TTL_SECONDS) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_MONTHLY_COST_CACHE_TTL_SECONDS);
}

/** The cron's ports: the log-read timeout, and the lag margin that decides which logs are settled. */
export type MonthlyCostCronPorts = GatewayLogsPorts &
  Partial<Pick<AiProxyPorts, 'costEstimateGatewayLagSeconds'>>;

/** One user's logs from a read: each log's creation time (NaN when unparseable) and cost. */
type UserLogs = Array<{ createdMs: number; costUsd: number }>;

/**
 * Aggregate current-month AI Gateway costs per user and write to KV.
 *
 * KV key: `ai-monthly-cost:{userId}:{YYYY-MM}` → `{costUsd, asOfMs, settledUsd, settledBeforeMs}`
 * JSON (`asOfMs` is when the log read started; `parseGatewayMonthlyCost` also reads the older
 * plain-number form). TTL: `AI_MONTHLY_COST_CACHE_TTL_SECONDS`.
 *
 * The read is newest first and capped at `AI_MONTHLY_COST_AGGREGATION_MAX_PAGES` pages. Past the
 * cap the read is a window of the newest logs, which moves forward between runs, so totals from
 * two windows overlap and cannot be combined with `max` (new spend that displaced old logs from
 * the window would vanish). Each total therefore records its settled part: spend on logs created
 * before `settledBeforeMs` (`asOf` minus the lag margin). A truncated read whose window reaches
 * back past the previous settled boundary adds only logs from that boundary on, which is exact.
 * See `nextUserTotal` for the cases where it is not.
 */
export async function runMonthlyCostAggregation(
  env: AiProxyEnv,
  ports: MonthlyCostCronPorts
): Promise<MonthlyCostCronResult> {
  const gatewayId = resolveAiGatewayId(env);
  if (!gatewayId) {
    return { enabled: false, usersUpdated: 0, totalEntries: 0, errors: 0 };
  }

  const now = new Date();
  // The gateway total covers calls up to roughly this instant; the cap adds the local estimate
  // only for calls after it (minus the lag margin), see ai-cost-estimate.ts.
  const asOfMs = now.getTime();
  const monthKey = utcMonthKey(now);
  const { startDate } = getGatewayPeriodBounds('current-month');
  const ttl = resolveMonthlyCostCacheTtlSeconds(env.AI_MONTHLY_COST_CACHE_TTL_SECONDS);
  // Logs created before this are treated as written; later ones may still be arriving.
  const settledBeforeMs = Math.max(
    utcMonthStartMs(now),
    asOfMs - (await readCostEstimateLagSeconds(ports)) * 1000
  );

  const logsByUser = new Map<string, UserLogs>();
  let totalEntries = 0;
  let truncated = false;
  // Creation time of the oldest log the read reached (all users), for a truncated read.
  let oldestReadMs = Number.POSITIVE_INFINITY;

  try {
    ({ truncated } = await iterateGatewayLogs(
      env,
      ports,
      gatewayId,
      startDate,
      (entry) => {
        totalEntries++;
        const createdMs = Date.parse(entry.created_at);
        if (createdMs < oldestReadMs) oldestReadMs = createdMs;
        const userId = entry.metadata?.userId;
        if (!userId) return;
        const logs = logsByUser.get(userId) ?? [];
        logs.push({ createdMs, costUsd: entry.cost || 0 });
        logsByUser.set(userId, logs);
      },
      {
        defaultMaxPages: DEFAULT_MONTHLY_COST_AGGREGATION_MAX_PAGES,
        maxPagesHardCap: MONTHLY_COST_AGGREGATION_MAX_PAGES_HARD_CAP,
        maxPagesEnvValue: env.AI_MONTHLY_COST_AGGREGATION_MAX_PAGES,
      }
    ));
  } catch (err) {
    log.error('cron.monthly_cost.gateway_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { enabled: true, usersUpdated: 0, totalEntries, errors: 1 };
  }

  // A truncated read needs each user's previous total, including users with no log in this read
  // (all their spend is in older logs). A complete read stands on its own.
  const previousByUser = truncated
    ? await readPreviousTotals(env.KV, monthKey)
    : new Map<string, GatewayMonthlyCost>();
  const read: ReadWindow = { truncated, oldestReadMs, settledBeforeMs };
  const counts = { exact: 0, gap: 0, noBase: 0 };

  let usersUpdated = 0;
  let errors = 0;
  for (const userId of new Set([...logsByUser.keys(), ...previousByUser.keys()])) {
    const next = nextUserTotal(logsByUser.get(userId) ?? [], previousByUser.get(userId), read);
    counts[next.kind]++;
    const key = `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:${userId}:${monthKey}`;
    try {
      await env.KV.put(
        key,
        serializeGatewayMonthlyCost(next.costUsd, asOfMs, next.lowerBound, next.settled),
        { expirationTtl: ttl }
      );
      usersUpdated++;
    } catch (err) {
      errors++;
      log.error('cron.monthly_cost.kv_write_error', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (truncated) {
    // `gap` or `noBase` totals are lower bounds (the cap then floors on the local estimate). Raise
    // AI_MONTHLY_COST_AGGREGATION_MAX_PAGES (hard cap 500) so the read covers at least an hour.
    log.warn('cron.monthly_cost.truncated_read', {
      monthKey,
      oldestReadAt: Number.isFinite(oldestReadMs) ? new Date(oldestReadMs).toISOString() : null,
      exactTotals: counts.exact,
      gapTotals: counts.gap,
      noBaseTotals: counts.noBase,
    });
  }

  log.info('cron.monthly_cost.completed', {
    monthKey,
    usersUpdated,
    totalEntries,
    errors,
  });

  return { enabled: true, usersUpdated, totalEntries, errors };
}

interface ReadWindow {
  truncated: boolean;
  oldestReadMs: number;
  settledBeforeMs: number;
}

interface NextUserTotal {
  kind: 'exact' | 'gap' | 'noBase';
  costUsd: number;
  /** Known to be below the month's real spend (`GatewayMonthlyCost.truncated`). */
  lowerBound: boolean;
  settled?: { usd: number; beforeMs: number };
}

/**
 * One user's new total. `base` is the spend already settled and `baseBeforeMs` its boundary; this
 * read contributes its logs from `baseBeforeMs` on.
 * - Complete read: base 0 from the month start, exact.
 * - Truncated read reaching strictly before the previous settled boundary: previous settled plus
 *   this read's logs from that boundary, exact (it inherits the previous total's lower-bound flag).
 *   Strictly: logs sharing the oldest timestamp may continue on the page the cap cut off.
 * - Truncated read that does not reach back that far (`gap`): the logs between are unseen, so the
 *   sum is a lower bound. It still chains, so later runs keep adding new spend.
 * - Truncated read with no previous settled part (`noBase`: legacy value, or the first total of a
 *   month that was already past the cap): `max(previous, read)`, a lower bound with no settled part.
 *   The next month's first run is small, so it reads completely and starts the chain.
 * A log with an unparseable time counts in this run's total but never in the settled part, so it
 * is not counted twice.
 */
function nextUserTotal(
  logs: UserLogs,
  previous: GatewayMonthlyCost | undefined,
  read: ReadWindow
): NextUserTotal {
  // `NaN >= x` is false, so the NaN check keeps an unparseable time in the total.
  const total = (fromMs: number) =>
    logs.reduce(
      (sum, log) =>
        Number.isNaN(log.createdMs) || log.createdMs >= fromMs ? sum + log.costUsd : sum,
      0
    );
  const settledPart = (fromMs: number, beforeMs: number) =>
    logs.reduce(
      (sum, log) => (log.createdMs >= fromMs && log.createdMs < beforeMs ? sum + log.costUsd : sum),
      0
    );

  if (!read.truncated) {
    const beforeMs = read.settledBeforeMs;
    return {
      kind: 'exact',
      costUsd: total(Number.NEGATIVE_INFINITY),
      lowerBound: false,
      settled: { usd: settledPart(Number.NEGATIVE_INFINITY, beforeMs), beforeMs },
    };
  }
  const base = previous?.settled;
  if (!base) {
    return {
      kind: 'noBase',
      costUsd: Math.max(previous?.costUsd ?? 0, total(Number.NEGATIVE_INFINITY)),
      lowerBound: true,
    };
  }
  const kind = read.oldestReadMs < base.beforeMs ? 'exact' : 'gap';
  // A boundary never moves back: logs already settled would be counted again by the next run.
  const beforeMs = Math.max(base.beforeMs, read.settledBeforeMs);
  return {
    kind,
    costUsd: base.usd + total(base.beforeMs),
    lowerBound: previous.truncated || kind === 'gap',
    settled: { usd: base.usd + settledPart(base.beforeMs, beforeMs), beforeMs },
  };
}

/**
 * This month's stored totals, for a truncated read. One KV list walk over this month's keys (one
 * per user with gateway spend), only on truncated runs. A failure is logged and returns what was
 * read so far: users it missed are then written from this read alone.
 */
async function readPreviousTotals(
  kv: KVNamespace,
  monthKey: string
): Promise<Map<string, GatewayMonthlyCost>> {
  const prefix = `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:`;
  const suffix = `:${monthKey}`;
  const previous = new Map<string, GatewayMonthlyCost>();
  try {
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const { name } of page.keys) {
        if (!name.endsWith(suffix)) continue;
        const userId = name.slice(prefix.length, -suffix.length);
        const total = parseGatewayMonthlyCost(await kv.get(name));
        if (userId && total) previous.set(userId, total);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    log.error('cron.monthly_cost.previous_totals_unreadable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return previous;
}
