import type {
  UpdateAiBudgetRequest,
  UserAiBudgetResponse,
  UserAiUsageResponse,
  UserQuotaStatusResponse,
} from '@simple-agent-manager/shared';
import { DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import {
  aggregateByDay,
  aggregateByModel,
  getGatewayPeriodBounds,
  getPeriodLabel,
  iterateGatewayLogs,
  parseGatewayPeriod,
  type UsageByDay,
  type UsageByModel,
} from '../services/ai-gateway-logs';
import {
  getTokenUsage,
  getUserBudgetSettings,
  resolveEffectiveLimits,
  saveUserBudgetSettings,
  validateBudgetUpdate,
} from '../services/ai-token-budget';
import { checkQuotaForUser, userHasOwnCloudCredentials } from '../services/compute-quotas';
import { getCurrentPeriodBounds, getUserUsageSummary } from '../services/compute-usage';

const usageRoutes = new Hono<{ Bindings: Env }>();

/** GET /api/usage/compute — current user's compute usage summary. */
usageRoutes.get('/compute', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const { period, activeSessions } = await getUserUsageSummary(db, userId);

  return c.json({
    currentPeriod: period,
    activeSessions,
  });
});

/** GET /api/usage/quota — current user's quota status. */
usageRoutes.get('/quota', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const [quotaCheck, byocExempt] = await Promise.all([
    checkQuotaForUser(db, userId),
    userHasOwnCloudCredentials(db, userId),
  ]);

  const { start, end } = getCurrentPeriodBounds();

  const response: UserQuotaStatusResponse = {
    monthlyVcpuHoursLimit: quotaCheck.limit,
    source: quotaCheck.source,
    currentUsage: quotaCheck.used,
    remaining: quotaCheck.remaining,
    periodStart: start,
    periodEnd: end,
    byocExempt,
  };

  return c.json(response);
});

/**
 * GET /api/usage/ai — current user's SAM-managed AI Gateway LLM usage.
 *
 * Queries Cloudflare AI Gateway logs, filters by the authenticated user's
 * metadata.userId, and aggregates by model and day.
 *
 * Query params: ?period=current-month|7d|30d|90d (default: current-month)
 *
 * MVP: queries Gateway logs directly — no D1 ai_usage_events table.
 * Direct BYOK/non-Gateway usage is out of scope.
 */
usageRoutes.get('/ai', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const period = parseGatewayPeriod(c.req.query('period'));
  const periodBounds = getGatewayPeriodBounds(period);

  const gatewayId = c.env.AI_GATEWAY_ID;
  if (!gatewayId) {
    // Gateway not configured — return empty state, not error
    return c.json({
      totalCostUsd: 0,
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cachedRequests: 0,
      errorRequests: 0,
      byModel: [],
      byDay: [],
      period,
      periodLabel: getPeriodLabel(period),
    } satisfies UserAiUsageResponse);
  }

  const modelMap = new Map<string, UsageByModel>();
  const dayMap = new Map<string, UsageByDay>();
  let totalCostUsd = 0;
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let cachedRequests = 0;
  let errorRequests = 0;

  try {
    await iterateGatewayLogs(c.env, gatewayId, periodBounds.startDate, (entry) => {
      // User isolation: only include entries with matching userId metadata
      if (entry.metadata?.userId !== userId) return;

      const tokensIn = entry.tokens_in || 0;
      const tokensOut = entry.tokens_out || 0;
      const cost = entry.cost || 0;

      totalRequests++;
      totalInputTokens += tokensIn;
      totalOutputTokens += tokensOut;
      totalCostUsd += cost;

      if (entry.cached) cachedRequests++;
      if (!entry.success) errorRequests++;

      aggregateByModel(modelMap, entry);
      aggregateByDay(dayMap, entry);
    });
  } catch (err) {
    log.error('usage.ai_gateway_error', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Return empty rather than error for non-admin users
    return c.json({
      totalCostUsd: 0,
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cachedRequests: 0,
      errorRequests: 0,
      byModel: [],
      byDay: [],
      period,
      periodLabel: getPeriodLabel(period),
    } satisfies UserAiUsageResponse);
  }

  const response: UserAiUsageResponse = {
    totalCostUsd,
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    cachedRequests,
    errorRequests,
    byModel: Array.from(modelMap.values()).sort((a, b) => b.costUsd - a.costUsd),
    byDay: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    period,
    periodLabel: getPeriodLabel(period),
  };

  return c.json(response);
});

// =============================================================================
// Budget Settings
// =============================================================================

/**
 * GET /api/usage/ai/budget — current user's budget settings + utilization.
 */
usageRoutes.get('/ai/budget', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);

  const [userSettings, dailyUsage] = await Promise.all([
    getUserBudgetSettings(c.env.KV, userId),
    getTokenUsage(c.env.KV, userId),
  ]);

  const effectiveLimits = resolveEffectiveLimits(userSettings, c.env);

  // Get current month cost from AI Gateway (reuse the same aggregation)
  let monthCostUsd = 0;
  const gatewayId = c.env.AI_GATEWAY_ID;
  if (gatewayId) {
    const periodBounds = getGatewayPeriodBounds('current-month');
    try {
      await iterateGatewayLogs(c.env, gatewayId, periodBounds.startDate, (entry) => {
        if (entry.metadata?.userId !== userId) return;
        monthCostUsd += entry.cost || 0;
      });
    } catch (err) {
      log.error('usage.budget_gateway_error', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const settings = userSettings ?? {
    dailyInputTokenLimit: null,
    dailyOutputTokenLimit: null,
    monthlyCostCapUsd: null,
    alertThresholdPercent: DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT,
  };

  const dailyInputPercent = effectiveLimits.dailyInputTokenLimit > 0
    ? Math.min(100, (dailyUsage.inputTokens / effectiveLimits.dailyInputTokenLimit) * 100)
    : 0;
  const dailyOutputPercent = effectiveLimits.dailyOutputTokenLimit > 0
    ? Math.min(100, (dailyUsage.outputTokens / effectiveLimits.dailyOutputTokenLimit) * 100)
    : 0;
  const monthlyCostPercent = settings.monthlyCostCapUsd !== null && settings.monthlyCostCapUsd > 0
    ? Math.min(100, (monthCostUsd / settings.monthlyCostCapUsd) * 100)
    : null;

  const exceeded = dailyInputPercent >= 100 || dailyOutputPercent >= 100
    || (monthlyCostPercent !== null && monthlyCostPercent >= 100);

  const response: UserAiBudgetResponse = {
    settings,
    isCustom: userSettings !== null,
    dailyUsage: {
      inputTokens: dailyUsage.inputTokens,
      outputTokens: dailyUsage.outputTokens,
    },
    effectiveLimits,
    monthCostUsd,
    utilization: {
      dailyInputPercent: Math.round(dailyInputPercent * 10) / 10,
      dailyOutputPercent: Math.round(dailyOutputPercent * 10) / 10,
      monthlyCostPercent: monthlyCostPercent !== null ? Math.round(monthlyCostPercent * 10) / 10 : null,
    },
    exceeded,
  };

  return c.json(response);
});

/**
 * PUT /api/usage/ai/budget — update user's budget settings.
 */
usageRoutes.put('/ai/budget', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);

  let body: UpdateAiBudgetRequest;
  try {
    body = await c.req.json() as UpdateAiBudgetRequest;
  } catch {
    return c.json({ error: 'INVALID_JSON', message: 'Invalid JSON body' }, 400);
  }

  let settings;
  try {
    settings = validateBudgetUpdate(body, c.env);
  } catch (err) {
    return c.json({ error: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) }, 400);
  }

  await saveUserBudgetSettings(c.env.KV, userId, settings);

  log.info('usage.budget_updated', {
    userId,
    dailyInputTokenLimit: settings.dailyInputTokenLimit,
    dailyOutputTokenLimit: settings.dailyOutputTokenLimit,
    monthlyCostCapUsd: settings.monthlyCostCapUsd,
    alertThresholdPercent: settings.alertThresholdPercent,
  });

  return c.json({ success: true, settings });
});

export { usageRoutes };
