import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveAdminSetting } from './admin-settings';
import { MAX_LOG_QUERY_LIMIT } from './observability-common';
import { queryCloudflareLogs } from './observability-logs';
import { hasCloudflareAccountApi } from './platform-capabilities';

export const WORKER_LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'log'] as const;

/** Per-user rate-limit bucket shared by Admin → Logs and `ops_query_worker_logs`. */
export const WORKER_LOG_RATE_KEY_PREFIX = 'cf-log-query';
export const WORKER_LOG_RATE_WINDOW_SECONDS = 60;
/** Same pattern the Admin → Logs request schema enforces (`schemas/misc.ts`). */
const WORKER_SCRIPT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface WorkerLogQuery {
  timeRange: { start: string; end: string };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string;
  queryId?: string;
  scriptName?: string;
}

/**
 * The validated Workers Observability query behind both Admin → Logs
 * (`POST /api/admin/observability/logs/query`) and the Operations `ops_query_worker_logs` tool.
 * Throws a 400 for invalid input or missing Cloudflare credentials; `CfApiError` passes through.
 */
export async function queryWorkerLogs(
  env: Env,
  query: WorkerLogQuery,
  callerSignal?: AbortSignal
): ReturnType<typeof queryCloudflareLogs> {
  if (!hasCloudflareAccountApi(env)) {
    throw errors.featureUnavailable(
      'workersObservability',
      'Worker log search is not available on this installation'
    );
  }
  const start = new Date(query.timeRange.start);
  const end = new Date(query.timeRange.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw errors.badRequest('timeRange start and end must be valid ISO 8601 dates');
  }
  for (const level of query.levels ?? []) {
    if (!(WORKER_LOG_LEVELS as readonly string[]).includes(level)) {
      throw errors.badRequest(
        `Invalid level: ${level}. Must be one of: ${WORKER_LOG_LEVELS.join(', ')}`
      );
    }
  }
  if (query.scriptName && !WORKER_SCRIPT_NAME_PATTERN.test(query.scriptName)) {
    throw errors.badRequest('scriptName must contain 1-64 safe characters');
  }
  if (query.limit !== undefined && (query.limit < 1 || query.limit > MAX_LOG_QUERY_LIMIT)) {
    throw errors.badRequest(`limit must be between 1 and ${MAX_LOG_QUERY_LIMIT}`);
  }
  return queryCloudflareLogs({
    timeoutMs: Number(await resolveAdminSetting(env, 'performance.externalReadTimeoutMs')),
    callerSignal,
    cfApiToken: env.CF_API_TOKEN,
    cfAccountId: env.CF_ACCOUNT_ID,
    timeRange: { start: query.timeRange.start, end: query.timeRange.end },
    levels: query.levels?.length ? query.levels : undefined,
    search: query.search || undefined,
    limit: query.limit,
    cursor: query.cursor || undefined,
    queryId: query.queryId || undefined,
    scriptName: query.scriptName || undefined,
  });
}
