/**
 * Admin Cost Monitoring — aggregates LLM costs from AI Gateway and compute
 * costs from node usage into a unified cost dashboard.
 *
 * Mounts at /api/admin/costs (registered in index.ts).
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getAllUsersNodeUsageSummary } from '../services/node-usage';

// ---------------------------------------------------------------------------
// Constants (configurable via env)
// ---------------------------------------------------------------------------

/** Default number of AI Gateway log entries per page. CF max is 50. */
const DEFAULT_PAGE_SIZE = 50;
/** Maximum pages to iterate when aggregating. */
const DEFAULT_MAX_PAGES = 20;
/** Hard cap on max pages to prevent Workers CPU timeout. */
const MAX_PAGES_HARD_CAP = 20;

const VALID_PERIODS = ['current-month', '30d', '90d'] as const;
type Period = (typeof VALID_PERIODS)[number];

/** Default estimated cost per vCPU-hour in USD. Override via COMPUTE_VCPU_HOUR_COST_USD. */
const DEFAULT_COMPUTE_VCPU_HOUR_COST_USD = 0.003;

function parsePeriod(raw: string | undefined): Period {
  return (VALID_PERIODS as readonly string[]).includes(raw ?? '')
    ? (raw as Period)
    : 'current-month';
}

/** Compute period start date and days info for projection. */
function getPeriodInfo(period: Period): {
  startDate: string;
  daysElapsed: number;
  daysInMonth: number;
  isCurrentMonth: boolean;
} {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (period === 'current-month') {
    const monthStart = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const daysElapsed = Math.max(1, now.getUTCDate());
    return {
      startDate: monthStart.toISOString(),
      daysElapsed,
      daysInMonth,
      isCurrentMonth: true,
    };
  }

  const days = period === '30d' ? 30 : 90;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days);
  return {
    startDate: start.toISOString(),
    daysElapsed: days,
    daysInMonth: 30, // normalized
    isCurrentMonth: false,
  };
}

// ---------------------------------------------------------------------------
// AI Gateway types
// ---------------------------------------------------------------------------

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
    log.error('admin_costs.gateway_api_error', {
      status: resp.status,
      body: body.slice(0, 500),
      url: url.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]'),
    });
    throw errors.internal(`AI Gateway API error (${resp.status})`);
  }

  return resp.json() as Promise<AIGatewayLogsResponse>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface CostByModel {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface CostByDay {
  date: string;
  costUsd: number;
  requests: number;
}

interface CostByUser {
  userId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface CostProjection {
  projectedMonthlyCostUsd: number;
  dailyAverageCostUsd: number;
  daysElapsed: number;
  daysInMonth: number;
}

interface ComputeCostSummary {
  totalNodeHours: number;
  totalVcpuHours: number;
  estimatedCostUsd: number;
  activeNodes: number;
  vcpuHourCostUsd: number;
}

export interface CostSummaryResponse {
  llm: {
    totalCostUsd: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    trialCostUsd: number;
    cachedRequests: number;
    errorRequests: number;
    byModel: CostByModel[];
    byDay: CostByDay[];
    byUser: CostByUser[];
  };
  projection: CostProjection;
  compute: ComputeCostSummary;
  period: string;
  periodLabel: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const adminCostRoutes = new Hono<{ Bindings: Env }>();

adminCostRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

adminCostRoutes.get('/', async (c) => {
  const enabled = c.env.COST_MONITORING_ENABLED !== 'false';
  if (!enabled) {
    return c.json({ error: 'cost_monitoring_disabled', message: 'Cost monitoring is disabled' }, 404);
  }

  const period = parsePeriod(c.req.query('period'));
  const periodInfo = getPeriodInfo(period);

  // --- LLM Costs (from AI Gateway) ---
  const modelMap = new Map<string, CostByModel>();
  const dayMap = new Map<string, CostByDay>();
  const userMap = new Map<string, CostByUser>();
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let trialCostUsd = 0;
  let cachedRequests = 0;
  let errorRequests = 0;

  const gatewayId = c.env.AI_GATEWAY_ID;
  if (gatewayId) {
    const pageSize =
      parseInt(c.env.AI_USAGE_PAGE_SIZE || '', 10) || DEFAULT_PAGE_SIZE;
    const maxPages = Math.min(
      parseInt(c.env.AI_USAGE_MAX_PAGES || '', 10) || DEFAULT_MAX_PAGES,
      MAX_PAGES_HARD_CAP,
    );

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        page: page.toString(),
        per_page: pageSize.toString(),
        start_date: periodInfo.startDate,
        order_by: 'created_at',
        order_by_direction: 'desc',
      });

      const resp = await fetchGatewayLogs(c.env, gatewayId, params);

      for (const entry of resp.result) {
        const cost = entry.cost || 0;
        const tokensIn = entry.tokens_in || 0;
        const tokensOut = entry.tokens_out || 0;

        totalRequests++;
        totalInputTokens += tokensIn;
        totalOutputTokens += tokensOut;
        totalCostUsd += cost;

        if (entry.cached) cachedRequests++;
        if (!entry.success) errorRequests++;
        if (entry.metadata?.trialId) trialCostUsd += cost;

        // By model
        const modelKey = entry.model || 'unknown';
        const modelEntry = modelMap.get(modelKey);
        if (modelEntry) {
          modelEntry.requests++;
          modelEntry.inputTokens += tokensIn;
          modelEntry.outputTokens += tokensOut;
          modelEntry.costUsd += cost;
        } else {
          modelMap.set(modelKey, {
            model: modelKey,
            provider: entry.provider || 'unknown',
            requests: 1,
            inputTokens: tokensIn,
            outputTokens: tokensOut,
            costUsd: cost,
          });
        }

        // By day
        const dayKey = entry.created_at?.slice(0, 10) || 'unknown';
        const dayEntry = dayMap.get(dayKey);
        if (dayEntry) {
          dayEntry.costUsd += cost;
          dayEntry.requests++;
        } else {
          dayMap.set(dayKey, { date: dayKey, costUsd: cost, requests: 1 });
        }

        // By user (from metadata)
        const userId = entry.metadata?.userId;
        if (userId) {
          const userEntry = userMap.get(userId);
          if (userEntry) {
            userEntry.requests++;
            userEntry.inputTokens += tokensIn;
            userEntry.outputTokens += tokensOut;
            userEntry.costUsd += cost;
          } else {
            userMap.set(userId, {
              userId,
              requests: 1,
              inputTokens: tokensIn,
              outputTokens: tokensOut,
              costUsd: cost,
            });
          }
        }
      }

      if (
        resp.result.length < pageSize ||
        page >= resp.result_info.total_pages
      ) {
        break;
      }
    }
  }

  // --- Projection ---
  const dailyAvg =
    periodInfo.daysElapsed > 0
      ? totalCostUsd / periodInfo.daysElapsed
      : 0;
  const projection: CostProjection = {
    projectedMonthlyCostUsd: dailyAvg * periodInfo.daysInMonth,
    dailyAverageCostUsd: dailyAvg,
    daysElapsed: periodInfo.daysElapsed,
    daysInMonth: periodInfo.daysInMonth,
  };

  // --- Compute Costs ---
  const vcpuHourCost =
    parseFloat(c.env.COMPUTE_VCPU_HOUR_COST_USD || '') ||
    DEFAULT_COMPUTE_VCPU_HOUR_COST_USD;

  let compute: ComputeCostSummary = {
    totalNodeHours: 0,
    totalVcpuHours: 0,
    estimatedCostUsd: 0,
    activeNodes: 0,
    vcpuHourCostUsd: vcpuHourCost,
  };

  try {
    const db = drizzle(c.env.DATABASE, { schema });
    const nodeUsage = await getAllUsersNodeUsageSummary(db);
    const totalVcpuHours = nodeUsage.users.reduce(
      (sum, u) => sum + u.totalVcpuHours,
      0,
    );
    const totalNodeHours = nodeUsage.users.reduce(
      (sum, u) => sum + u.totalNodeHours,
      0,
    );
    const activeNodes = nodeUsage.users.reduce(
      (sum, u) => sum + u.activeNodes,
      0,
    );
    compute = {
      totalNodeHours,
      totalVcpuHours,
      estimatedCostUsd: totalVcpuHours * vcpuHourCost,
      activeNodes,
      vcpuHourCostUsd: vcpuHourCost,
    };
  } catch (err) {
    log.error('admin_costs.compute_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal — return LLM costs even if compute fails
  }

  // --- Period label ---
  const periodLabel =
    period === 'current-month'
      ? new Date().toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })
      : period === '30d'
        ? 'Last 30 days'
        : 'Last 90 days';

  const summary: CostSummaryResponse = {
    llm: {
      totalCostUsd,
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      trialCostUsd,
      cachedRequests,
      errorRequests,
      byModel: Array.from(modelMap.values()).sort(
        (a, b) => b.costUsd - a.costUsd,
      ),
      byDay: Array.from(dayMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      byUser: Array.from(userMap.values()).sort(
        (a, b) => b.costUsd - a.costUsd,
      ),
    },
    projection,
    compute,
    period,
    periodLabel,
  };

  return c.json(summary);
});

export { adminCostRoutes };
