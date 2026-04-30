/**
 * Shared AI Gateway log helpers — used by admin routes AND user-facing usage endpoint.
 *
 * Centralises types, pagination, period parsing, and aggregation that were
 * previously duplicated across admin-costs.ts and admin-ai-usage.ts.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';

// ---------------------------------------------------------------------------
// Gateway API types
// ---------------------------------------------------------------------------

export interface AIGatewayLogEntry {
  id: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  success: boolean;
  cached: boolean;
  created_at: string;
  duration: number;
  metadata: Record<string, string> | null;
}

export interface AIGatewayLogsResponse {
  result: AIGatewayLogEntry[];
  result_info: {
    page: number;
    per_page: number;
    count: number;
    total_count: number;
    total_pages: number;
  };
  success: boolean;
  errors: unknown[];
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

export type GatewayPeriod = 'current-month' | '7d' | '30d' | '90d';

const VALID_GATEWAY_PERIODS: readonly string[] = ['current-month', '7d', '30d', '90d'];

/** Parse raw query param into a validated GatewayPeriod (default: 'current-month'). */
export function parseGatewayPeriod(raw: string | undefined): GatewayPeriod {
  return VALID_GATEWAY_PERIODS.includes(raw ?? '') ? (raw as GatewayPeriod) : 'current-month';
}

/** Get ISO start date for a given period. */
export function getGatewayPeriodBounds(period: GatewayPeriod): { startDate: string } {
  const now = new Date();
  if (period === 'current-month') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { startDate: start.toISOString() };
  }
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days);
  return { startDate: start.toISOString() };
}

/** Human-readable period label. */
export function getPeriodLabel(period: GatewayPeriod): string {
  if (period === 'current-month') {
    return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  const map: Record<string, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };
  return map[period] ?? period;
}

// ---------------------------------------------------------------------------
// Pagination config
// ---------------------------------------------------------------------------

/** Default number of AI Gateway log entries per page. CF max is 50. */
const DEFAULT_PAGE_SIZE = 50;
/** Default maximum pages to iterate when aggregating. */
const DEFAULT_MAX_PAGES = 20;
/** Hard cap on max pages to prevent Workers CPU timeout. */
const MAX_PAGES_HARD_CAP = 20;

/** Resolve pageSize/maxPages from env with defaults and hard cap. */
export function resolveGatewayPagination(env: Env): { pageSize: number; maxPages: number } {
  const pageSize = parseInt(env.AI_USAGE_PAGE_SIZE || '', 10) || DEFAULT_PAGE_SIZE;
  const maxPages = Math.min(
    parseInt(env.AI_USAGE_MAX_PAGES || '', 10) || DEFAULT_MAX_PAGES,
    MAX_PAGES_HARD_CAP,
  );
  return { pageSize, maxPages };
}

// ---------------------------------------------------------------------------
// Fetch + iterate
// ---------------------------------------------------------------------------

/** Fetch a single page of AI Gateway logs. */
export async function fetchGatewayLogs(
  env: Env,
  gatewayId: string,
  params: URLSearchParams,
): Promise<AIGatewayLogsResponse> {
  const accountId = env.CF_ACCOUNT_ID;
  if (!accountId) throw errors.internal('CF_ACCOUNT_ID is not configured');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    log.error('ai_gateway.api_error', {
      status: resp.status,
      body: body.slice(0, 500),
      url: url.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]'),
    });
    throw errors.internal(`AI Gateway API error (${resp.status})`);
  }

  return resp.json() as Promise<AIGatewayLogsResponse>;
}

/**
 * Iterate over all pages of AI Gateway logs for a given startDate,
 * calling `visitor` for each entry. Handles pagination automatically.
 */
export async function iterateGatewayLogs(
  env: Env,
  gatewayId: string,
  startDate: string,
  visitor: (entry: AIGatewayLogEntry) => void,
): Promise<void> {
  const { pageSize, maxPages } = resolveGatewayPagination(env);

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: pageSize.toString(),
      start_date: startDate,
      order_by: 'created_at',
      order_by_direction: 'desc',
    });

    const resp = await fetchGatewayLogs(env, gatewayId, params);

    for (const entry of resp.result) {
      visitor(entry);
    }

    if (resp.result.length < pageSize || page >= resp.result_info.total_pages) {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export interface UsageByModel {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  cachedRequests: number;
  errorRequests: number;
}

export interface UsageByDay {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Accumulate a gateway log entry into a by-model map. */
export function aggregateByModel(map: Map<string, UsageByModel>, entry: AIGatewayLogEntry): void {
  const key = entry.model || 'unknown';
  const tokensIn = entry.tokens_in || 0;
  const tokensOut = entry.tokens_out || 0;
  const cost = entry.cost || 0;

  const existing = map.get(key);
  if (existing) {
    existing.requests++;
    existing.inputTokens += tokensIn;
    existing.outputTokens += tokensOut;
    existing.totalTokens += tokensIn + tokensOut;
    existing.costUsd += cost;
    if (entry.cached) existing.cachedRequests++;
    if (!entry.success) existing.errorRequests++;
  } else {
    map.set(key, {
      model: key,
      provider: entry.provider || 'unknown',
      requests: 1,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      totalTokens: tokensIn + tokensOut,
      costUsd: cost,
      cachedRequests: entry.cached ? 1 : 0,
      errorRequests: entry.success ? 0 : 1,
    });
  }
}

/** Accumulate a gateway log entry into a by-day map. */
export function aggregateByDay(map: Map<string, UsageByDay>, entry: AIGatewayLogEntry): void {
  const key = entry.created_at?.slice(0, 10) || 'unknown';
  const tokensIn = entry.tokens_in || 0;
  const tokensOut = entry.tokens_out || 0;
  const cost = entry.cost || 0;

  const existing = map.get(key);
  if (existing) {
    existing.requests++;
    existing.inputTokens += tokensIn;
    existing.outputTokens += tokensOut;
    existing.costUsd += cost;
  } else {
    map.set(key, {
      date: key,
      requests: 1,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      costUsd: cost,
    });
  }
}
