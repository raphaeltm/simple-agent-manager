/**
 * Daily usage series and month projections from Cloudflare GraphQL analytics rows
 * (`.claude/rules/76-cost-decisions-must-query-billed-metrics.md`):
 * - Durable Object duration comes from `durableObjectsPeriodicGroups.sum.duration` (billed
 *   GB-s), never from invocation `wallTime`.
 * - Tail-worker invocations (`eventType = tail`) are not counted as Workers requests; their CPU
 *   time is.
 * - A month projects from what is already spent plus the recent daily rate, not from the running
 *   month-to-date average.
 */
import { calculateCloudflareMetricCost, cloudflareDaysInMonth } from './pricing';
import {
  BYTES_PER_GB,
  BYTES_PER_GIB,
  CLOUDFLARE_COST_METRIC_KEYS,
  type CloudflareCostAnalysis,
  type CloudflareCostMetricKey,
  type CloudflareCostMetricKind,
  type CloudflareCostMetricPricing,
  type CloudflareCostMetricValues,
  type CloudflareCostPricing,
  type CloudflareCostProjectionOptions,
  type CloudflareCostRows,
  type CloudflareDailyUsage,
  type CloudflareMetricProjection,
  DEFAULT_CLOUDFLARE_COST_RECENT_DAYS,
  DO_BILLING_MEMORY_GB,
  type DurableObjectNamespaceBreakdown,
  type DurableObjectPeriodicRow,
  MICROSECONDS_PER_MILLISECOND,
  MICROSECONDS_PER_SECOND,
} from './types';

const DAY_MS = 86_400_000;

/** `kvOperationsAdaptiveGroups.dimensions.actionType` → metric. Other actions are not billed. */
const KV_ACTIONS: Record<string, CloudflareCostMetricKey> = {
  read: 'kvReads',
  write: 'kvWrites',
  delete: 'kvDeletes',
  list: 'kvLists',
};

/** `workersInvocationsAdaptive.dimensions.eventType` of a tail-worker invocation. */
export const TAIL_EVENT_TYPE = 'tail';

export function emptyCloudflareMetricValues(): CloudflareCostMetricValues {
  return Object.fromEntries(
    CLOUDFLARE_COST_METRIC_KEYS.map((key) => [key, 0])
  ) as CloudflareCostMetricValues;
}

export function analyzeCloudflareCost(
  rows: CloudflareCostRows,
  pricing: CloudflareCostPricing,
  options: CloudflareCostProjectionOptions
): CloudflareCostAnalysis {
  const daily = cloudflareDailyUsage(rows, options.startDate, options.endDate);
  const namespaceBreakdown = new Map<string, DurableObjectNamespaceBreakdown>();
  const durationIdentityViolations: string[] = [];
  for (const row of rows.durableObjectPeriodic) {
    collectNamespaceBreakdown(namespaceBreakdown, row);
    const violation = validateDurationIdentity(row);
    if (violation) durationIdentityViolations.push(violation);
  }
  const projections = CLOUDFLARE_COST_METRIC_KEYS.map((key) =>
    projectCloudflareMetric(
      daily.map((entry) => entry.metrics[key]),
      daily[0]?.date ?? options.startDate,
      pricing.metrics[key],
      options.recentDays ?? DEFAULT_CLOUDFLARE_COST_RECENT_DAYS
    )
  );
  return {
    daily,
    projections,
    totalProjectedUsd: projections.reduce((total, p) => total + p.projectedCostUsd, 0),
    durableObjectNamespaces: Array.from(namespaceBreakdown.values()).sort(
      (left, right) => right.durationGbSeconds - left.durationGbSeconds
    ),
    durationIdentityViolations,
  };
}

/** One entry per UTC day from `startDate` through `endDate`, with every metric summed. */
export function cloudflareDailyUsage(
  rows: CloudflareCostRows,
  startDate: string,
  endDate: string
): CloudflareDailyUsage[] {
  const daily = createDailyUsage(startDate, endDate);
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const add = (
    rawDate: string | null | undefined,
    key: CloudflareCostMetricKey,
    value: unknown
  ) => {
    const entry = byDate.get(normalizeDate(rawDate) ?? '');
    if (entry) entry.metrics[key] += numberValue(value);
  };

  for (const row of rows.durableObjectPeriodic) {
    const date = row.dimensions.date;
    add(date, 'doDurationGbSeconds', row.sum?.duration);
    add(date, 'doRowsRead', row.sum?.rowsRead);
    add(date, 'doRowsWritten', row.sum?.rowsWritten);
    add(date, 'doStorageReadUnits', row.sum?.storageReadUnits);
    add(date, 'doStorageWriteUnits', row.sum?.storageWriteUnits);
  }
  for (const row of rows.durableObjectInvocations)
    add(row.dimensions.date, 'doRequests', row.sum?.requests);
  for (const row of rows.workersInvocations) {
    if (row.dimensions.eventType !== TAIL_EVENT_TYPE)
      add(row.dimensions.date, 'workersRequests', row.sum?.requests);
    add(
      row.dimensions.date,
      'workersCpuMs',
      numberValue(row.sum?.cpuTimeUs) / MICROSECONDS_PER_MILLISECOND
    );
  }
  for (const row of rows.kvOperations) {
    const key = KV_ACTIONS[row.dimensions.actionType ?? ''];
    if (key) add(row.dimensions.date, key, row.sum?.requests);
  }
  for (const row of rows.workersAi)
    add(row.dimensions.date, 'workersAiNeurons', row.sum?.totalNeurons);
  for (const row of rows.d1Analytics) {
    add(row.dimensions.date, 'd1RowsRead', row.sum?.rowsRead);
    add(row.dimensions.date, 'd1RowsWritten', row.sum?.rowsWritten);
  }
  for (const row of rows.containers)
    add(
      row.dimensions.date,
      'containerMemoryGibSeconds',
      numberValue(row.sum?.allocatedMemory) / BYTES_PER_GIB
    );
  applyDailySnapshot(
    rows.r2Storage,
    byDate,
    'r2StorageGb',
    (row) => (numberValue(row.max?.payloadSize) + numberValue(row.max?.metadataSize)) / BYTES_PER_GB
  );
  applyDailySnapshot(
    rows.d1Storage,
    byDate,
    'd1StorageGb',
    (row) => numberValue(row.max?.databaseSizeBytes) / BYTES_PER_GB
  );
  applyDailySnapshot(
    rows.kvStorage,
    byDate,
    'kvStorageGb',
    (row) => numberValue(row.max?.byteCount) / BYTES_PER_GB
  );
  return daily;
}

/**
 * Month projection for one metric. `values` are the month's days in order from the 1st through
 * the last complete day; `monthDate` is any day of that month.
 */
export function projectCloudflareMetric(
  values: number[],
  monthDate: string,
  pricing: CloudflareCostMetricPricing,
  recentDays: number
): CloudflareMetricProjection {
  const elapsedDays = Math.max(values.length, 1);
  const daysInMonth = cloudflareDaysInMonth(monthDate);
  const remainingDays = Math.max(daysInMonth - elapsedDays, 0);
  const recentDailyAverage = average(values.slice(-Math.min(recentDays, values.length)));
  const snapshot = pricing.kind === 'snapshot';
  const monthToDateUsage = snapshot ? last(values) : sum(values);
  const projectedUsage = snapshot
    ? last(values)
    : monthToDateUsage + recentDailyAverage * remainingDays;
  const monthToDateDailyAverage = snapshot ? last(values) : monthToDateUsage / elapsedDays;
  const allowance =
    pricing.kind === 'dailyAllowance' ? pricing.allowance * daysInMonth : pricing.allowance;
  return {
    key: pricing.key,
    label: pricing.label,
    unit: pricing.unit,
    kind: pricing.kind,
    monthToDateUsage,
    projectedUsage,
    allowance,
    headroom: allowance - projectedUsage,
    projectedCostUsd: projectedCost(
      values,
      projectedUsage,
      pricing,
      remainingDays,
      recentDailyAverage
    ),
    recentDailyAverage,
    monthToDateDailyAverage,
    trend: detectTrend(values, recentDailyAverage, monthToDateDailyAverage, pricing.kind),
    note: pricing.note,
  };
}

export function validateDurationIdentity(row: DurableObjectPeriodicRow): string | null {
  const activeTime = numberValue(row.sum?.activeTime);
  const duration = numberValue(row.sum?.duration);
  if (activeTime === 0 && duration === 0) return null;
  const expected = (activeTime / MICROSECONDS_PER_SECOND) * DO_BILLING_MEMORY_GB;
  const tolerance = Math.max(0.000001, Math.abs(duration) * 0.000001);
  if (Math.abs(duration - expected) <= tolerance) return null;
  return `${row.dimensions.date ?? 'unknown-date'} ${row.dimensions.namespaceId ?? 'unknown-namespace'}: duration ${duration} GB-s does not equal activeTime/1e6*0.128 (${expected})`;
}

function projectedCost(
  values: number[],
  projectedUsage: number,
  pricing: CloudflareCostMetricPricing,
  remainingDays: number,
  recentDailyAverage: number
): number {
  if (pricing.kind !== 'dailyAllowance')
    return calculateCloudflareMetricCost(projectedUsage, pricing);
  const spentBillable = values.reduce(
    (total, value) => total + Math.max(value - pricing.allowance, 0),
    0
  );
  const projectedBillable =
    spentBillable + Math.max(recentDailyAverage - pricing.allowance, 0) * remainingDays;
  return (projectedBillable / pricing.rateUnit) * pricing.rateUsd;
}

function detectTrend(
  values: number[],
  recentDailyAverage: number,
  monthToDateDailyAverage: number,
  kind: CloudflareCostMetricKind
): CloudflareMetricProjection['trend'] {
  if (kind === 'snapshot' || values.length < 4) return 'steady';
  const firstFourShare = sum(values.slice(0, 4)) / Math.max(sum(values), 1);
  if (firstFourShare >= 0.7 && recentDailyAverage < monthToDateDailyAverage * 0.6)
    return 'early-spike';
  const previousAverage = average(
    values.slice(0, -Math.min(DEFAULT_CLOUDFLARE_COST_RECENT_DAYS, values.length))
  );
  if (previousAverage > 0 && recentDailyAverage > previousAverage * 1.5) return 'climbing';
  return 'steady';
}

function collectNamespaceBreakdown(
  map: Map<string, DurableObjectNamespaceBreakdown>,
  row: DurableObjectPeriodicRow
): void {
  const namespaceId = row.dimensions.namespaceId ?? 'unknown-namespace';
  const existing = map.get(namespaceId) ?? {
    namespaceId,
    sampleObjectName: row.dimensions.name ?? 'unknown-object',
    durationGbSeconds: 0,
    rowsRead: 0,
    rowsWritten: 0,
  };
  existing.durationGbSeconds += numberValue(row.sum?.duration);
  existing.rowsRead += numberValue(row.sum?.rowsRead);
  existing.rowsWritten += numberValue(row.sum?.rowsWritten);
  map.set(namespaceId, existing);
}

function createDailyUsage(startDate: string, endDate: string): CloudflareDailyUsage[] {
  const dates: CloudflareDailyUsage[] = [];
  const end = parseDate(endDate).getTime();
  for (let cursor = parseDate(startDate).getTime(); cursor <= end; cursor += DAY_MS) {
    dates.push({
      date: new Date(cursor).toISOString().slice(0, 10),
      metrics: emptyCloudflareMetricValues(),
    });
  }
  return dates;
}

/** A storage level per day: rows of one day (buckets, databases, namespaces) are summed. */
function applyDailySnapshot<T extends { dimensions: { date?: string | null } }>(
  rows: T[],
  byDate: Map<string, CloudflareDailyUsage>,
  key: CloudflareCostMetricKey,
  valueForRow: (row: T) => number
): void {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const date = normalizeDate(row.dimensions.date);
    if (!date || !byDate.has(date)) continue;
    totals.set(date, (totals.get(date) ?? 0) + valueForRow(row));
  }
  for (const [date, value] of totals) {
    const entry = byDate.get(date);
    if (entry) entry.metrics[key] = value;
  }
}

function normalizeDate(rawDate: string | null | undefined): string | null {
  return rawDate ? rawDate.slice(0, 10) : null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function last(values: number[]): number {
  return values.length === 0 ? 0 : (values[values.length - 1] ?? 0);
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
