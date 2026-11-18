import type { PlatformErrorLevel, PlatformErrorSource } from '@simple-agent-manager/shared';

import type { Env } from '../env';

// =============================================================================
// Constants (configurable via env)
// =============================================================================

export const DEFAULT_RETENTION_DAYS = 30;

export const DEFAULT_MAX_ROWS = 100_000;

export const DEFAULT_BATCH_SIZE = 25;

export const MAX_QUERY_LIMIT = 200;

export const DEFAULT_QUERY_LIMIT = 50;

export const VALID_SOURCES = new Set<string>(['client', 'vm-agent', 'api']);

export const VALID_LEVELS = new Set<string>(['error', 'warn', 'info']);

export function getConfigNumber(env: Env, key: keyof Env, fallback: number): number {
  const val = env[key] as string | undefined;
  if (val) {
    const n = Number.parseInt(val, 10);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return fallback;
}

// =============================================================================
// Error Persistence (T018)
// =============================================================================

export interface PersistErrorInput {
  id?: string;
  source: PlatformErrorSource;
  level?: PlatformErrorLevel;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
  userId?: string | null;
  nodeId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  timestamp?: number; // ms epoch; defaults to now
}

// =============================================================================
// Error Querying (T019)
// =============================================================================

export interface QueryErrorsParams {
  source?: PlatformErrorSource;
  level?: PlatformErrorLevel;
  search?: string;
  startTime?: number; // ms epoch
  endTime?: number; // ms epoch
  nodeId?: string;
  workspaceId?: string;
  taskId?: string;
  sessionId?: string;
  userId?: string;
  limit?: number;
  cursor?: string; // base64 encoded timestamp cursor
}

export interface QueryErrorsResult {
  errors: Array<{
    id: string;
    source: string;
    level: string;
    message: string;
    stack: string | null;
    context: Record<string, unknown> | null;
    userId: string | null;
    nodeId: string | null;
    workspaceId: string | null;
    taskId: string | null;
    sessionId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    timestamp: string; // ISO 8601
  }>;
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

// =============================================================================
// Health Summary (T040 — Phase 4, but defined here for colocation)
// =============================================================================

export interface HealthSummaryResult {
  activeNodes: number;
  activeWorkspaces: number;
  inProgressTasks: number;
  errorCount24h: number;
  timestamp: string;
}

// =============================================================================
// Error Trends (T072 — Phase 7, but defined here for colocation)
// =============================================================================

export const RANGE_TO_INTERVAL: Record<string, { intervalMs: number; intervalLabel: string }> = {
  '1h': { intervalMs: 5 * 60 * 1000, intervalLabel: '5m' },
  '24h': { intervalMs: 60 * 60 * 1000, intervalLabel: '1h' },
  '7d': { intervalMs: 24 * 60 * 60 * 1000, intervalLabel: '1d' },
  '30d': { intervalMs: 24 * 60 * 60 * 1000, intervalLabel: '1d' },
};

export const RANGE_TO_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface ErrorTrendsResult {
  range: string;
  interval: string;
  buckets: Array<{
    timestamp: string;
    total: number;
    bySource: Record<string, number>;
  }>;
}

// =============================================================================
// Retention Purge (T023)
// =============================================================================

export interface PurgeResult {
  deletedByAge: number;
  deletedByCount: number;
}

// =============================================================================
// Cloudflare Workers Observability API Proxy (T049 — Phase 5, US3)
// =============================================================================

export const DEFAULT_LOG_QUERY_LIMIT = 100;

export const MAX_LOG_QUERY_LIMIT = 500;

export const DEFAULT_LOG_QUERY_RATE_LIMIT = 30;

export const CF_OBSERVABILITY_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export interface QueryCloudflarLogsInput {
  timeoutMs?: number;
  callerSignal?: AbortSignal;
  cfApiToken: string;
  cfAccountId: string;
  timeRange: { start: string; end: string };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string | null;
  scriptName?: string;
  /** Optional caller-supplied queryId for pagination consistency. Generated per-request if omitted. */
  queryId?: string;
}
