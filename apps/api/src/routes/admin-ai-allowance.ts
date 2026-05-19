/**
 * Admin AI Allowance Routes
 *
 * Per-user AI allowance ceilings managed by admins. Stored in KV.
 * Users cannot set their own budget limits above these ceilings.
 *
 * Mounts at /api/admin/ai-allowance (registered in index.ts).
 */
import type { AdminAiAllowance, AdminAiAllowanceResponse, UpdateAdminAiAllowanceRequest } from '@simple-agent-manager/shared';
import {
  AI_ADMIN_ALLOWANCE_KV_PREFIX,
  DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';

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
  const platformMaxInput = parseInt(env.AI_USAGE_MAX_DAILY_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT;
  const platformMaxOutput = platformMaxInput; // same default for both
  const platformMaxMonthlyCap = parseFloat(env.AI_USAGE_MAX_MONTHLY_COST_CAP_USD || '')
    || DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD;

  return {
    maxDailyInputTokens: allowance?.maxDailyInputTokens ?? platformMaxInput,
    maxDailyOutputTokens: allowance?.maxDailyOutputTokens ?? platformMaxOutput,
    maxMonthlyCostCapUsd: allowance?.maxMonthlyCostCapUsd ?? platformMaxMonthlyCap,
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

function pickNumberAllowance(
  body: UpdateAdminAiAllowanceRequest,
  existing: AdminAiAllowance | null,
  field: 'maxDailyInputTokens' | 'maxDailyOutputTokens' | 'maxMonthlyCostCapUsd',
): number | null {
  const value = body[field];
  return value !== undefined
    ? value ?? null
    : existing?.[field] ?? null;
}

function pickModelTiers(
  body: UpdateAdminAiAllowanceRequest,
  existing: AdminAiAllowance | null,
): string[] | null {
  const field = 'allowedModelTiers';
  return body[field] !== undefined
    ? body[field] ?? null
    : existing?.[field] ?? null;
}

function buildAllowance(
  body: UpdateAdminAiAllowanceRequest,
  existing: AdminAiAllowance | null,
  adminUserId: string,
): AdminAiAllowance {
  return {
    maxDailyInputTokens: pickNumberAllowance(body, existing, 'maxDailyInputTokens'),
    maxDailyOutputTokens: pickNumberAllowance(body, existing, 'maxDailyOutputTokens'),
    maxMonthlyCostCapUsd: pickNumberAllowance(body, existing, 'maxMonthlyCostCapUsd'),
    allowedModelTiers: pickModelTiers(body, existing),
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
