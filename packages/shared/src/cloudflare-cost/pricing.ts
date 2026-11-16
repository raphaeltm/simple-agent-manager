/**
 * Cloudflare Workers Paid list prices and included allowances, per billed metric
 * (https://developers.cloudflare.com/workers/platform/pricing/, D1, KV, R2, Durable Objects,
 * Workers AI and Containers pricing pages; checked 2026-11-16). These are reference data, not
 * tunables: the CLI accepts per-metric overrides (`CF_COST_<METRIC>_*`), the stored snapshot uses
 * these values and is labelled an estimate. The $5/month Workers Paid subscription is not usage
 * and is not included.
 */
import type {
  CloudflareCostMetricKey,
  CloudflareCostMetricPricing,
  CloudflareCostPricing,
} from './types';

type PricingRow = Omit<CloudflareCostMetricPricing, 'key'>;

const MILLION = 1_000_000;

const DEFAULT_PRICING: Record<CloudflareCostMetricKey, PricingRow> = {
  workersRequests: {
    product: 'Workers',
    label: 'Workers requests',
    unit: 'requests',
    kind: 'cumulative',
    allowance: 10 * MILLION,
    rateUsd: 0.3,
    rateUnit: MILLION,
    note: 'Fetch, cron and other invocations; tail-worker invocations are not request billing.',
  },
  workersCpuMs: {
    product: 'Workers',
    label: 'Workers CPU time',
    unit: 'CPU ms',
    kind: 'cumulative',
    allowance: 30 * MILLION,
    rateUsd: 0.02,
    rateUnit: MILLION,
  },
  doRequests: {
    product: 'Durable Objects',
    label: 'Durable Objects requests',
    unit: 'requests',
    kind: 'cumulative',
    allowance: MILLION,
    rateUsd: 0.15,
    rateUnit: MILLION,
    note: 'Counts DO invocations only; tail-worker invocations are not request billing.',
  },
  doDurationGbSeconds: {
    product: 'Durable Objects',
    label: 'Durable Objects duration',
    unit: 'GB-s',
    kind: 'cumulative',
    allowance: 400_000,
    rateUsd: 12.5,
    rateUnit: MILLION,
    note: 'Uses durableObjectsPeriodicGroups.sum.duration, not invocation wallTime.',
  },
  doRowsRead: {
    product: 'Durable Objects',
    label: 'Durable Objects SQLite rows read',
    unit: 'rows',
    kind: 'cumulative',
    allowance: 25_000 * MILLION,
    rateUsd: 0.001,
    rateUnit: MILLION,
  },
  doRowsWritten: {
    product: 'Durable Objects',
    label: 'Durable Objects SQLite rows written',
    unit: 'rows',
    kind: 'cumulative',
    allowance: 50 * MILLION,
    rateUsd: 1,
    rateUnit: MILLION,
  },
  doStorageReadUnits: {
    product: 'Durable Objects',
    label: 'Durable Objects KV read units',
    unit: '4 KB units',
    kind: 'cumulative',
    allowance: MILLION,
    rateUsd: 0.2,
    rateUnit: MILLION,
  },
  doStorageWriteUnits: {
    product: 'Durable Objects',
    label: 'Durable Objects KV write units',
    unit: '4 KB units',
    kind: 'cumulative',
    allowance: MILLION,
    rateUsd: 1,
    rateUnit: MILLION,
  },
  d1RowsRead: {
    product: 'D1',
    label: 'D1 rows read',
    unit: 'rows',
    kind: 'cumulative',
    allowance: 25_000 * MILLION,
    rateUsd: 0.001,
    rateUnit: MILLION,
  },
  d1RowsWritten: {
    product: 'D1',
    label: 'D1 rows written',
    unit: 'rows',
    kind: 'cumulative',
    allowance: 50 * MILLION,
    rateUsd: 1,
    rateUnit: MILLION,
  },
  d1StorageGb: {
    product: 'D1',
    label: 'D1 storage',
    unit: 'GB',
    kind: 'snapshot',
    allowance: 5,
    rateUsd: 0.75,
    rateUnit: 1,
  },
  kvReads: {
    product: 'KV',
    label: 'KV reads',
    unit: 'reads',
    kind: 'cumulative',
    allowance: 10 * MILLION,
    rateUsd: 0.5,
    rateUnit: MILLION,
  },
  kvWrites: {
    product: 'KV',
    label: 'KV writes',
    unit: 'writes',
    kind: 'cumulative',
    allowance: MILLION,
    rateUsd: 5,
    rateUnit: MILLION,
  },
  kvDeletes: {
    product: 'KV',
    label: 'KV deletes',
    unit: 'deletes',
    kind: 'cumulative',
    allowance: MILLION,
    rateUsd: 5,
    rateUnit: MILLION,
  },
  kvLists: {
    product: 'KV',
    label: 'KV lists',
    unit: 'lists',
    kind: 'cumulative',
    allowance: MILLION,
    rateUsd: 5,
    rateUnit: MILLION,
  },
  kvStorageGb: {
    product: 'KV',
    label: 'KV storage',
    unit: 'GB',
    kind: 'snapshot',
    allowance: 1,
    rateUsd: 0.5,
    rateUnit: 1,
  },
  r2StorageGb: {
    product: 'R2',
    label: 'R2 storage',
    unit: 'GB',
    kind: 'snapshot',
    allowance: 10,
    rateUsd: 0.015,
    rateUnit: 1,
    note: 'Standard storage only; R2 operations are not priced.',
  },
  workersAiNeurons: {
    product: 'Workers AI',
    label: 'Workers AI neurons',
    unit: 'neurons',
    kind: 'dailyAllowance',
    allowance: 10_000,
    rateUsd: 0.011,
    rateUnit: 1_000,
    note: 'Allowance applies daily at 00:00 UTC.',
  },
  containerMemoryGibSeconds: {
    product: 'Containers',
    label: 'Containers memory',
    unit: 'GiB-s',
    kind: 'cumulative',
    allowance: 25 * 60 * 60,
    rateUsd: 0.0000025,
    rateUnit: 1,
    note: 'Memory only; container vCPU and disk are not priced.',
  },
};

export function createCloudflarePricing(
  allowanceOverrides: Partial<Record<CloudflareCostMetricKey, number>> = {}
): CloudflareCostPricing {
  const metrics = Object.fromEntries(
    (Object.keys(DEFAULT_PRICING) as CloudflareCostMetricKey[]).map((key) => [
      key,
      {
        key,
        ...DEFAULT_PRICING[key],
        allowance: allowanceOverrides[key] ?? DEFAULT_PRICING[key].allowance,
      },
    ])
  ) as Record<CloudflareCostMetricKey, CloudflareCostMetricPricing>;
  return { metrics };
}

/** Cost of `usage` against one monthly allowance. */
export function calculateCloudflareMetricCost(
  usage: number,
  pricing: CloudflareCostMetricPricing
): number {
  return (Math.max(usage - pricing.allowance, 0) / pricing.rateUnit) * pricing.rateUsd;
}

export function cloudflareDaysInMonth(date: string): number {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Estimated cost of each day of one calendar month, given that month's daily values from day 1
 * (index 0 = the 1st). The days sum to the month's cost so far:
 * - cumulative: each day pays the increase in the month-to-date cost, so the monthly allowance is
 *   used up by the earliest days and later days pay the full rate;
 * - daily allowance: each day is priced on its own;
 * - snapshot (storage): each day pays 1/daysInMonth of a month at that day's level.
 */
export function dailyCloudflareMetricCosts(
  values: number[],
  pricing: CloudflareCostMetricPricing,
  daysInMonth: number
): number[] {
  if (pricing.kind === 'dailyAllowance') {
    return values.map((value) => calculateCloudflareMetricCost(value, pricing));
  }
  if (pricing.kind === 'snapshot') {
    return values.map(
      (value) => calculateCloudflareMetricCost(value, pricing) / Math.max(daysInMonth, 1)
    );
  }
  let cumulative = 0;
  let previousCost = 0;
  return values.map((value) => {
    cumulative += value;
    const cost = calculateCloudflareMetricCost(cumulative, pricing);
    const day = cost - previousCost;
    previousCost = cost;
    return day;
  });
}
