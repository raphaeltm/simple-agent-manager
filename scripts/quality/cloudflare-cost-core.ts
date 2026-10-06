import {
  BYTES_PER_GB,
  BYTES_PER_GIB,
  DEFAULT_RECENT_DAYS,
  DO_BILLING_MEMORY_GB,
  METRIC_KEYS,
  MICROSECONDS_PER_SECOND,
  type CloudflareCostRows,
  type CostAnalysis,
  type DailyUsage,
  type DurableObjectNamespaceBreakdown,
  type DurableObjectPeriodicRow,
  type MetricKey,
  type MetricKind,
  type MetricPricing,
  type MetricProjection,
  type MetricValues,
  type PricingConfig,
  type ProjectionOptions,
} from './cloudflare-cost-types';

export {
  BYTES_PER_GB,
  BYTES_PER_GIB,
  DEFAULT_RECENT_DAYS,
  DO_BILLING_MEMORY_GB,
  METRIC_KEYS,
  MICROSECONDS_PER_SECOND,
};
export type {
  CloudflareCostRows,
  CostAnalysis,
  DailyUsage,
  DurableObjectNamespaceBreakdown,
  DurableObjectPeriodicRow,
  MetricKey,
  MetricKind,
  MetricPricing,
  MetricProjection,
  MetricValues,
  PricingConfig,
  ProjectionOptions,
};

export function defaultMetricValues(): MetricValues {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as MetricValues;
}

export function createDefaultPricing(
  overrides: Partial<Record<MetricKey, number>> = {}
): PricingConfig {
  const metrics: Record<MetricKey, MetricPricing> = {
    doDurationGbSeconds: {
      key: 'doDurationGbSeconds',
      label: 'Durable Objects duration',
      unit: 'GB-s',
      kind: 'cumulative',
      allowance: 400_000,
      rateUsd: 12.5,
      rateUnit: 1_000_000,
      note: 'Uses durableObjectsPeriodicGroups.sum.duration, not invocation wallTime.',
    },
    doRowsRead: {
      key: 'doRowsRead',
      label: 'Durable Objects SQLite rows read',
      unit: 'rows',
      kind: 'cumulative',
      allowance: 25_000_000_000,
      rateUsd: 0.001,
      rateUnit: 1_000_000,
    },
    doRowsWritten: {
      key: 'doRowsWritten',
      label: 'Durable Objects SQLite rows written',
      unit: 'rows',
      kind: 'cumulative',
      allowance: 50_000_000,
      rateUsd: 1,
      rateUnit: 1_000_000,
    },
    doStorageReadUnits: {
      key: 'doStorageReadUnits',
      label: 'Durable Objects KV read units',
      unit: '4 KB units',
      kind: 'cumulative',
      allowance: 1_000_000,
      rateUsd: 0.2,
      rateUnit: 1_000_000,
    },
    doStorageWriteUnits: {
      key: 'doStorageWriteUnits',
      label: 'Durable Objects KV write units',
      unit: '4 KB units',
      kind: 'cumulative',
      allowance: 1_000_000,
      rateUsd: 1,
      rateUnit: 1_000_000,
    },
    doRequests: {
      key: 'doRequests',
      label: 'Durable Objects requests',
      unit: 'requests',
      kind: 'cumulative',
      allowance: 1_000_000,
      rateUsd: 0.15,
      rateUnit: 1_000_000,
      note: 'Counts DO invocations only; tail-worker invocations are not request billing.',
    },
    workersAiNeurons: {
      key: 'workersAiNeurons',
      label: 'Workers AI neurons',
      unit: 'neurons',
      kind: 'dailyAllowance',
      allowance: 10_000,
      rateUsd: 0.011,
      rateUnit: 1_000,
      note: 'Allowance applies daily at 00:00 UTC.',
    },
    r2StorageGb: {
      key: 'r2StorageGb',
      label: 'R2 storage',
      unit: 'GB',
      kind: 'snapshot',
      allowance: 10,
      rateUsd: 0.015,
      rateUnit: 1,
    },
    d1RowsRead: {
      key: 'd1RowsRead',
      label: 'D1 rows read',
      unit: 'rows',
      kind: 'cumulative',
      allowance: 25_000_000_000,
      rateUsd: 0.001,
      rateUnit: 1_000_000,
    },
    d1RowsWritten: {
      key: 'd1RowsWritten',
      label: 'D1 rows written',
      unit: 'rows',
      kind: 'cumulative',
      allowance: 50_000_000,
      rateUsd: 1,
      rateUnit: 1_000_000,
    },
    d1StorageGb: {
      key: 'd1StorageGb',
      label: 'D1 storage',
      unit: 'GB',
      kind: 'snapshot',
      allowance: 5,
      rateUsd: 0.75,
      rateUnit: 1,
    },
    containerMemoryGibSeconds: {
      key: 'containerMemoryGibSeconds',
      label: 'Containers memory',
      unit: 'GiB-s',
      kind: 'cumulative',
      allowance: 25 * 60 * 60,
      rateUsd: 0.0000025,
      rateUnit: 1,
    },
  };

  for (const [key, allowance] of Object.entries(overrides) as Array<[MetricKey, number]>) {
    metrics[key] = { ...metrics[key], allowance };
  }
  return { metrics };
}

export function analyzeCloudflareCost(
  rows: CloudflareCostRows,
  pricing: PricingConfig,
  options: ProjectionOptions
): CostAnalysis {
  const daily = createDailyUsage(options.startDate, options.endDate);
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const namespaceBreakdown = new Map<string, DurableObjectNamespaceBreakdown>();
  const durationIdentityViolations: string[] = [];

  for (const row of rows.durableObjectPeriodic) {
    const date = normalizeDate(row.dimensions.date);
    const entry = date ? byDate.get(date) : undefined;
    if (!entry) continue;
    add(entry, 'doDurationGbSeconds', numberValue(row.sum?.duration));
    add(entry, 'doRowsRead', numberValue(row.sum?.rowsRead));
    add(entry, 'doRowsWritten', numberValue(row.sum?.rowsWritten));
    add(entry, 'doStorageReadUnits', numberValue(row.sum?.storageReadUnits));
    add(entry, 'doStorageWriteUnits', numberValue(row.sum?.storageWriteUnits));
    collectNamespaceBreakdown(namespaceBreakdown, row);
    const violation = validateDurationIdentity(row);
    if (violation) durationIdentityViolations.push(violation);
  }

  for (const row of rows.durableObjectInvocations) {
    const date = normalizeDate(row.dimensions.date);
    const entry = date ? byDate.get(date) : undefined;
    if (entry) add(entry, 'doRequests', numberValue(row.sum?.requests));
  }

  for (const row of rows.workersAi)
    addByDate(byDate, row.dimensions.date, 'workersAiNeurons', row.sum?.totalNeurons);
  for (const row of rows.d1Analytics) {
    addByDate(byDate, row.dimensions.date, 'd1RowsRead', row.sum?.rowsRead);
    addByDate(byDate, row.dimensions.date, 'd1RowsWritten', row.sum?.rowsWritten);
  }
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
  for (const row of rows.containers)
    addByDate(
      byDate,
      row.dimensions.date,
      'containerMemoryGibSeconds',
      numberValue(row.sum?.allocatedMemory) / BYTES_PER_GIB
    );

  const projections = METRIC_KEYS.map((key) =>
    projectMetric(key, daily, pricing.metrics[key], options.recentDays ?? DEFAULT_RECENT_DAYS)
  );
  return {
    daily,
    projections,
    totalProjectedUsd: projections.reduce(
      (sum, projection) => sum + projection.projectedCostUsd,
      0
    ),
    durableObjectNamespaces: Array.from(namespaceBreakdown.values()).sort(
      (left, right) => right.durationGbSeconds - left.durationGbSeconds
    ),
    durationIdentityViolations,
  };
}

export function projectMetric(
  key: MetricKey,
  daily: DailyUsage[],
  pricing: MetricPricing,
  recentDays: number
): MetricProjection {
  const values = daily.map((entry) => entry.metrics[key]);
  const elapsedDays = Math.max(values.length, 1);
  const daysInMonth = getDaysInMonth(daily[0]?.date ?? new Date().toISOString().slice(0, 10));
  const remainingDays = Math.max(daysInMonth - elapsedDays, 0);
  const recentValues = values.slice(-Math.min(recentDays, values.length));
  const recentDailyAverage = average(recentValues);
  const monthToDateUsage = pricing.kind === 'snapshot' ? last(values) : sum(values);
  const projectedUsage =
    pricing.kind === 'snapshot'
      ? last(values)
      : monthToDateUsage + recentDailyAverage * remainingDays;
  const monthToDateDailyAverage =
    pricing.kind === 'snapshot' ? last(values) : monthToDateUsage / elapsedDays;
  const projectedCostUsd = projectedCost(
    values,
    projectedUsage,
    pricing,
    remainingDays,
    recentDailyAverage
  );
  return {
    key,
    label: pricing.label,
    unit: pricing.unit,
    kind: pricing.kind,
    monthToDateUsage,
    projectedUsage,
    allowance:
      pricing.kind === 'dailyAllowance' ? pricing.allowance * daysInMonth : pricing.allowance,
    headroom:
      (pricing.kind === 'dailyAllowance' ? pricing.allowance * daysInMonth : pricing.allowance) -
      projectedUsage,
    projectedCostUsd,
    recentDailyAverage,
    monthToDateDailyAverage,
    trend: detectTrend(values, recentDailyAverage, monthToDateDailyAverage, pricing.kind),
    note: pricing.note,
  };
}

export function formatCostReport(analysis: CostAnalysis, options: ProjectionOptions): string {
  const lines = [
    'Cloudflare cost audit (usage-derived estimate, not invoice reconciliation)',
    `Window: ${options.startDate} through ${options.endDate}; projection uses the most recent ${options.recentDays ?? DEFAULT_RECENT_DAYS} day(s).`,
    'Durable Object duration uses durableObjectsPeriodicGroups.sum.duration. Invocation wallTime is a latency metric and is not queried for cost.',
    '',
    'Projected monthly usage:',
    'Metric | MTD usage | Projected usage | Allowance | Headroom | Est. cost | Trend',
    '--- | ---: | ---: | ---: | ---: | ---: | ---',
  ];
  for (const projection of analysis.projections) {
    lines.push(
      [
        projection.label,
        formatUsage(projection.monthToDateUsage, projection.unit),
        formatUsage(projection.projectedUsage, projection.unit),
        formatUsage(projection.allowance, projection.unit),
        formatUsage(projection.headroom, projection.unit),
        formatUsd(projection.projectedCostUsd),
        trendLabel(projection.trend),
      ].join(' | ')
    );
  }
  lines.push('', `Projected total: ${formatUsd(analysis.totalProjectedUsd)}`, '', 'Daily series:');
  lines.push(['date', ...METRIC_KEYS].join(','));
  for (const day of analysis.daily)
    lines.push([day.date, ...METRIC_KEYS.map((key) => formatNumber(day.metrics[key]))].join(','));
  lines.push('', 'Durable Object namespace duration breakdown:');
  for (const item of analysis.durableObjectNamespaces.slice(0, 20)) {
    lines.push(
      `${item.namespaceId} (${item.sampleObjectName}): ${formatUsage(item.durationGbSeconds, 'GB-s')}, rowsRead=${formatNumber(item.rowsRead)}, rowsWritten=${formatNumber(item.rowsWritten)}`
    );
  }
  if (analysis.durationIdentityViolations.length > 0) {
    lines.push('', 'Duration identity warnings:');
    lines.push(...analysis.durationIdentityViolations.slice(0, 20));
  }
  return lines.join('\n');
}

export function calculateProjectedCost(usage: number, pricing: MetricPricing): number {
  return (Math.max(usage - pricing.allowance, 0) / pricing.rateUnit) * pricing.rateUsd;
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
  pricing: MetricPricing,
  remainingDays: number,
  recentDailyAverage: number
): number {
  if (pricing.kind !== 'dailyAllowance') return calculateProjectedCost(projectedUsage, pricing);
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
  kind: MetricKind
): MetricProjection['trend'] {
  if (kind === 'snapshot' || values.length < 4) return 'steady';
  const firstFourShare = sum(values.slice(0, 4)) / Math.max(sum(values), 1);
  if (firstFourShare >= 0.7 && recentDailyAverage < monthToDateDailyAverage * 0.6)
    return 'early-spike';
  const previousAverage = average(values.slice(0, -Math.min(DEFAULT_RECENT_DAYS, values.length)));
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

function createDailyUsage(startDate: string, endDate: string): DailyUsage[] {
  const dates: DailyUsage[] = [];
  let cursor = parseDate(startDate);
  const end = parseDate(endDate);
  while (cursor.getTime() <= end.getTime()) {
    dates.push({ date: cursor.toISOString().slice(0, 10), metrics: defaultMetricValues() });
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

function applyDailySnapshot<T extends { dimensions: { date?: string | null } }>(
  rows: T[],
  byDate: Map<string, DailyUsage>,
  key: MetricKey,
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

function addByDate(
  byDate: Map<string, DailyUsage>,
  rawDate: string | null | undefined,
  key: MetricKey,
  rawValue: number | null | undefined
): void {
  const date = normalizeDate(rawDate);
  const entry = date ? byDate.get(date) : undefined;
  if (entry) add(entry, key, numberValue(rawValue));
}

function add(entry: DailyUsage, key: MetricKey, value: number): void {
  entry.metrics[key] += value;
}

function normalizeDate(rawDate: string | null | undefined): string | null {
  if (!rawDate) return null;
  return rawDate.slice(0, 10);
}

function numberValue(value: number | null | undefined): number {
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

function getDaysInMonth(date: string): number {
  const parsed = parseDate(date);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function trendLabel(trend: MetricProjection['trend']): string {
  if (trend === 'early-spike') return 'early spike; recent rate lower';
  if (trend === 'climbing') return 'climbing';
  return 'steady';
}

function formatUsage(value: number, unit: string): string {
  return `${formatNumber(value)} ${unit}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  if (Math.abs(value) >= 10) return value.toFixed(0);
  return value.toFixed(4).replace(/\\.0+$/, '');
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
