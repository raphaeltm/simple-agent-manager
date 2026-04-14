import type {
  AdminUserNodeDetailedUsage,
  AdminUserNodeUsageSummary,
  CredentialSource,
  NodeUsageRecord,
} from '@simple-agent-manager/shared';
import { getVcpuCount } from '@simple-agent-manager/shared';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { getCurrentPeriodBounds } from './compute-usage';

// =============================================================================
// Node status helpers
// =============================================================================

const ENDED_STATUSES_ARRAY = ['destroyed', 'destroying', 'deleted', 'error'] as const;
const ENDED_STATUSES = new Set<string>(ENDED_STATUSES_ARRAY);

function isNodeEnded(status: string): boolean {
  return ENDED_STATUSES.has(status);
}

/**
 * Derive the node's effective end time.
 * - If still running: null (use `now` for calculations)
 * - If ended: use updatedAt as the end time
 */
function getNodeEndedAt(status: string, updatedAt: string): string | null {
  return isNodeEnded(status) ? updatedAt : null;
}

/**
 * Calculate hours for a node within a period, clamped to period boundaries.
 */
function calculateNodeHoursInPeriod(
  createdAt: string,
  endedAt: string | null,
  periodStart: Date,
  periodEnd: Date,
  now: Date,
): number {
  const start = new Date(createdAt);
  const end = endedAt ? new Date(endedAt) : now;

  const effectiveStart = start < periodStart ? periodStart : start;
  const effectiveEnd = end > periodEnd ? periodEnd : end;

  const ms = effectiveEnd.getTime() - effectiveStart.getTime();
  return ms > 0 ? ms / (1000 * 60 * 60) : 0;
}

// =============================================================================
// Admin: All Users Node Usage Summary
// =============================================================================

/** Get all users' node usage summary for the current period. */
export async function getAllUsersNodeUsageSummary(
  db: DrizzleD1Database<typeof schema>,
): Promise<{ period: { start: string; end: string }; users: AdminUserNodeUsageSummary[] }> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  const now = new Date();

  // Get all nodes that overlap the current period:
  // created before period end AND (still alive OR ended after period start)
  const rows = await db
    .select({
      id: schema.nodes.id,
      userId: schema.nodes.userId,
      vmSize: schema.nodes.vmSize,
      cloudProvider: schema.nodes.cloudProvider,
      credentialSource: schema.nodes.credentialSource,
      status: schema.nodes.status,
      createdAt: schema.nodes.createdAt,
      updatedAt: schema.nodes.updatedAt,
    })
    .from(schema.nodes)
    .where(
      and(
        sql`${schema.nodes.createdAt} < ${end}`,
        or(
          notInArray(schema.nodes.status, [...ENDED_STATUSES_ARRAY]),
          sql`${schema.nodes.updatedAt} > ${start}`,
        ),
      ),
    );

  // Aggregate per user
  const userMap = new Map<
    string,
    { totalNodeHours: number; totalVcpuHours: number; platformNodeHours: number; activeNodes: number }
  >();

  for (const node of rows) {
    const endedAt = getNodeEndedAt(node.status, node.updatedAt);
    const hours = calculateNodeHoursInPeriod(node.createdAt, endedAt, periodStart, periodEnd, now);
    const vcpus = getVcpuCount(node.vmSize, node.cloudProvider);
    const isPlatform = node.credentialSource === 'platform';
    const isActive = !isNodeEnded(node.status);

    const existing = userMap.get(node.userId) ?? {
      totalNodeHours: 0,
      totalVcpuHours: 0,
      platformNodeHours: 0,
      activeNodes: 0,
    };
    existing.totalNodeHours += hours;
    existing.totalVcpuHours += hours * vcpus;
    if (isPlatform) existing.platformNodeHours += hours;
    if (isActive) existing.activeNodes += 1;
    userMap.set(node.userId, existing);
  }

  // Fetch user details
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
    .where(inArray(schema.users.id, userIds));

  const userLookup = new Map(users.map((u) => [u.id, u]));

  const summaries: AdminUserNodeUsageSummary[] = userIds
    .map((userId) => {
      const usage = userMap.get(userId)!;
      const user = userLookup.get(userId);
      return {
        userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        totalNodeHours: Math.round(usage.totalNodeHours * 100) / 100,
        totalVcpuHours: Math.round(usage.totalVcpuHours * 100) / 100,
        platformNodeHours: Math.round(usage.platformNodeHours * 100) / 100,
        activeNodes: usage.activeNodes,
      };
    })
    .sort((a, b) => b.totalNodeHours - a.totalNodeHours);

  return { period: { start, end }, users: summaries };
}

// =============================================================================
// Admin: Per-User Node Detail
// =============================================================================

/** Get detailed node usage for a specific user. */
export async function getUserNodeDetailedUsage(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
  recentLimit = 50,
): Promise<AdminUserNodeDetailedUsage> {
  const { start, end } = getCurrentPeriodBounds();
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  const now = new Date();

  // Get this user's nodes that overlap the current period
  const nodeRows = await db
    .select({
      id: schema.nodes.id,
      name: schema.nodes.name,
      vmSize: schema.nodes.vmSize,
      vmLocation: schema.nodes.vmLocation,
      cloudProvider: schema.nodes.cloudProvider,
      credentialSource: schema.nodes.credentialSource,
      status: schema.nodes.status,
      createdAt: schema.nodes.createdAt,
      updatedAt: schema.nodes.updatedAt,
    })
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.userId, userId),
        sql`${schema.nodes.createdAt} < ${end}`,
        or(
          notInArray(schema.nodes.status, [...ENDED_STATUSES_ARRAY]),
          sql`${schema.nodes.updatedAt} > ${start}`,
        ),
      ),
    )
    .orderBy(sql`${schema.nodes.createdAt} DESC`)
    .limit(recentLimit);

  // Count workspaces per node
  const nodeIds = nodeRows.map((n) => n.id);
  const workspaceCounts = new Map<string, number>();

  if (nodeIds.length > 0) {
    const wsRows = await db
      .select({
        nodeId: schema.workspaces.nodeId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.workspaces)
      .where(inArray(schema.workspaces.nodeId, nodeIds))
      .groupBy(schema.workspaces.nodeId);

    for (const row of wsRows) {
      if (row.nodeId) workspaceCounts.set(row.nodeId, row.count);
    }
  }

  // Build node records and calculate totals
  let totalNodeHours = 0;
  let totalVcpuHours = 0;
  let platformNodeHours = 0;
  let activeNodes = 0;

  const nodes: NodeUsageRecord[] = nodeRows.map((n) => {
    const endedAt = getNodeEndedAt(n.status, n.updatedAt);
    const hours = calculateNodeHoursInPeriod(n.createdAt, endedAt, periodStart, periodEnd, now);
    const vcpus = getVcpuCount(n.vmSize, n.cloudProvider);
    const isPlatform = n.credentialSource === 'platform';
    const isActive = !isNodeEnded(n.status);

    totalNodeHours += hours;
    totalVcpuHours += hours * vcpus;
    if (isPlatform) platformNodeHours += hours;
    if (isActive) activeNodes += 1;

    return {
      nodeId: n.id,
      name: n.name,
      vmSize: n.vmSize,
      vcpuCount: vcpus,
      vmLocation: n.vmLocation,
      cloudProvider: n.cloudProvider,
      credentialSource: (n.credentialSource ?? 'user') as CredentialSource,
      status: n.status,
      createdAt: n.createdAt,
      endedAt,
      workspaceCount: workspaceCounts.get(n.id) ?? 0,
    };
  });

  return {
    period: { start, end },
    totalNodeHours: Math.round(totalNodeHours * 100) / 100,
    totalVcpuHours: Math.round(totalVcpuHours * 100) / 100,
    platformNodeHours: Math.round(platformNodeHours * 100) / 100,
    activeNodes,
    nodes,
  };
}
