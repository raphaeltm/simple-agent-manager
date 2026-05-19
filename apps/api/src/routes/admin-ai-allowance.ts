/**
 * Admin AI Allowance Routes
 *
 * Per-user AI allowance ceilings managed by admins. Stored in KV.
 * Users cannot set their own budget limits above these ceilings.
 *
 * Mounts at /api/admin/ai-allowance (registered in index.ts).
 */
import type { AdminAiAllowance, AdminAiAllowanceResponse, UpdateAdminAiAllowanceRequest } from '@simple-agent-manager/shared';
import { AI_ADMIN_ALLOWANCE_KV_PREFIX } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getAiBudgetLimits } from '../services/ai-token-budget';

const adminAiAllowanceRoutes = new Hono<{ Bindings: Env }>();

adminAiAllowanceRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/** Build the KV key for a user's admin-managed AI allowance. */
function buildAllowanceKey(userId: string): string {
  return `${AI_ADMIN_ALLOWANCE_KV_PREFIX}:${userId}`;
}

/** Read admin allowance from KV. Returns null if not set. */
async function getAllowance(kv: KVNamespace, userId: string): Promise<AdminAiAllowance | null> {
  return kv.get<AdminAiAllowance>(buildAllowanceKey(userId), 'json');
}

/** Resolve effective ceilings: admin allowance → platform defaults. */
function resolveEffectiveCeiling(
  allowance: AdminAiAllowance | null,
  env: Env,
): AdminAiAllowanceResponse['effectiveCeiling'] {
  const { maxDailyTokens, maxMonthlyCostCapUsd } = getAiBudgetLimits(env);

  return {
    maxDailyInputTokens: allowance?.maxDailyInputTokens ?? maxDailyTokens,
    maxDailyOutputTokens: allowance?.maxDailyOutputTokens ?? maxDailyTokens,
    maxMonthlyCostCapUsd: allowance?.maxMonthlyCostCapUsd ?? maxMonthlyCostCapUsd,
  };
}

/** Verify user exists, throw 404 if not. */
async function requireUserExists(db: ReturnType<typeof drizzle>, userId: string): Promise<void> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) {
    throw errors.notFound('User');
  }
}

function validateNullableNumber(
  body: UpdateAdminAiAllowanceRequest,
  field: 'maxDailyInputTokens' | 'maxDailyOutputTokens' | 'maxMonthlyCostCapUsd',
): void {
  const value = body[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || value < 0) {
    throw errors.badRequest(`${field} must be a non-negative number or null`);
  }
}

function validateAllowanceBody(body: UpdateAdminAiAllowanceRequest): void {
  validateNullableNumber(body, 'maxDailyInputTokens');
  validateNullableNumber(body, 'maxDailyOutputTokens');
  validateNullableNumber(body, 'maxMonthlyCostCapUsd');

  const tiers = body.allowedModelTiers;
  if (tiers === undefined || tiers === null) return;
  if (!Array.isArray(tiers) || tiers.some((tier) => typeof tier !== 'string')) {
    throw errors.badRequest('allowedModelTiers must be an array of strings or null');
  }
}

function pickAllowanceValue<T extends keyof UpdateAdminAiAllowanceRequest>(
  body: UpdateAdminAiAllowanceRequest,
  existing: AdminAiAllowance | null,
  field: T,
): AdminAiAllowance[T] {
  const incoming = body[field];
  if (incoming !== undefined) return (incoming ?? null) as AdminAiAllowance[T];
  return (existing?.[field] ?? null) as AdminAiAllowance[T];
}

function buildAllowance(
  body: UpdateAdminAiAllowanceRequest,
  existing: AdminAiAllowance | null,
  adminUserId: string,
): AdminAiAllowance {
  return {
    maxDailyInputTokens: pickAllowanceValue(body, existing, 'maxDailyInputTokens'),
    maxDailyOutputTokens: pickAllowanceValue(body, existing, 'maxDailyOutputTokens'),
    maxMonthlyCostCapUsd: pickAllowanceValue(body, existing, 'maxMonthlyCostCapUsd'),
    allowedModelTiers: pickAllowanceValue(body, existing, 'allowedModelTiers'),
    updatedAt: new Date().toISOString(),
    updatedBy: adminUserId,
  };
}

function toResponse(
  userId: string,
  allowance: AdminAiAllowance | null,
  env: Env,
): AdminAiAllowanceResponse {
  return {
    userId,
    allowance,
    effectiveCeiling: resolveEffectiveCeiling(allowance, env),
  };
}

/**
 * GET /api/admin/ai-allowance/:userId
 * Get admin-managed AI allowance for a user.
 */
adminAiAllowanceRoutes.get('/:userId', async (c) => {
  const targetUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireUserExists(db, targetUserId);

  const allowance = await getAllowance(c.env.KV, targetUserId);
  return c.json(toResponse(targetUserId, allowance, c.env));
});

/**
 * PUT /api/admin/ai-allowance/:userId
 * Set or update admin-managed AI allowance for a user.
 */
adminAiAllowanceRoutes.put('/:userId', async (c) => {
  const adminUserId = getUserId(c);
  const targetUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireUserExists(db, targetUserId);

  const body = await c.req.json<UpdateAdminAiAllowanceRequest>();
  validateAllowanceBody(body);

  const existing = await getAllowance(c.env.KV, targetUserId);
  const allowance = buildAllowance(body, existing, adminUserId);

  await c.env.KV.put(buildAllowanceKey(targetUserId), JSON.stringify(allowance));
  return c.json(toResponse(targetUserId, allowance, c.env));
});

/**
 * DELETE /api/admin/ai-allowance/:userId
 * Remove admin allowance (user reverts to platform defaults).
 */
adminAiAllowanceRoutes.delete('/:userId', async (c) => {
  const targetUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireUserExists(db, targetUserId);

  await c.env.KV.delete(buildAllowanceKey(targetUserId));

  return c.json({ success: true });
});

export { adminAiAllowanceRoutes };
