/**
 * Admin Quota Routes
 *
 * CRUD endpoints for managing default quotas and per-user quota overrides.
 * All endpoints require superadmin role.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  checkQuotaForUser,
  getDefaultQuota,
  listUserQuotasWithUsage,
  removeUserQuotaOverride,
  resolveUserQuota,
  setDefaultQuota,
  setUserQuotaOverride,
} from '../services/compute-quotas';
import { calculateVcpuHoursForPeriod, getCurrentPeriodBounds } from '../services/compute-usage';

const adminQuotaRoutes = new Hono<{ Bindings: Env }>();

adminQuotaRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

// =============================================================================
// Default Quota
// =============================================================================

/** GET /api/admin/quotas/default — get current default quota. */
adminQuotaRoutes.get('/default', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const result = await getDefaultQuota(db);
  return c.json(result);
});

/** PUT /api/admin/quotas/default — set default quota. */
adminQuotaRoutes.put('/default', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<{ monthlyVcpuHoursLimit: number | null }>();

  if (body.monthlyVcpuHoursLimit !== null) {
    if (typeof body.monthlyVcpuHoursLimit !== 'number' || body.monthlyVcpuHoursLimit < 0) {
      throw errors.badRequest('monthlyVcpuHoursLimit must be a non-negative number or null');
    }
  }

  await setDefaultQuota(db, body.monthlyVcpuHoursLimit, userId);
  const result = await getDefaultQuota(db);
  return c.json(result);
});

// =============================================================================
// User Quota Overrides
// =============================================================================

/** GET /api/admin/quotas/users — list all user quota overrides with usage. */
adminQuotaRoutes.get('/users', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const defaultQuota = await getDefaultQuota(db);
  const users = await listUserQuotasWithUsage(db);
  return c.json({ defaultQuota, users });
});

/** GET /api/admin/quotas/users/:userId — get specific user's resolved quota. */
adminQuotaRoutes.get('/users/:userId', async (c) => {
  const targetUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Verify user exists
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .limit(1);

  if (!user) {
    throw errors.notFound('User');
  }

  const quota = await resolveUserQuota(db, targetUserId);
  const { start, end } = getCurrentPeriodBounds();
  const currentUsage = await calculateVcpuHoursForPeriod(
    db,
    targetUserId,
    new Date(start),
    new Date(end),
    'platform'
  );

  const rounded = Math.round(currentUsage * 100) / 100;
  const remaining = quota.monthlyVcpuHoursLimit !== null
    ? Math.round((quota.monthlyVcpuHoursLimit - currentUsage) * 100) / 100
    : null;
  const percentUsed = quota.monthlyVcpuHoursLimit !== null && quota.monthlyVcpuHoursLimit > 0
    ? Math.round((rounded / quota.monthlyVcpuHoursLimit) * 100)
    : null;

  return c.json({
    userId: targetUserId,
    monthlyVcpuHoursLimit: quota.monthlyVcpuHoursLimit,
    source: quota.source,
    currentUsage: rounded,
    remaining,
    percentUsed,
  });
});

/** PUT /api/admin/quotas/users/:userId — set user quota override. */
adminQuotaRoutes.put('/users/:userId', async (c) => {
  const adminUserId = getUserId(c);
  const targetUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Verify user exists
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .limit(1);

  if (!user) {
    throw errors.notFound('User');
  }

  const body = await c.req.json<{ monthlyVcpuHoursLimit: number | null }>();

  if (body.monthlyVcpuHoursLimit !== null) {
    if (typeof body.monthlyVcpuHoursLimit !== 'number' || body.monthlyVcpuHoursLimit < 0) {
      throw errors.badRequest('monthlyVcpuHoursLimit must be a non-negative number or null');
    }
  }

  await setUserQuotaOverride(db, targetUserId, body.monthlyVcpuHoursLimit, adminUserId);

  // Return resolved quota
  const check = await checkQuotaForUser(db, targetUserId);
  return c.json({
    userId: targetUserId,
    monthlyVcpuHoursLimit: check.limit,
    source: check.source,
    currentUsage: check.used,
    remaining: check.remaining,
  });
});

/** DELETE /api/admin/quotas/users/:userId — remove user override (fall back to default). */
adminQuotaRoutes.delete('/users/:userId', async (c) => {
  const targetUserId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });

  const removed = await removeUserQuotaOverride(db, targetUserId);
  if (!removed) {
    throw errors.notFound('User quota override');
  }

  return c.json({ success: true });
});

export { adminQuotaRoutes };
