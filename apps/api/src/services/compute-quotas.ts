/**
 * Compute Quotas Service
 *
 * Handles quota resolution (user override → default → unlimited),
 * quota enforcement checks, and admin CRUD operations.
 *
 * Quotas only apply to platform-provisioned compute (credential_source = 'platform').
 * BYOC users are exempt.
 */
import type { CredentialProvider, QuotaSource } from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { calculateVcpuHoursForPeriod, getCurrentPeriodBounds } from './compute-usage';

// =============================================================================
// Quota Resolution
// =============================================================================

export interface ResolvedQuota {
  monthlyVcpuHoursLimit: number | null;
  source: QuotaSource;
}

/**
 * Resolve the effective quota for a user.
 * Chain: user_quotas → default_quotas → unlimited (null).
 */
export async function resolveUserQuota(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<ResolvedQuota> {
  // 1. Check user-specific override
  const [userQuota] = await db
    .select({ monthlyVcpuHoursLimit: schema.userQuotas.monthlyVcpuHoursLimit })
    .from(schema.userQuotas)
    .where(eq(schema.userQuotas.userId, userId))
    .limit(1);

  if (userQuota) {
    return {
      monthlyVcpuHoursLimit: userQuota.monthlyVcpuHoursLimit,
      source: 'user_override',
    };
  }

  // 2. Check platform default
  const [defaultQuota] = await db
    .select({ monthlyVcpuHoursLimit: schema.defaultQuotas.monthlyVcpuHoursLimit })
    .from(schema.defaultQuotas)
    .limit(1);

  if (defaultQuota && defaultQuota.monthlyVcpuHoursLimit !== null) {
    return {
      monthlyVcpuHoursLimit: defaultQuota.monthlyVcpuHoursLimit,
      source: 'default',
    };
  }

  // 3. No quota configured — unlimited
  return { monthlyVcpuHoursLimit: null, source: 'unlimited' };
}

// =============================================================================
// Quota Enforcement
// =============================================================================

export interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  source: QuotaSource;
}

/**
 * Check if a user is within their compute quota for the current period.
 * Only counts platform-provisioned usage (credential_source = 'platform').
 */
export async function checkQuotaForUser(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<QuotaCheckResult> {
  const quota = await resolveUserQuota(db, userId);

  if (quota.monthlyVcpuHoursLimit === null) {
    return { allowed: true, used: 0, limit: null, remaining: null, source: quota.source };
  }

  const { start, end } = getCurrentPeriodBounds();
  const used = await calculateVcpuHoursForPeriod(
    db,
    userId,
    new Date(start),
    new Date(end),
    'platform'
  );

  const remaining = quota.monthlyVcpuHoursLimit - used;
  return {
    allowed: remaining > 0,
    used: Math.round(used * 100) / 100,
    limit: quota.monthlyVcpuHoursLimit,
    remaining: Math.round(remaining * 100) / 100,
    source: quota.source,
  };
}

/**
 * Determine if a user has their own cloud credentials (BYOC).
 * When `targetProvider` is specified, only checks for credentials matching that provider.
 * Without `targetProvider`, checks for ANY cloud-provider credential (used for informational display).
 *
 * IMPORTANT: For quota enforcement, always pass `targetProvider` to avoid the bypass bug
 * where a user with a Hetzner credential is exempt when provisioning on Scaleway (platform).
 */
export async function userHasOwnCloudCredentials(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  targetProvider?: CredentialProvider,
): Promise<boolean> {
  const conditions = [
    eq(schema.credentials.userId, userId),
    eq(schema.credentials.credentialType, 'cloud-provider'),
  ];
  if (targetProvider) {
    conditions.push(eq(schema.credentials.provider, targetProvider));
  }

  const [cred] = await db
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(and(...conditions))
    .limit(1);

  return !!cred;
}

// =============================================================================
// Admin CRUD
// =============================================================================

/** Get the current default quota. */
export async function getDefaultQuota(
  db: DrizzleD1Database<typeof schema>
): Promise<{ monthlyVcpuHoursLimit: number | null; updatedAt: string | null }> {
  const [row] = await db
    .select({
      monthlyVcpuHoursLimit: schema.defaultQuotas.monthlyVcpuHoursLimit,
      updatedAt: schema.defaultQuotas.updatedAt,
    })
    .from(schema.defaultQuotas)
    .limit(1);

  return {
    monthlyVcpuHoursLimit: row?.monthlyVcpuHoursLimit ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Set or update the default quota. Uses upsert (single row). */
export async function setDefaultQuota(
  db: DrizzleD1Database<typeof schema>,
  monthlyVcpuHoursLimit: number | null,
  updatedBy: string
): Promise<void> {
  const now = new Date().toISOString();

  // Check if a row exists
  const [existing] = await db
    .select({ id: schema.defaultQuotas.id })
    .from(schema.defaultQuotas)
    .limit(1);

  if (existing) {
    await db
      .update(schema.defaultQuotas)
      .set({ monthlyVcpuHoursLimit, updatedAt: now, updatedBy })
      .where(eq(schema.defaultQuotas.id, existing.id));
  } else {
    await db.insert(schema.defaultQuotas).values({
      id: ulid(),
      monthlyVcpuHoursLimit,
      updatedAt: now,
      updatedBy,
    });
  }

  log.info('compute-quotas: default quota updated', { monthlyVcpuHoursLimit, updatedBy });
}

/** Get a specific user's quota override (if any). */
export async function getUserQuotaOverride(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<{ monthlyVcpuHoursLimit: number | null; updatedAt: string } | null> {
  const [row] = await db
    .select({
      monthlyVcpuHoursLimit: schema.userQuotas.monthlyVcpuHoursLimit,
      updatedAt: schema.userQuotas.updatedAt,
    })
    .from(schema.userQuotas)
    .where(eq(schema.userQuotas.userId, userId))
    .limit(1);

  return row ?? null;
}

/** Set or update a user's quota override. */
export async function setUserQuotaOverride(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  monthlyVcpuHoursLimit: number | null,
  updatedBy: string
): Promise<void> {
  const now = new Date().toISOString();

  const [existing] = await db
    .select({ id: schema.userQuotas.id })
    .from(schema.userQuotas)
    .where(eq(schema.userQuotas.userId, userId))
    .limit(1);

  if (existing) {
    await db
      .update(schema.userQuotas)
      .set({ monthlyVcpuHoursLimit, updatedAt: now, updatedBy })
      .where(eq(schema.userQuotas.id, existing.id));
  } else {
    await db.insert(schema.userQuotas).values({
      id: ulid(),
      userId,
      monthlyVcpuHoursLimit,
      updatedAt: now,
      updatedBy,
    });
  }

  log.info('compute-quotas: user quota updated', { userId, monthlyVcpuHoursLimit, updatedBy });
}

/** Remove a user's quota override (falls back to default). */
export async function removeUserQuotaOverride(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<boolean> {
  const [existing] = await db
    .select({ id: schema.userQuotas.id })
    .from(schema.userQuotas)
    .where(eq(schema.userQuotas.userId, userId))
    .limit(1);

  if (!existing) return false;

  await db
    .delete(schema.userQuotas)
    .where(eq(schema.userQuotas.id, existing.id));

  log.info('compute-quotas: user quota removed', { userId });
  return true;
}

/** List all user quota overrides with user info and current usage. */
export async function listUserQuotasWithUsage(
  db: DrizzleD1Database<typeof schema>
): Promise<
  Array<{
    userId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    monthlyVcpuHoursLimit: number | null;
    source: QuotaSource;
    currentUsage: number;
    percentUsed: number | null;
  }>
> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);

  // Get all users with usage in this period
  const usageRows = await db
    .select({
      userId: schema.computeUsage.userId,
    })
    .from(schema.computeUsage);

  // Get all user quota overrides
  const overrides = await db
    .select()
    .from(schema.userQuotas);

  // Get the default quota
  const defaultQuota = await getDefaultQuota(db);

  // Collect all relevant user IDs (those with overrides + those with usage)
  const allUserIds = new Set<string>();
  for (const o of overrides) allUserIds.add(o.userId);

  // Get unique user IDs from compute_usage
  const usageUserIds = [...new Set(usageRows.map((r) => r.userId))];
  for (const uid of usageUserIds) allUserIds.add(uid);

  if (allUserIds.size === 0) return [];

  const userIds = [...allUserIds];
  const users = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(inArray(schema.users.id, userIds));

  const userLookup = new Map(users.map((u) => [u.id, u]));
  const overrideLookup = new Map(overrides.map((o) => [o.userId, o]));

  const results = await Promise.all(
    userIds.map(async (userId) => {
      const user = userLookup.get(userId);
      const override = overrideLookup.get(userId);

      let limit: number | null;
      let source: QuotaSource;
      if (override) {
        limit = override.monthlyVcpuHoursLimit;
        source = 'user_override';
      } else if (defaultQuota.monthlyVcpuHoursLimit !== null) {
        limit = defaultQuota.monthlyVcpuHoursLimit;
        source = 'default';
      } else {
        limit = null;
        source = 'unlimited';
      }

      const currentUsage = await calculateVcpuHoursForPeriod(
        db,
        userId,
        periodStart,
        periodEnd,
        'platform'
      );
      const rounded = Math.round(currentUsage * 100) / 100;
      const percentUsed = limit !== null && limit > 0
        ? Math.round((rounded / limit) * 100)
        : null;

      return {
        userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        monthlyVcpuHoursLimit: limit,
        source,
        currentUsage: rounded,
        percentUsed,
      };
    })
  );

  // Sort by usage descending
  return results.sort((a, b) => b.currentUsage - a.currentUsage);
}
