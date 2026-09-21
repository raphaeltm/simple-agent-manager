export const DO_BILLING_MEMORY_GB = 0.128;
export const MICROSECONDS_PER_SECOND = 1_000_000;
export const BYTES_PER_GIB = 1024 ** 3;
export const BYTES_PER_GB = 1000 ** 3;
export const DEFAULT_RECENT_DAYS = 7;

export const METRIC_KEYS = [
  'doDurationGbSeconds',
  'doRowsRead',
  'doRowsWritten',
  'doStorageReadUnits',
  'doStorageWriteUnits',
  'doRequests',
  'workersAiNeurons',
  'r2StorageGb',
  'd1RowsRead',
  'd1RowsWritten',
  'd1StorageGb',
  'containerMemoryGibSeconds',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];
export type MetricKind = 'cumulative' | 'dailyAllowance' | 'snapshot';
export type MetricValues = Record<MetricKey, number>;

export interface MetricPricing {
  key: MetricKey;
  label: string;
  unit: string;
  kind: MetricKind;
  allowance: number;
  rateUsd: number;
  rateUnit: number;
  note?: string;
}

export interface PricingConfig {
  metrics: Record<MetricKey, MetricPricing>;
}

export interface DurableObjectPeriodicRow {
  dimensions: {
    date?: string | null;
    namespaceId?: string | null;
    name?: string | null;
  };
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
  dimensions: {
    date?: string | null;
    namespaceId?: string | null;
    scriptName?: string | null;
    type?: string | null;
  };
  sum?: {
    requests?: number | null;
    wallTime?: number | null;
  } | null;
}

export interface WorkersAiRow {
  dimensions: {
    date?: string | null;
    modelId?: string | null;
  };
  sum?: {
    totalNeurons?: number | null;
  } | null;
}

export interface R2StorageRow {
  dimensions: {
    date?: string | null;
    bucketName?: string | null;
    storageClass?: string | null;
  };
  max?: {
    metadataSize?: number | null;
    payloadSize?: number | null;
  } | null;
}

export interface D1AnalyticsRow {
  dimensions: {
    date?: string | null;
    databaseId?: string | null;
  };
  sum?: {
    rowsRead?: number | null;
    rowsWritten?: number | null;
  } | null;
}

export interface D1StorageRow {
  dimensions: {
    date?: string | null;
    databaseId?: string | null;
  };
  max?: {
    databaseSizeBytes?: number | null;
  } | null;
}

export interface ContainerUsageRow {
  dimensions: {
    date?: string | null;
    applicationId?: string | null;
  };
  sum?: {
    allocatedMemory?: number | null;
  } | null;
}

export interface CloudflareCostRows {
  durableObjectPeriodic: DurableObjectPeriodicRow[];
  durableObjectInvocations: DurableObjectInvocationRow[];
  workersAi: WorkersAiRow[];
  r2Storage: R2StorageRow[];
  d1Analytics: D1AnalyticsRow[];
  d1Storage: D1StorageRow[];
  containers: ContainerUsageRow[];
}

export interface DailyUsage {
  date: string;
  metrics: MetricValues;
}

export interface ProjectionOptions {
  startDate: string;
  endDate: string;
  recentDays?: number;
}

export interface MetricProjection {
  key: MetricKey;
  label: string;
  unit: string;
  kind: MetricKind;
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

export interface CostAnalysis {
  daily: DailyUsage[];
  projections: MetricProjection[];
  totalProjectedUsd: number;
  durableObjectNamespaces: DurableObjectNamespaceBreakdown[];
  durationIdentityViolations: string[];
}
