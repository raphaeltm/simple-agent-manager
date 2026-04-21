/**
 * Admin AI Usage analytics — queries Cloudflare AI Gateway Logs API for
 * token usage, cost, and request metrics.
 *
 * Mounts at /api/admin/analytics/ai-usage (registered in index.ts).
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';

/** Default AI Gateway ID. Override via AI_GATEWAY_ID env var. */
const DEFAULT_GATEWAY_ID = 'sam';
/** Default number of log entries to fetch per page. Override via AI_USAGE_PAGE_SIZE env var. */
const DEFAULT_PAGE_SIZE = 100;
/** Maximum pages to iterate when aggregating. Override via AI_USAGE_MAX_PAGES env var. */
const DEFAULT_MAX_PAGES = 20;

const VALID_PERIODS = ['24h', '7d', '30d', '90d'] as const;
type Period = (typeof VALID_PERIODS)[number];

function parsePeriod(raw: string | undefined): Period {
  return (VALID_PERIODS as readonly string[]).includes(raw ?? '') ? (raw as Period) : '7d';
}

/** Convert period to ISO date string for start_date filter. */
function periodToStartDate(period: Period): string {
  const now = new Date();
  switch (period) {
    case '24h':
      now.setDate(now.getDate() - 1);
      break;
    case '7d':
      now.setDate(now.getDate() - 7);
      break;
    case '30d':
      now.setDate(now.getDate() - 30);
      break;
    case '90d':
      now.setDate(now.getDate() - 90);
      break;
  }
  return now.toISOString();
}

interface AIGatewayLogEntry {
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

interface AIGatewayLogsResponse {
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

/** Fetch a single page of AI Gateway logs. */
async function fetchGatewayLogs(
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
    log.error('admin_ai_usage.gateway_api_error', {
      status: resp.status,
      body: body.slice(0, 500),
      url: url.replace(/Bearer\s+\S+/, 'Bearer [REDACTED]'),
    });
    throw errors.internal(`AI Gateway API error: ${resp.status} — ${body.slice(0, 200)}`);
  }

  return resp.json() as Promise<AIGatewayLogsResponse>;
}

export interface AiUsageByModel {
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

export interface AiUsageByDay {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AiUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  trialRequests: number;
  trialCostUsd: number;
  cachedRequests: number;
  errorRequests: number;
  byModel: AiUsageByModel[];
  byDay: AiUsageByDay[];
  period: string;
}

const adminAiUsageRoutes = new Hono<{ Bindings: Env }>();

adminAiUsageRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * GET /ai-usage — Aggregated AI usage from AI Gateway logs.
 * Query params: ?period=7d (24h|7d|30d|90d)
 */
adminAiUsageRoutes.get('/', async (c) => {
  const period = parsePeriod(c.req.query('period'));
  const gatewayId = c.env.AI_GATEWAY_ID || DEFAULT_GATEWAY_ID;
  const pageSize = parseInt(c.env.AI_USAGE_PAGE_SIZE || '', 10) || DEFAULT_PAGE_SIZE;
  const maxPages = parseInt(c.env.AI_USAGE_MAX_PAGES || '', 10) || DEFAULT_MAX_PAGES;
  const startDate = periodToStartDate(period);

  // Aggregate across all pages
  const modelMap = new Map<string, AiUsageByModel>();
  const dayMap = new Map<string, AiUsageByDay>();
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let trialRequests = 0;
  let trialCostUsd = 0;
  let cachedRequests = 0;
  let errorRequests = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: pageSize.toString(),
      start_date: startDate,
      order_by: 'created_at',
      order_by_direction: 'desc',
    });

    const resp = await fetchGatewayLogs(c.env, gatewayId, params);

    for (const entry of resp.result) {
      totalRequests++;
      totalInputTokens += entry.tokens_in || 0;
      totalOutputTokens += entry.tokens_out || 0;
      totalCostUsd += entry.cost || 0;

      if (entry.cached) cachedRequests++;
      if (!entry.success) errorRequests++;

      // Check metadata for trial flag
      if (entry.metadata?.trialId) {
        trialRequests++;
        trialCostUsd += entry.cost || 0;
      }

      // Aggregate by model
      const modelKey = entry.model || 'unknown';
      const existing = modelMap.get(modelKey);
      if (existing) {
        existing.requests++;
        existing.inputTokens += entry.tokens_in || 0;
        existing.outputTokens += entry.tokens_out || 0;
        existing.totalTokens += (entry.tokens_in || 0) + (entry.tokens_out || 0);
        existing.costUsd += entry.cost || 0;
        if (entry.cached) existing.cachedRequests++;
        if (!entry.success) existing.errorRequests++;
      } else {
        modelMap.set(modelKey, {
          model: modelKey,
          provider: entry.provider || 'unknown',
          requests: 1,
          inputTokens: entry.tokens_in || 0,
          outputTokens: entry.tokens_out || 0,
          totalTokens: (entry.tokens_in || 0) + (entry.tokens_out || 0),
          costUsd: entry.cost || 0,
          cachedRequests: entry.cached ? 1 : 0,
          errorRequests: entry.success ? 0 : 1,
        });
      }

      // Aggregate by day
      const dayKey = entry.created_at?.slice(0, 10) || 'unknown';
      const dayEntry = dayMap.get(dayKey);
      if (dayEntry) {
        dayEntry.requests++;
        dayEntry.inputTokens += entry.tokens_in || 0;
        dayEntry.outputTokens += entry.tokens_out || 0;
        dayEntry.costUsd += entry.cost || 0;
      } else {
        dayMap.set(dayKey, {
          date: dayKey,
          requests: 1,
          inputTokens: entry.tokens_in || 0,
          outputTokens: entry.tokens_out || 0,
          costUsd: entry.cost || 0,
        });
      }
    }

    // Stop if we've gotten all results
    if (resp.result.length < pageSize || page >= resp.result_info.total_pages) {
      break;
    }
  }

  const summary: AiUsageSummary = {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    trialRequests,
    trialCostUsd,
    cachedRequests,
    errorRequests,
    byModel: Array.from(modelMap.values()).sort((a, b) => b.costUsd - a.costUsd),
    byDay: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    period,
  };

  return c.json(summary);
});

export { adminAiUsageRoutes };
