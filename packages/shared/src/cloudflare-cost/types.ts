/**
 * Cloudflare cost estimation types (`.claude/rules/76-cost-decisions-must-query-billed-metrics.md`).
 * Shared by `pnpm quality:cloudflare-cost` (scripts/quality/check-cloudflare-cost.ts) and the
 * daily snapshot the API Worker stores for Admin › Health & cost (Insights slice CF), so both
 * report the same numbers from the same billed analytics fields.
 */

export const DO_BILLING_MEMORY_GB = 0.128;
export const MICROSECONDS_PER_SECOND = 1_000_000;
export const MICROSECONDS_PER_MILLISECOND = 1_000;
export const BYTES_PER_GIB = 1024 ** 3;
export const BYTES_PER_GB = 1000 ** 3;
export const DEFAULT_CLOUDFLARE_COST_RECENT_DAYS = 7;

/** One billed usage dimension. Each key is one "product line" of the stored daily snapshot. */
export const CLOUDFLARE_COST_METRIC_KEYS = [
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
] as const;

export type CloudflareCostMetricKey = (typeof CLOUDFLARE_COST_METRIC_KEYS)[number];

export function isCloudflareCostMetricKey(value: unknown): value is CloudflareCostMetricKey {
  return (CLOUDFLARE_COST_METRIC_KEYS as readonly unknown[]).includes(value);
}

/**
 * How the monthly allowance applies:
 * - `cumulative`: usage adds up over the month against one monthly allowance.
 * - `dailyAllowance`: the allowance resets every day at 00:00 UTC (Workers AI).
 * - `snapshot`: a stored amount billed per month (GB-month); the day's value is a level.
 */
export type CloudflareCostMetricKind = 'cumulative' | 'dailyAllowance' | 'snapshot';
export type CloudflareCostMetricValues = Record<CloudflareCostMetricKey, number>;

export type CloudflareCostProduct =
  'Workers' | 'Durable Objects' | 'D1' | 'KV' | 'R2' | 'Workers AI' | 'Containers';

export interface CloudflareCostMetricPricing {
  key: CloudflareCostMetricKey;
  product: CloudflareCostProduct;
  label: string;
  unit: string;
  kind: CloudflareCostMetricKind;
  allowance: number;
  rateUsd: number;
  rateUnit: number;
  note?: string;
}

export interface CloudflareCostPricing {
  metrics: Record<CloudflareCostMetricKey, CloudflareCostMetricPricing>;
}

export interface DurableObjectPeriodicRow {
  dimensions: { date?: string | null; namespaceId?: string | null; name?: string | null };
  sum?: {
    activeTime?: number | null;
    duration?: number | null;
    rowsRead?: number | null;
    rowsWritten?: number | null;
    storageReadUnits?: number | null;
    storageWriteUnits?: number | null;
  } | null;
}

export interface DurableObjectInvocationRow {
  dimensions: { date?: string | null };
  sum?: { requests?: number | null } | null;
}

export interface WorkersInvocationRow {
  dimensions: { date?: string | null; eventType?: string | null };
  sum?: { requests?: number | null; cpuTimeUs?: number | null } | null;
}

export interface KvOperationRow {
  dimensions: { date?: string | null; actionType?: string | null };
  sum?: { requests?: number | null } | null;
}

export interface KvStorageRow {
  dimensions: { date?: string | null; namespaceId?: string | null };
  max?: { byteCount?: number | null } | null;
}

export interface WorkersAiRow {
  dimensions: { date?: string | null };
  sum?: { totalNeurons?: number | null } | null;
}

export interface R2StorageRow {
  dimensions: { date?: string | null; bucketName?: string | null; storageClass?: string | null };
  max?: { metadataSize?: number | null; payloadSize?: number | null } | null;
}

export interface D1AnalyticsRow {
  dimensions: { date?: string | null };
  sum?: { rowsRead?: number | null; rowsWritten?: number | null } | null;
}

export interface D1StorageRow {
  dimensions: { date?: string | null; databaseId?: string | null };
  max?: { databaseSizeBytes?: number | null } | null;
}

export interface ContainerUsageRow {
  dimensions: { date?: string | null };
  sum?: { allocatedMemory?: number | null } | null;
}

export interface CloudflareCostRows {
  durableObjectPeriodic: DurableObjectPeriodicRow[];
  durableObjectInvocations: DurableObjectInvocationRow[];
  workersInvocations: WorkersInvocationRow[];
  kvOperations: KvOperationRow[];
  kvStorage: KvStorageRow[];
  workersAi: WorkersAiRow[];
  r2Storage: R2StorageRow[];
  d1Analytics: D1AnalyticsRow[];
  d1Storage: D1StorageRow[];
  containers: ContainerUsageRow[];
}

export interface CloudflareDailyUsage {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  metrics: CloudflareCostMetricValues;
}

export interface CloudflareCostProjectionOptions {
  /** First day of the series; projections assume it is the first day of its month. */
  startDate: string;
  endDate: string;
  recentDays?: number;
}

export interface CloudflareMetricProjection {
  key: CloudflareCostMetricKey;
  label: string;
  unit: string;
  kind: CloudflareCostMetricKind;
  monthToDateUsage: number;
  projectedUsage: number;
  allowance: number;
  headroom: number;
  projectedCostUsd: number;
  recentDailyAverage: number;
  monthToDateDailyAverage: number;
  trend: 'early-spike' | 'climbing' | 'steady';
  note?: string;
}

export interface DurableObjectNamespaceBreakdown {
  namespaceId: string;
  sampleObjectName: string;
  durationGbSeconds: number;
  rowsRead: number;
  rowsWritten: number;
}

export interface CloudflareCostAnalysis {
  daily: CloudflareDailyUsage[];
  projections: CloudflareMetricProjection[];
  totalProjectedUsd: number;
  durableObjectNamespaces: DurableObjectNamespaceBreakdown[];
  durationIdentityViolations: string[];
}
