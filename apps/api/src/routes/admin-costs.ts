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
import {
  type GatewayPeriod,
  getGatewayPeriodBounds,
  getPeriodLabel,
  iterateGatewayLogs,
} from '../services/ai-gateway-logs';
import { getAllUsersNodeUsageSummary } from '../services/node-usage';

// ---------------------------------------------------------------------------
// Constants (configurable via env)
// ---------------------------------------------------------------------------

const VALID_PERIODS = ['current-month', '30d', '90d'] as const;
type AdminCostPeriod = (typeof VALID_PERIODS)[number];

/** Default estimated cost per vCPU-hour in USD. Override via COMPUTE_VCPU_HOUR_COST_USD. */
const DEFAULT_COMPUTE_VCPU_HOUR_COST_USD = 0.003;

function parsePeriod(raw: string | undefined): AdminCostPeriod {
  return (VALID_PERIODS as readonly string[]).includes(raw ?? '')
    ? (raw as AdminCostPeriod)
    : 'current-month';
}

/** Compute days info for projection. */
function getPeriodProjectionInfo(period: AdminCostPeriod): {
  daysElapsed: number;
  daysInMonth: number;
  isCurrentMonth: boolean;
} {
  const now = new Date();
  if (period === 'current-month') {
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    return { daysElapsed: Math.max(1, now.getUTCDate()), daysInMonth, isCurrentMonth: true };
  }
  const days = period === '30d' ? 30 : 90;
  return { daysElapsed: days, daysInMonth: 30, isCurrentMonth: false };
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
  const projectionInfo = getPeriodProjectionInfo(period);
  const periodBounds = getGatewayPeriodBounds(period as GatewayPeriod);

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
    await iterateGatewayLogs(c.env, gatewayId, periodBounds.startDate, (entry) => {
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

      // By model (simplified — admin costs doesn't need totalTokens/cached/error per model)
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
          userMap.set(userId, { userId, requests: 1, inputTokens: tokensIn, outputTokens: tokensOut, costUsd: cost });
        }
      }
    });
  }

  // --- Projection ---
  const dailyAvg = projectionInfo.daysElapsed > 0 ? totalCostUsd / projectionInfo.daysElapsed : 0;
  const projection: CostProjection = {
    projectedMonthlyCostUsd: dailyAvg * projectionInfo.daysInMonth,
    dailyAverageCostUsd: dailyAvg,
    daysElapsed: projectionInfo.daysElapsed,
    daysInMonth: projectionInfo.daysInMonth,
  };

  // --- Compute Costs ---
  const vcpuHourCost = parseFloat(c.env.COMPUTE_VCPU_HOUR_COST_USD || '') || DEFAULT_COMPUTE_VCPU_HOUR_COST_USD;

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
    const totalVcpuHours = nodeUsage.users.reduce((sum, u) => sum + u.totalVcpuHours, 0);
    const totalNodeHours = nodeUsage.users.reduce((sum, u) => sum + u.totalNodeHours, 0);
    const activeNodes = nodeUsage.users.reduce((sum, u) => sum + u.activeNodes, 0);
    compute = {
      totalNodeHours,
      totalVcpuHours,
      estimatedCostUsd: totalVcpuHours * vcpuHourCost,
      activeNodes,
      vcpuHourCostUsd: vcpuHourCost,
    };
  } catch (err) {
    log.error('admin_costs.compute_error', { error: err instanceof Error ? err.message : String(err) });
  }

  const summary: CostSummaryResponse = {
    llm: {
      totalCostUsd,
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      trialCostUsd,
      cachedRequests,
      errorRequests,
      byModel: Array.from(modelMap.values()).sort((a, b) => b.costUsd - a.costUsd),
      byDay: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      byUser: Array.from(userMap.values()).sort((a, b) => b.costUsd - a.costUsd),
    },
    projection,
    compute,
    period,
    periodLabel: getPeriodLabel(period as GatewayPeriod),
  };

  return c.json(summary);
});

export { adminCostRoutes };
