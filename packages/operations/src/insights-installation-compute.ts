/**
 * Compute spend for Admin Health & cost: machine lifetime × the machine's recorded hourly price,
 * summed per machine (`nodes.provider_instance_price_hourly_micros`). Workspaces share machines,
 * so spend is never summed per workspace: a machine is counted once however many workspaces ran
 * on it. `compute_usage` is per workspace and would count a shared machine once per tenant.
 *
 * A machine's end time is its `updated_at` once it reaches a billing-ended status, the same
 * convention metering and quotas use (`getNodeEndedAt`, apps/api `node-usage-calculation.ts`).
 * Cleanup marks machines `deleted` and keeps the row; only an explicit user delete removes it, so
 * spend is a slight lower bound.
 */
import {
  type InstallationComputeProviderSpend,
  type InstallationComputeSpend,
  type InstallationComputeWeek,
  NODE_BILLING_ENDED_STATUSES,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import type { OperationContext } from './types';

const HOUR_MS = 3_600_000;
const MICROS_PER_USD = 1_000_000;

const ENDED_STATUS_SQL = NODE_BILLING_ENDED_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * Managed cloud machines (SAM provisioned them on a provider) that ran during [since, until).
 * Binds `until` then `since`. User-owned (BYO) machines and Instant containers cost no provider
 * money and are excluded on both ownership axes, as metering does (`addNodeToTotals`).
 * Interpolated with the table alias `n`.
 */
export const MANAGED_NODE_RAN_IN_WINDOW_SQL = `n.runtime = 'vm'
  AND n.node_class = 'managed'
  AND COALESCE(n.credential_source, '') <> 'self-hosted'
  AND n.created_at < ?
  AND (n.status NOT IN (${ENDED_STATUS_SQL}) OR n.updated_at >= ?)`;

export interface HealthWindowBounds {
  /** Start of the selected range (ms). */
  rangeStartMs: number;
  /** Monday 00:00 UTC of the oldest chart week (ms). */
  weeksStartMs: number;
  /** Earliest of the two: everything the read needs (ms). */
  readStartMs: number;
  /** The time of the read (ms). */
  nowMs: number;
  weekStarts: number[];
}

interface NodeSpendRow {
  id: string;
  cloud_provider: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  price_micros: number | null;
  currency: string | null;
}

/** Parses a stored timestamp (ISO, or legacy `YYYY-MM-DD HH:MM:SS` UTC); null when unreadable. */
export function storedTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds of [start, end) inside [from, to). */
export function overlapMs(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

const roundUsd = (usd: number) => Math.round(usd * 100) / 100;
const roundHours = (hours: number) => Math.round(hours * 10) / 10;

export async function readComputeSpend(
  ctx: Pick<OperationContext, 'env'>,
  bounds: HealthWindowBounds,
  maxNodes: number
): Promise<InstallationComputeSpend> {
  const { results } = await ctx.env.DATABASE.prepare(
    `SELECT n.id, n.cloud_provider, n.status, n.created_at, n.updated_at,
            n.provider_instance_price_hourly_micros AS price_micros,
            n.provider_instance_price_currency AS currency
       FROM nodes n
      WHERE ${MANAGED_NODE_RAN_IN_WINDOW_SQL}
      -- Under the cap, keep the machines that cost the most in the window: still running first,
      -- then those that ended most recently (rule 65). The cap is disclosed as truncated.
      ORDER BY (n.status NOT IN (${ENDED_STATUS_SQL})) DESC, n.updated_at DESC, n.id DESC
      LIMIT ?`
  )
    .bind(
      new Date(bounds.nowMs).toISOString(),
      new Date(bounds.readStartMs).toISOString(),
      maxNodes + 1
    )
    .all<NodeSpendRow>();
  const rows = results ?? [];
  const truncated = rows.length > maxNodes;

  const providers = new Map<string, { usd: number; hours: number; nodes: number }>();
  const weekly = bounds.weekStarts.map(() => new Map<string, number>());
  let unpricedNodes = 0;
  let nodes = 0;
  const ended = new Set<string>(NODE_BILLING_ENDED_STATUSES);

  for (const row of rows.slice(0, maxNodes)) {
    const start = storedTimeMs(row.created_at);
    const end = ended.has(row.status) ? storedTimeMs(row.updated_at) : bounds.nowMs;
    if (start === null || end === null) {
      log.warn('insights_installation.node_row_skipped', {
        nodeId: row.id,
        reason: 'unreadable_timestamp',
        action: 'skipped',
      });
      continue;
    }
    const inRangeMs = overlapMs(start, end, bounds.rangeStartMs, bounds.nowMs);
    const inWeeksMs = overlapMs(start, end, bounds.weeksStartMs, bounds.nowMs);
    if (inRangeMs <= 0 && inWeeksMs <= 0) continue;
    if (inRangeMs > 0) nodes += 1;

    const price = row.price_micros;
    const usdPriced =
      typeof price === 'number' &&
      Number.isFinite(price) &&
      price >= 0 &&
      (row.currency === null || row.currency.toUpperCase() === 'USD');
    if (!usdPriced) {
      if (inRangeMs > 0) unpricedNodes += 1;
      continue;
    }
    const usdPerMs = price / MICROS_PER_USD / HOUR_MS;
    const provider = row.cloud_provider?.trim() || 'unknown';
    if (inRangeMs > 0) {
      const entry = providers.get(provider) ?? { usd: 0, hours: 0, nodes: 0 };
      entry.usd += inRangeMs * usdPerMs;
      entry.hours += inRangeMs / HOUR_MS;
      entry.nodes += 1;
      providers.set(provider, entry);
    }
    bounds.weekStarts.forEach((weekStart, index) => {
      const ms = overlapMs(
        start,
        end,
        weekStart,
        Math.min(weekStart + 7 * 24 * HOUR_MS, bounds.nowMs)
      );
      const bucket = weekly[index];
      if (ms <= 0 || !bucket) return;
      bucket.set(provider, (bucket.get(provider) ?? 0) + ms * usdPerMs);
    });
  }

  const byProvider: InstallationComputeProviderSpend[] = [...providers.entries()]
    .map(([provider, entry]) => ({
      provider,
      usd: roundUsd(entry.usd),
      nodeHours: roundHours(entry.hours),
      nodes: entry.nodes,
    }))
    .sort((a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider));
  const weeks: InstallationComputeWeek[] = bounds.weekStarts.map((weekStart, index) => {
    const bucket = weekly[index] ?? new Map<string, number>();
    const entries = [...bucket.entries()]
      .map(([provider, usd]) => ({ provider, usd: roundUsd(usd) }))
      .sort((a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider));
    return {
      weekStart: new Date(weekStart).toISOString(),
      totalUsd: roundUsd([...bucket.values()].reduce((sum, usd) => sum + usd, 0)),
      byProvider: entries,
    };
  });

  return {
    currency: 'USD',
    totalUsd: roundUsd([...providers.values()].reduce((sum, entry) => sum + entry.usd, 0)),
    byProvider,
    weeks,
    unpricedNodes,
    nodes,
    truncated,
  };
}
