/**
 * Admin AI Usage analytics — queries Cloudflare AI Gateway Logs API for
 * token usage, cost, and request metrics.
 *
 * Mounts at /api/admin/analytics/ai-usage (registered in index.ts).
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import {
  aggregateByDay,
  aggregateByModel,
  getGatewayPeriodBounds,
  iterateGatewayLogs,
  type UsageByDay,
  type UsageByModel,
} from '../services/ai-gateway-logs';

// Admin AI usage supports 24h which isn't a standard GatewayPeriod
const VALID_PERIODS = ['24h', '7d', '30d', '90d'] as const;
type AdminAiPeriod = (typeof VALID_PERIODS)[number];

function parsePeriod(raw: string | undefined): AdminAiPeriod {
  return (VALID_PERIODS as readonly string[]).includes(raw ?? '') ? (raw as AdminAiPeriod) : '7d';
}

function periodToStartDate(period: AdminAiPeriod): string {
  const now = new Date();
  const days = period === '24h' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 90;
  now.setDate(now.getDate() - days);
  return now.toISOString();
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
  byModel: UsageByModel[];
  byDay: UsageByDay[];
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
  const gatewayId = c.env.AI_GATEWAY_ID;
  if (!gatewayId) {
    return c.json({
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      trialRequests: 0,
      trialCostUsd: 0,
      cachedRequests: 0,
      errorRequests: 0,
      byModel: [],
      byDay: [],
      period,
    } satisfies AiUsageSummary);
  }

  // 24h is admin-only — resolve start date manually; 7d/30d/90d use shared helper
  const startDate = period === '24h'
    ? periodToStartDate(period)
    : getGatewayPeriodBounds(period).startDate;

  const modelMap = new Map<string, UsageByModel>();
  const dayMap = new Map<string, UsageByDay>();
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let trialRequests = 0;
  let trialCostUsd = 0;
  let cachedRequests = 0;
  let errorRequests = 0;

  await iterateGatewayLogs(c.env, gatewayId, startDate, (entry) => {
    totalRequests++;
    totalInputTokens += entry.tokens_in || 0;
    totalOutputTokens += entry.tokens_out || 0;
    totalCostUsd += entry.cost || 0;

    if (entry.cached) cachedRequests++;
    if (!entry.success) errorRequests++;
    if (entry.metadata?.trialId) {
      trialRequests++;
      trialCostUsd += entry.cost || 0;
    }

    aggregateByModel(modelMap, entry);
    aggregateByDay(dayMap, entry);
  });

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
