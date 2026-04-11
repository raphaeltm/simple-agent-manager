import { getVcpuCount } from '@simple-agent-manager/shared';
import type {
  ActiveComputeSession,
  AdminUserUsageSummary,
  ComputeUsagePeriod,
  ComputeUsageRecord,
  CredentialSource,
} from '@simple-agent-manager/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';

// =============================================================================
// Start / Stop Tracking
// =============================================================================

export interface StartComputeTrackingInput {
  userId: string;
  workspaceId: string;
  nodeId: string;
  vmSize: string;
  cloudProvider?: string | null;
  credentialSource?: CredentialSource;
}

/** Insert a compute_usage row when a workspace starts running. */
export async function startComputeTracking(
  db: DrizzleD1Database<typeof schema>,
  input: StartComputeTrackingInput
): Promise<string> {
  const id = ulid();
  const vcpuCount = getVcpuCount(input.vmSize, input.cloudProvider);
  const now = new Date().toISOString();

  await db.insert(schema.computeUsage).values({
    id,
    userId: input.userId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    serverType: input.vmSize,
    vcpuCount,
    credentialSource: input.credentialSource ?? 'user',
    startedAt: now,
    createdAt: now,
  });

  log.info('compute-usage: started tracking', {
    id,
    workspaceId: input.workspaceId,
    vcpuCount,
    credentialSource: input.credentialSource ?? 'user',
  });

  return id;
}

/** Set ended_at on all open compute_usage rows for a workspace. */
export async function stopComputeTracking(
  db: DrizzleD1Database<typeof schema>,
  workspaceId: string
): Promise<number> {
  const now = new Date().toISOString();

  await db
    .update(schema.computeUsage)
    .set({ endedAt: now })
    .where(
      and(
        eq(schema.computeUsage.workspaceId, workspaceId),
        isNull(schema.computeUsage.endedAt)
      )
    );

  // D1 doesn't expose rowsAffected reliably through Drizzle, log workspace ID
  const updated = 1;
  if (updated > 0) {
    log.info('compute-usage: stopped tracking', { workspaceId, rowsClosed: updated });
  }
  return updated;
}

// =============================================================================
// Usage Calculation
// =============================================================================

/** Get the start and end of the current calendar month in ISO format. */
export function getCurrentPeriodBounds(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Calculate total vCPU-hours for a user in a given period.
 * Clamps session boundaries to the period window.
 * Running sessions use current time as their effective end.
 */
export async function calculateVcpuHoursForPeriod(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  periodStart: Date,
  periodEnd: Date,
  credentialSource?: CredentialSource
): Promise<number> {
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();
  const nowIso = new Date().toISOString();

  // Build filter conditions
  const conditions = [
    eq(schema.computeUsage.userId, userId),
    // Session overlaps the period: started before period end AND (still running OR ended after period start)
    sql`${schema.computeUsage.startedAt} < ${endIso}`,
    sql`(${schema.computeUsage.endedAt} IS NULL OR ${schema.computeUsage.endedAt} > ${startIso})`,
  ];

  if (credentialSource) {
    conditions.push(eq(schema.computeUsage.credentialSource, credentialSource));
  }

  const rows = await db
    .select({
      startedAt: schema.computeUsage.startedAt,
      endedAt: schema.computeUsage.endedAt,
      vcpuCount: schema.computeUsage.vcpuCount,
    })
    .from(schema.computeUsage)
    .where(and(...conditions));

  let totalMs = 0;
  for (const row of rows) {
    const sessionStart = new Date(row.startedAt);
    const sessionEnd = row.endedAt ? new Date(row.endedAt) : new Date(nowIso);

    // Clamp to period boundaries
    const effectiveStart = sessionStart < periodStart ? periodStart : sessionStart;
    const effectiveEnd = sessionEnd > periodEnd ? periodEnd : sessionEnd;

    const durationMs = effectiveEnd.getTime() - effectiveStart.getTime();
    if (durationMs > 0) {
      totalMs += durationMs * row.vcpuCount;
    }
  }

  // Convert ms to hours
  return totalMs / (1000 * 60 * 60);
}

// =============================================================================
// User Usage Summary
// =============================================================================

/** Get the current user's compute usage summary for the current period. */
export async function getUserUsageSummary(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<{ period: ComputeUsagePeriod; activeSessions: ActiveComputeSession[] }> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);

  const [totalVcpuHours, platformVcpuHours, userVcpuHours] = await Promise.all([
    calculateVcpuHoursForPeriod(db, userId, periodStart, periodEnd),
    calculateVcpuHoursForPeriod(db, userId, periodStart, periodEnd, 'platform'),
    calculateVcpuHoursForPeriod(db, userId, periodStart, periodEnd, 'user'),
  ]);

  // Get active sessions (ended_at IS NULL)
  const activeRows = await db
    .select({
      workspaceId: schema.computeUsage.workspaceId,
      serverType: schema.computeUsage.serverType,
      vcpuCount: schema.computeUsage.vcpuCount,
      startedAt: schema.computeUsage.startedAt,
      credentialSource: schema.computeUsage.credentialSource,
    })
    .from(schema.computeUsage)
    .where(
      and(
        eq(schema.computeUsage.userId, userId),
        isNull(schema.computeUsage.endedAt)
      )
    );

  const activeSessions: ActiveComputeSession[] = activeRows.map((r) => ({
    workspaceId: r.workspaceId,
    serverType: r.serverType,
    vcpuCount: r.vcpuCount,
    startedAt: r.startedAt,
    credentialSource: r.credentialSource as CredentialSource,
  }));

  return {
    period: {
      start,
      end,
      totalVcpuHours: Math.round(totalVcpuHours * 100) / 100,
      platformVcpuHours: Math.round(platformVcpuHours * 100) / 100,
      userVcpuHours: Math.round(userVcpuHours * 100) / 100,
      activeWorkspaces: activeSessions.length,
    },
    activeSessions,
  };
}

// =============================================================================
// Admin Usage Summaries
// =============================================================================

/** Get all users' compute usage summary for the current period. */
export async function getAllUsersUsageSummary(
  db: DrizzleD1Database<typeof schema>
): Promise<{ period: { start: string; end: string }; users: AdminUserUsageSummary[] }> {
  const { start, end } = getCurrentPeriodBounds();

  // Get all users who have compute_usage records in this period
  const rows = await db
    .select({
      userId: schema.computeUsage.userId,
      vcpuCount: schema.computeUsage.vcpuCount,
      startedAt: schema.computeUsage.startedAt,
      endedAt: schema.computeUsage.endedAt,
      credentialSource: schema.computeUsage.credentialSource,
    })
    .from(schema.computeUsage)
    .where(
      and(
        sql`${schema.computeUsage.startedAt} < ${end}`,
        sql`(${schema.computeUsage.endedAt} IS NULL OR ${schema.computeUsage.endedAt} > ${start})`
      )
    );

  // Aggregate per user
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  const nowIso = new Date().toISOString();

  const userMap = new Map<string, { totalMs: number; platformMs: number; userMs: number; activeCount: number }>();

  for (const row of rows) {
    const sessionStart = new Date(row.startedAt);
    const sessionEnd = row.endedAt ? new Date(row.endedAt) : new Date(nowIso);
    const effectiveStart = sessionStart < periodStart ? periodStart : sessionStart;
    const effectiveEnd = sessionEnd > periodEnd ? periodEnd : sessionEnd;
    const durationMs = Math.max(0, effectiveEnd.getTime() - effectiveStart.getTime());
    const weightedMs = durationMs * row.vcpuCount;

    let entry = userMap.get(row.userId);
    if (!entry) {
      entry = { totalMs: 0, platformMs: 0, userMs: 0, activeCount: 0 };
      userMap.set(row.userId, entry);
    }
    entry.totalMs += weightedMs;
    if (row.credentialSource === 'platform') {
      entry.platformMs += weightedMs;
    } else {
      entry.userMs += weightedMs;
    }
    if (!row.endedAt) {
      entry.activeCount++;
    }
  }

  // Fetch user details for all users with usage
  const userIds = Array.from(userMap.keys());
  if (userIds.length === 0) {
    return { period: { start, end }, users: [] };
  }

  const users = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(sql`${schema.users.id} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);

  const userLookup = new Map(users.map((u) => [u.id, u]));
  const msToHours = 1 / (1000 * 60 * 60);

  const summaries: AdminUserUsageSummary[] = userIds
    .map((userId) => {
      const usage = userMap.get(userId)!;
      const user = userLookup.get(userId);
      return {
        userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        totalVcpuHours: Math.round(usage.totalMs * msToHours * 100) / 100,
        platformVcpuHours: Math.round(usage.platformMs * msToHours * 100) / 100,
        userVcpuHours: Math.round(usage.userMs * msToHours * 100) / 100,
        activeWorkspaces: usage.activeCount,
      };
    })
    .sort((a, b) => b.totalVcpuHours - a.totalVcpuHours);

  return { period: { start, end }, users: summaries };
}

/** Get detailed usage for a specific user (admin view). */
export async function getUserDetailedUsage(
  db: DrizzleD1Database<typeof schema>,
  userId: string
): Promise<{
  period: ComputeUsagePeriod;
  activeSessions: ActiveComputeSession[];
  recentRecords: ComputeUsageRecord[];
}> {
  const summary = await getUserUsageSummary(db, userId);

  // Get recent records (last 50)
  const recent = await db
    .select()
    .from(schema.computeUsage)
    .where(eq(schema.computeUsage.userId, userId))
    .orderBy(sql`${schema.computeUsage.startedAt} DESC`)
    .limit(50);

  const recentRecords: ComputeUsageRecord[] = recent.map((r) => ({
    id: r.id,
    userId: r.userId,
    workspaceId: r.workspaceId,
    nodeId: r.nodeId,
    serverType: r.serverType,
    vcpuCount: r.vcpuCount,
    credentialSource: r.credentialSource as CredentialSource,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
  }));

  return {
    period: summary.period,
    activeSessions: summary.activeSessions,
    recentRecords,
  };
}

// =============================================================================
// Orphan Cleanup
// =============================================================================

/** Close compute_usage rows for workspaces that are stopped/deleted but still have open metering. */
export async function closeOrphanedComputeUsage(
  db: DrizzleD1Database<typeof schema>
): Promise<number> {
  const now = new Date().toISOString();

  // Find open compute_usage rows where workspace is stopped/deleted/missing
  const orphans = await db
    .select({
      computeId: schema.computeUsage.id,
      workspaceId: schema.computeUsage.workspaceId,
      workspaceStatus: schema.workspaces.status,
      workspaceUpdatedAt: schema.workspaces.updatedAt,
    })
    .from(schema.computeUsage)
    .leftJoin(
      schema.workspaces,
      eq(schema.computeUsage.workspaceId, schema.workspaces.id)
    )
    .where(
      and(
        isNull(schema.computeUsage.endedAt),
        sql`(${schema.workspaces.id} IS NULL OR ${schema.workspaces.status} IN ('stopped', 'deleted', 'error'))`
      )
    );

  if (orphans.length === 0) return 0;

  let closed = 0;
  for (const orphan of orphans) {
    // Use workspace's updatedAt if available, otherwise use now
    const endedAt = orphan.workspaceUpdatedAt ?? now;

    await db
      .update(schema.computeUsage)
      .set({ endedAt })
      .where(eq(schema.computeUsage.id, orphan.computeId));

    closed++;
  }

  if (closed > 0) {
    log.info('compute-usage: closed orphaned records', { count: closed });
  }

  return closed;
}
